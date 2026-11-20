// @sqrrl/wiki-engine — self-maintenance strategies.
//
// Two maintenance paths, unified through the same governance gates:
//
// 1. Git-diff maintenance (T13, OpenWiki pattern): detects changed source
//    files via maintenanceHash (content hash), sends changed snippets + current
//    wiki page state to an LLM, which regenerates only the affected pages.
//    For code/doc sources tracked in git.
//
// 2. Dreamer-wiki promotion (T14): adapts memongo's 5-phase consolidation to
//    compile wiki_pages from events/episodes. Phases: novelty scan →
//    $vectorSearch similarity → injection classification → entity + claim
//    extraction → promote to wiki_pages. For event/streaming/conversation
//    sources.
//
// Both paths pass new/updated claims through injection + contradiction-before-
// dedup + trust-tier + permission gates (the same runWritePipelineGate).
//
// T13 + T14.

import { createHash } from "node:crypto"
import type { Document } from "mongodb"
import { type WikiScope, wikiPagesCollection } from "./wiki-schema.js"
import {
	createWikiPage,
	getWikiPage,
	updateWikiPage,
	type WikiDbHandle,
	type WikiPageInput,
} from "./wiki-bridge.js"
import { searchWikiPages, WikiSearchUnavailableError } from "./wiki-search.js"
import { omitUndefined } from "./omit-undefined.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type MaintenanceSource = "git-diff" | "dreamer"

export interface MaintenanceResult {
	source: MaintenanceSource
	pagesProcessed: number
	pagesRegenerated: number
	/** Pages this run created. */
	pagesCreated: number
	/** Pages this run updated in place. */
	pagesUpdated: number
	claimsAdded: number
	claimsRejected: number
	contradictionsDetected: number
	errors: string[]
}

export interface LlmGenerateFn {
	/** Called with the changed source snippet + current wiki page state.
	 *  Returns the regenerated page content (summary, body, claims). */
	(input: {
		sourceFile: string
		changedSnippet: string
		currentPage?: {
			title: string
			summary: string
			body: string
			claims: Array<{ text: string }>
		}
	}): Promise<{
		title?: string
		summary: string
		body: string
		claims: Array<{ text: string; confidence?: number }>
	}>
}

export type EmbedFn = (text: string) => Promise<number[]>

// ---------------------------------------------------------------------------
// Git-diff maintenance (T13)
// ---------------------------------------------------------------------------

/** Computes a content hash for a source file (used as maintenanceHash). */
export function computeMaintenanceHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

/** Represents a changed source file detected by git-diff. */
export interface ChangedSource {
	path: string
	content: string
	previousHash?: string
}

/** Detects which source files have changed since the last maintenance run.
 *  Compares current content hashes against the stored maintenanceHash on
 *  wiki pages (frontmatter.resource points to the source file). */
export async function detectChangedSources(
	handle: WikiDbHandle,
	currentSources: Array<{ path: string; content: string }>,
	scope: string,
	scopeRef: string,
): Promise<ChangedSource[]> {
	const coll = wikiPagesCollection(handle.db, handle.prefix)
	const changed: ChangedSource[] = []

	for (const source of currentSources) {
		const currentHash = computeMaintenanceHash(source.content)
		// Find the wiki page that tracks this source file (frontmatter.resource).
		const existing = (await coll.findOne({
			scope,
			scopeRef,
			"frontmatter.resource": source.path,
		})) as unknown as { frontmatter?: { maintenanceHash?: string } } | null

		const previousHash = existing?.frontmatter?.maintenanceHash
		if (!previousHash || previousHash !== currentHash) {
			changed.push({
				path: source.path,
				content: source.content,
				previousHash,
			})
		}
	}

	return changed
}

/** Runs git-diff maintenance: for each changed source, calls the LLM to
 *  regenerate the affected wiki page(s). New claims pass through the
 *  governance pipeline gate (contradiction-before-dedup). */
export async function runGitDiffMaintenance(
	handle: WikiDbHandle,
	changedSources: ChangedSource[],
	llmGenerate: LlmGenerateFn,
	opts: {
		scope: string
		scopeRef: string
		trustTier?: string
		agentId?: string
	},
): Promise<MaintenanceResult> {
	const result: MaintenanceResult = {
		source: "git-diff",
		pagesProcessed: 0,
		pagesRegenerated: 0,
		pagesCreated: 0,
		pagesUpdated: 0,
		claimsAdded: 0,
		claimsRejected: 0,
		contradictionsDetected: 0,
		errors: [],
	}

	// Sources are grouped by target slug and the groups run concurrently, while
	// each group stays serial. Two sources mapping to the same page must still
	// see one another's writes (the second regenerates on top of the first);
	// distinct pages share nothing, so their LLM calls can overlap. How many
	// actually overlap is bounded by the caller's LlmGenerateFn, not here.
	const groups = new Map<string, ChangedSource[]>()
	for (const source of changedSources) {
		const slug = sourceToSlug(source.path)
		const group = groups.get(slug)
		if (group) group.push(source)
		else groups.set(slug, [source])
	}

	// Collected per group and merged in input order afterwards, so the error
	// list does not reorder itself run to run.
	const groupErrors = new Map<string, string[]>()

	await Promise.all(
		[...groups].map(async ([slug, sources]) => {
			const errors: string[] = []
			groupErrors.set(slug, errors)
			for (const source of sources) {
				await processSource(source, slug, errors)
			}
		}),
	)
	for (const slug of groups.keys()) {
		result.errors.push(...(groupErrors.get(slug) ?? []))
	}

	return result

	async function processSource(
		source: ChangedSource,
		slug: string,
		errors: string[],
	): Promise<void> {
		try {
			result.pagesProcessed++
			const existing = await getWikiPage(
				handle,
				slug,
				opts.scope,
				opts.scopeRef,
			)

			// Call the LLM with the changed snippet + current page state.
			const generated = await llmGenerate({
				sourceFile: source.path,
				changedSnippet: source.content,
				currentPage: existing
					? {
							title: existing.title,
							summary: existing.summary,
							body: existing.body,
							claims: ((existing.claims ?? []) as Array<{ text: string }>).map(
								(c) => ({
									text: c.text,
								}),
							),
						}
					: undefined,
			})

			// Generate claim IDs. The pipeline gate (contradiction-before-dedup)
			// runs INSIDE createWikiPage/updateWikiPage — we don't gate manually
			// here (avoids double-gating + data loss).
			const newClaims = generated.claims.map((c, i) => ({
				id: `claim-git-${computeMaintenanceHash(source.path)}-${i}`,
				text: c.text,
				confidence: c.confidence,
			}))

			// Upsert the page with the regenerated content + new claims.
			const maintenanceHash = computeMaintenanceHash(source.content)
			if (existing) {
				// Pass only NEW claims — updateWikiPage preserves existing claims
				// and appends accepted new ones through the pipeline gate.
				await updateWikiPage(handle, slug, opts.scope, opts.scopeRef, {
					summary: generated.summary,
					body: generated.body,
					frontmatter: {
						...(existing.frontmatter as object),
						type: (existing.frontmatter as { type?: string })?.type ?? "source",
						resource: source.path,
						maintenanceHash,
					} as unknown as WikiPageInput["frontmatter"],
					claims: newClaims as unknown as Array<{ id: string; text: string }>,
				})
				result.claimsAdded += newClaims.length
			} else {
				// createWikiPage runs the pipeline gate internally for each claim.
				await createWikiPage(handle, {
					kind: "source",
					title: generated.title ?? source.path,
					slug,
					summary: generated.summary,
					body: generated.body,
					frontmatter: {
						type: "source",
						resource: source.path,
						maintenanceHash,
					},
					scope: opts.scope as WikiScope,
					scopeRef: opts.scopeRef,
					trustTier: (opts.trustTier ?? "standard") as
						| "restricted"
						| "standard"
						| "admin",
					sourceAgent: opts.agentId
						? { id: opts.agentId, name: opts.agentId }
						: undefined,
					claims: newClaims as unknown as Array<{
						id: string
						text: string
						confidence?: number
					}>,
				})
				result.claimsAdded += newClaims.length
			}

			// Update lastMaintainedAt + lastMaintenanceSource.
			await updateMaintenanceMetadata(
				handle,
				slug,
				opts.scope,
				opts.scopeRef,
				"git-diff",
			)
			result.pagesRegenerated++
			if (existing) result.pagesUpdated++
			else result.pagesCreated++
		} catch (err) {
			errors.push(
				`${source.path}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
}

// ---------------------------------------------------------------------------
// Dreamer-wiki promotion (T14)
// ---------------------------------------------------------------------------

/** Represents a new event/episode to be promoted to wiki_pages. */
export interface EventInput {
	id: string
	text: string
	embedding?: number[]
	timestamp?: Date
	agentId?: string
}

/** Runs the Dreamer 5-phase consolidation to promote events to wiki_pages.
 *
 *  Phase 1 — Novelty scan: filter events that are likely new (not processed).
 *  Phase 2 — Similarity: $vectorSearch each event against existing wiki pages.
 *  Phase 3 — Injection classification: determine if the event is new info,
 *            an update, or a contradiction.
 *  Phase 4 — Entity + claim extraction: extract claims from the event text.
 *  Phase 5 — Promotion: upsert claims to wiki_pages through the governance
 *            pipeline gate (contradiction-before-dedup).
 */
export async function runDreamerPromotion(
	handle: WikiDbHandle,
	events: EventInput[],
	opts: {
		scope: string
		scopeRef: string
		trustTier?: string
		agentId?: string
		/** @deprecated Has no effect. Phase 2 calls searchWikiPages, which
		 *  embeds the query itself, so a caller-supplied embedder is never
		 *  consulted. Kept only so existing callers still type-check. */
		embed?: EmbedFn
		/** Optional extractor. Without it a promoted event becomes a page
		 *  titled `Event <id>` whose single claim is the entire event text
		 *  verbatim — storage, not extraction. With it, the event is turned
		 *  into a real title, summary, body and discrete claims, the same way
		 *  runGitDiffMaintenance treats a changed source file. */
		llmGenerate?: LlmGenerateFn
	},
): Promise<MaintenanceResult> {
	const result: MaintenanceResult = {
		source: "dreamer",
		pagesProcessed: 0,
		pagesRegenerated: 0,
		pagesCreated: 0,
		pagesUpdated: 0,
		claimsAdded: 0,
		claimsRejected: 0,
		contradictionsDetected: 0,
		errors: [],
	}

	for (const event of events) {
		try {
			result.pagesProcessed++

			// Phase 1: Novelty — skip events with no text.
			if (!event.text || event.text.trim().length === 0) continue

			// Phase 2: Similarity — search for an existing wiki page that
			// semantically matches the event text. Uses recipe "fast"
			// (vector-only) so scores are cosine similarities in [0,1] and the
			// 0.65 minScore floor is a real similarity gate: results below the
			// floor are FILTERED OUT, so a non-empty result set here means a
			// genuinely similar page (no unconditional top-1 adoption of
			// unrelated pages). RRF-fused "hybrid" scores are orders of
			// magnitude smaller and would never clear 0.65. Falls back to
			// hash-based slug when search is unavailable or nothing clears.
			let slug = eventToSlug(event.id)
			let existing = null
			try {
				const searchResult = await searchWikiPages(handle, {
					query: event.text.slice(0, 500),
					scope: opts.scope,
					scopeRef: opts.scopeRef,
					maxResults: 1,
					minScore: 0.65,
					recipe: "fast",
				})
				if (searchResult.results.length > 0) {
					slug = searchResult.results[0].page.slug
					existing = await getWikiPage(handle, slug, opts.scope, opts.scopeRef)
				} else {
					// No semantic match above the floor — fall back to hash slug
					// lookup (backward compat)
					existing = await getWikiPage(handle, slug, opts.scope, opts.scopeRef)
				}
			} catch (err) {
				// Search unavailable (WikiSearchUnavailableError: no mongot /
				// index outage) — degrade to hash-slug consolidation instead of
				// skipping the event entirely.
				if (!(err instanceof WikiSearchUnavailableError)) throw err
				existing = await getWikiPage(handle, slug, opts.scope, opts.scopeRef)
			}

			// Phase 3: Injection classification. Contradiction handling lives in
			// the pipeline gate inside createWikiPage/updateWikiPage, so the
			// only decision left here is create vs update, which is reported
			// back to the caller.
			const injectionType = existing ? "update" : "new"

			// Phase 4: Claim extraction. Without an extractor the whole event
			// text becomes one claim verbatim; this is the historical
			// behaviour and stays the default so existing callers are
			// unaffected.
			const claimId = `claim-dreamer-${event.id}`
			let claimText = event.text
			let generated: Awaited<ReturnType<LlmGenerateFn>> | undefined
			if (opts.llmGenerate) {
				generated = await opts.llmGenerate({
					sourceFile: `events/${event.id}`,
					changedSnippet: event.text,
					currentPage: existing
						? {
								title: existing.title,
								summary: existing.summary,
								body: existing.body,
								claims: (
									(existing.claims ?? []) as Array<{ text: string }>
								).map((c) => ({ text: c.text })),
							}
						: undefined,
				})
				if (generated.claims.length > 0) {
					claimText = generated.claims[0].text
				}
			}

			// Phase 5: Promotion — the pipeline gate runs INSIDE
			// createWikiPage/updateWikiPage (avoids double-gating + duplication).
			// Pass only the NEW claim — the bridge preserves existing claims.
			// One claim per extracted statement when an extractor ran, else the
			// single verbatim claim.
			const newClaims =
				generated && generated.claims.length > 0
					? generated.claims.map((c, i) => ({
							id: `${claimId}-${i}`,
							text: c.text,
							confidence: c.confidence ?? 0.7,
						}))
					: [{ id: claimId, text: claimText, confidence: 0.7 }]

			// Upsert the page with the new claim.
			if (existing) {
				// Pass only the NEW claims — updateWikiPage preserves existing
				// claims and appends accepted new ones through the pipeline gate.
				await updateWikiPage(handle, slug, opts.scope, opts.scopeRef, {
					claims: newClaims as unknown as Array<{ id: string; text: string }>,
					...(generated
						? { summary: generated.summary, body: generated.body }
						: {}),
				})
			} else {
				// createWikiPage runs the pipeline gate internally.
				await createWikiPage(handle, {
					kind: "entity",
					title: generated?.title ?? `Event ${event.id}`,
					slug,
					summary: generated?.summary ?? event.text.slice(0, 100),
					body: generated?.body ?? "",
					frontmatter: { type: "entity" },
					scope: opts.scope as WikiScope,
					scopeRef: opts.scopeRef,
					trustTier: (opts.trustTier ?? "standard") as
						| "restricted"
						| "standard"
						| "admin",
					sourceAgent: event.agentId
						? { id: event.agentId, name: event.agentId }
						: undefined,
					claims: newClaims,
				})
			}

			await updateMaintenanceMetadata(
				handle,
				slug,
				opts.scope,
				opts.scopeRef,
				"dreamer",
			)
			result.claimsAdded += newClaims.length
			result.pagesRegenerated++
			if (injectionType === "new") result.pagesCreated++
			else result.pagesUpdated++
		} catch (err) {
			result.errors.push(
				`event ${event.id}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The wiki slug git-diff maintenance assigns to a source path. Exported so
 *  connectors that address those pages afterwards can pin their own copy to it. */
export function sourceToSlug(sourcePath: string): string {
	const clean = sourcePath
		.toLowerCase()
		.replace(/[^a-z0-9/.]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return `sources/${clean}`
}

function eventToSlug(eventId: string): string {
	const clean = eventId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return `events/${clean}`
}

/** Updates the lastMaintainedAt + lastMaintenanceSource fields on a page. */
async function updateMaintenanceMetadata(
	handle: WikiDbHandle,
	slug: string,
	scope: string,
	scopeRef: string,
	source: MaintenanceSource,
): Promise<void> {
	const coll = wikiPagesCollection(handle.db, handle.prefix)
	await coll.updateOne(
		{ slug, scope, scopeRef },
		{
			$set: omitUndefined({
				lastMaintainedAt: new Date(),
				lastMaintenanceSource: source,
				freshness: "fresh",
			}) as Document,
		},
	)
}
