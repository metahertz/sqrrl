import { randomUUID } from "node:crypto"
import { Hono, type Context } from "hono"
import type { ApiEnvironment } from "../api-context.js"
import { getApiPrincipal, isMasterKeyRequest } from "../api-context.js"
import {
	createApiKey,
	listApiKeys,
	revokeApiKey,
	updateApiKey,
	createWikiPage,
	getWikiPage,
	listWikiPages,
	updateWikiPage,
	deleteWikiPage,
	restoreWikiPage,
	renderMarkdown,
	renderHtml,
	importOkfBundle,
	exportOkfBundle,
	searchWikiPages,
	WikiSearchUnavailableError,
	listUnresolvedContradictions,
	listWikiPageRevisions,
	getWikiPageRevision,
	resolveTransclusions,
	recordWikiMutationIntent,
	addRelationships,
	mergePages,
	purgeWikiPage,
	reassignTask,
	removeRelationships,
	runDreamerPromotion,
	type ChangedSource,
	type EventInput,
	WikiDuplicateSlugError,
	WikiRevisionConflictError,
	WIKI_SCOPE_VALUES,
	type WikiScope,
	type WikiPageEditor,
	type WikiPageInput,
} from "@sqrrl/wiki-engine"
import { distillChangedSources, redactSecrets } from "@sqrrl/source-layer"
import { jsonError } from "../lib/errors.js"
import { buildWikiGovContext } from "./wiki-context.js"
import { invalidateApiKeyCache } from "../db-api-keys.js"
import { ALL_PRINCIPAL_CAPABILITIES } from "../principal.js"
import {
	createLlmGenerate,
	createTaskExtractor,
	LlmCallError,
	LlmNotConfiguredError,
} from "../lib/llm-generate.js"
import {
	getWikiStoreHandle,
	withWikiTransaction,
} from "../wiki-store-runtime.js"

const MAX_LIST_LIMIT = 100
// Exported for the contract parity test (apps/api/src/contract-parity.test.ts):
// the runtime validation sets are the source of truth the OpenAPI document and
// the MCP schemas must not drift below.
export const WIKI_VALID_KINDS = [
	"entity",
	"concept",
	"synthesis",
	"source",
	"report",
	"procedure",
]
export const WIKI_VALID_TRUST_TIERS = ["restricted", "standard", "admin"]
export const WIKI_VALID_SCOPES: string[] = [...WIKI_SCOPE_VALUES]
// Slugs whose first path segment collides with a wiki sub-route registered
// before the /wiki/* wildcard (lint, revisions) would be unreachable via GET
// (the sub-route answers instead of the page). Create/patch reject them
// instead of letting a page silently shadow itself (REV-07 N2).
export const WIKI_RESERVED_SLUG_SEGMENTS = [
	"lint",
	"revisions",
	"task-suggestions",
	"task-review",
	"status",
	"identity",
	"decisions",
]
function parseListLimit(raw?: string): number | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed)) {
		return null
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(parsed)))
}

/** $graphLookup maxDepth: 0 follows direct links only, 2 reaches three hops.
 *  The engine caps expansion at 20 pages whatever the depth. */
const WIKI_GRAPH_MAX_DEPTH = 2

/** Wiki search graphExpansion: true, or { maxDepth }. Absent or false means
 *  off. The engine's crossScope option is not accepted here: search ignores
 *  it, and expanded pages are always filtered to the requested scope. */
function parseGraphExpansion(
	raw: unknown,
): { maxDepth?: number } | undefined | "invalid" {
	if (raw === undefined || raw === null || raw === false) return undefined
	if (raw === true) return {}
	if (typeof raw !== "object" || Array.isArray(raw)) return "invalid"
	const { maxDepth } = raw as { maxDepth?: unknown }
	if (maxDepth === undefined) return {}
	if (
		typeof maxDepth !== "number" ||
		!Number.isInteger(maxDepth) ||
		maxDepth < 0 ||
		maxDepth > WIKI_GRAPH_MAX_DEPTH
	)
		return "invalid"
	return { maxDepth }
}

export function createV1Router(): Hono<ApiEnvironment> {
	const v1 = new Hono<ApiEnvironment>()

	// ---------------------------------------------------------------------------
	// Wiki routes (/v1/wiki/*) — T3
	// ---------------------------------------------------------------------------

	async function readWikiDbHandle(_agentId?: string) {
		return getWikiStoreHandle()
	}

	// Slug may contain slashes (OKF concept IDs are file paths like
	// "tables/users"), so routes use /wiki/* and parse the slug from the path.
	// Robust against slugs containing the literal "/wiki/" substring and
	// against a trailing slash.
	function readWikiSlug(c: { req: { path: string } }): string {
		const afterWiki = c.req.path.split("/wiki/").slice(1).join("/wiki/")
		return (afterWiki ?? "").replace(/\/$/, "")
	}

	// REV-07 N2: a slug whose first segment collides with a GET sub-route
	// registered before the /wiki/* wildcard (lint, revisions) is unreachable
	// as a page. Reject it at write time with a named reason.
	function reservedSlugError(slug: string): string | undefined {
		const firstSegment = slug.split("/")[0]
		return WIKI_RESERVED_SLUG_SEGMENTS.includes(firstSegment)
			? `slug segment "${firstSegment}" is reserved (shadows the /v1/wiki/${firstSegment} route); choose a different slug`
			: undefined
	}

	function readWikiOperationId(
		c: Parameters<typeof getApiPrincipal>[0],
	): string {
		return (
			c.req.header("Idempotency-Key")?.trim() ||
			c.req.header("X-Request-ID")?.trim() ||
			randomUUID()
		)
	}

	function canChangeWikiPermissions(
		c: Parameters<typeof getApiPrincipal>[0],
	): boolean {
		return getApiPrincipal(c).capabilities.includes("change-permissions")
	}

	// The editor recorded on wiki revision snapshots: the ACTUAL calling
	// principal, not the payload-supplied sourceAgent (which a caller could
	// set to any string). Falls back to the subjectId when the credential
	// configures no displayName.
	function principalEditor(
		c: Parameters<typeof getApiPrincipal>[0],
	): WikiPageEditor {
		const principal = getApiPrincipal(c)
		return {
			id: principal.subjectId,
			name: principal.displayName?.trim() || principal.subjectId,
		}
	}

	v1.post("/wiki", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const kind = String(body.kind ?? "")
		const title = String(body.title ?? "")
		const slug = String(body.slug ?? "")
		const summary = String(body.summary ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		const trustTier = String(body.trustTier ?? "")
		const frontmatter = (body.frontmatter ?? {}) as Record<string, unknown>
		if (!title.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "title is required")
		if (!slug.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		const reservedSlug = reservedSlugError(slug)
		if (reservedSlug) return jsonError(c, 400, "VALIDATION_ERROR", reservedSlug)
		if (!summary.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "summary is required")
		// The stored schema lists body in its required set and the bridge
		// forwards it verbatim, so omitting it fails document validation deep
		// in the driver and surfaces as a 500. Reject it here like its
		// siblings, so callers get a 400 that names the field.
		if (typeof body.body !== "string")
			return jsonError(c, 400, "VALIDATION_ERROR", "body is required")
		if (!WIKI_VALID_KINDS.includes(kind))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`kind must be one of ${WIKI_VALID_KINDS.join("|")}`,
			)
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		if (!WIKI_VALID_TRUST_TIERS.includes(trustTier))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`trustTier must be one of ${WIKI_VALID_TRUST_TIERS.join("|")}`,
			)
		if (
			!frontmatter ||
			typeof frontmatter !== "object" ||
			!String(frontmatter.type ?? "").trim()
		)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"frontmatter.type is required (OKF)",
			)
		try {
			const principal = getApiPrincipal(c)
			const permissions =
				body.permissions &&
				typeof body.permissions === "object" &&
				!Array.isArray(body.permissions)
					? (body.permissions as Record<string, unknown>)
					: {}
			if (
				(trustTier !== principal.trustTier ||
					Object.keys(permissions).length > 0) &&
				!canChangeWikiPermissions(c)
			) {
				return jsonError(
					c,
					403,
					"FORBIDDEN",
					"change-permissions capability is required",
				)
			}
			const input = body as unknown as WikiPageInput
			const page = await withWikiTransaction(async (handle, session) => {
				const created = await createWikiPage(handle, input, {
					session,
					editor: principalEditor(c),
				})
				await recordWikiMutationIntent(
					handle,
					{
						operationId: readWikiOperationId(c),
						kind: "create",
						pageSlug: slug,
						scope,
						scopeRef,
						principalSubjectId: principal.subjectId,
						payload: body,
					},
					session,
				)
				return created
			})
			return c.json(page, 201)
		} catch (err) {
			if (err instanceof WikiDuplicateSlugError) {
				return jsonError(c, 409, "DUPLICATE_SLUG", err.message)
			}
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_CREATE_FAILED", message)
		}
	})

	v1.get("/wiki", async (c) => {
		const scope = c.req.query("scope")
		const scopeRef = c.req.query("scopeRef")
		const kind = c.req.query("kind")
		const taskStatus = c.req.query("taskStatus")
		const trustTier = c.req.query("trustTier")
		const state = c.req.query("state")
		const limit = c.req.query("limit")
			? Number(c.req.query("limit"))
			: undefined
		const skip = c.req.query("skip") ? Number(c.req.query("skip")) : undefined
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef query params are required",
			)
		try {
			const handle = await readWikiDbHandle(
				String(c.req.query("agentId") ?? ""),
			)
			const result = await listWikiPages(handle, {
				kind: kind ?? undefined,
				taskStatus: taskStatus ?? undefined,
				scope: scope ?? undefined,
				scopeRef: scopeRef ?? undefined,
				trustTier: trustTier ?? undefined,
				state: state ?? undefined,
				limit: Number.isFinite(limit) ? limit : undefined,
				skip: Number.isFinite(skip) ? skip : undefined,
				governance: buildWikiGovContext(c, scope, scopeRef),
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_LIST_FAILED", message)
		}
	})

	// Wiki relationship editing (/v1/wiki/relationships).
	// A patch replaces the whole relationships array, so re-routing one edge
	// meant a read-modify-write with a race in it. remove runs before add, so
	// a single call can move an edge from one target to another.
	v1.post("/wiki/relationships", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const slug = String(body.slug ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (!slug.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		const add = Array.isArray(body.add) ? body.add : []
		const remove = Array.isArray(body.remove) ? body.remove : []
		if (add.length === 0 && remove.length === 0)
			return jsonError(c, 400, "VALIDATION_ERROR", "add or remove is required")
		try {
			const handle = await getWikiStoreHandle()
			const removed = await removeRelationships(
				handle,
				slug,
				scope,
				scopeRef,
				remove as Array<{ targetPageSlug: string; kind?: string }>,
			)
			const added = await addRelationships(
				handle,
				slug,
				scope,
				scopeRef,
				add as Array<{
					targetPageSlug: string
					targetTitle: string
					kind: string
				}>,
			)
			const page = await getWikiPage(handle, slug, scope, scopeRef)
			if (!page)
				return jsonError(
					c,
					404,
					"WIKI_NOT_FOUND",
					`wiki page "${slug}" not found`,
				)
			return c.json({ removed, added, page })
		} catch (err) {
			return jsonError(
				c,
				500,
				"WIKI_RELATIONSHIPS_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	})

	// Wiki merge (/v1/wiki/merge) — folds one page into another.
	// The loser is superseded rather than deleted so the audit trail survives,
	// and supersededBy records where its content went.
	v1.post("/wiki/merge", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const from = String(body.from ?? "")
		const into = String(body.into ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (!from.trim() || !into.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "from and into are required")
		if (from === into)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"cannot merge a page into itself",
			)
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		try {
			const handle = await getWikiStoreHandle()
			const result = await mergePages(handle, {
				from,
				into,
				scope,
				scopeRef,
				editor: principalEditor(c),
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const missing = message.startsWith("no wiki page")
			return jsonError(
				c,
				missing ? 404 : 500,
				missing ? "WIKI_NOT_FOUND" : "WIKI_MERGE_FAILED",
				message,
			)
		}
	})

	// Task reassignment (/v1/wiki/tasks/reassign).
	// Editing taskCard.owner alone leaves the owned_by edge on the old person,
	// so the card and the graph disagree. This moves both together.
	v1.post("/wiki/tasks/reassign", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const slug = String(body.slug ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (!slug.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		const owner = body.owner as { name?: string; hubSlug?: string } | undefined
		const sourceSlug = body.sourceSlug ? String(body.sourceSlug) : undefined
		if (!owner && !sourceSlug)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"owner or sourceSlug is required",
			)
		if (owner && (!owner.name?.trim() || !owner.hubSlug?.trim()))
			// The hub slug is required rather than derived: minting person pages
			// is ingestion's job, and guessing here would create a second page
			// for someone who already has one.
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"owner requires both name and hubSlug",
			)
		try {
			const handle = await getWikiStoreHandle()
			const result = await reassignTask(handle, slug, {
				scope,
				scopeRef,
				...(owner
					? {
							owner: {
								name: owner.name as string,
								hubSlug: owner.hubSlug as string,
							},
						}
					: {}),
				...(sourceSlug ? { sourceSlug } : {}),
				...(body.sourceTitle ? { sourceTitle: String(body.sourceTitle) } : {}),
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const missing = message.startsWith("no wiki page")
			return jsonError(
				c,
				missing ? 404 : 500,
				missing ? "WIKI_NOT_FOUND" : "WIKI_REASSIGN_FAILED",
				message,
			)
		}
	})

	// Wiki purge (/v1/wiki/purge) — permanently removes content.
	//
	// Neither existing delete does this. A plain delete supersedes and keeps
	// everything; ?hard=true removes the page but writes the whole document
	// into a revision snapshot on the way out, which is a deliberate audit
	// trail and precisely wrong for material that should never have been
	// stored. Purge deletes the revisions too, and cascades by default to the
	// tasks derived from the page, whose bodies are verbatim quotes from it.
	//
	// Requires the hard-delete capability and cannot be undone.
	v1.post("/wiki/purge", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const slug = String(body.slug ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (!slug.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		// Opt out explicitly; the safe default for a purge is to take the
		// quoted copies with it.
		const cascadeTasks = body.cascadeTasks !== false
		try {
			const handle = await getWikiStoreHandle()
			const result = await purgeWikiPage(handle, {
				slug,
				scope,
				scopeRef,
				cascadeTasks,
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const missing = message.startsWith("no wiki page")
			return jsonError(
				c,
				missing ? 404 : 500,
				missing ? "WIKI_NOT_FOUND" : "WIKI_PURGE_FAILED",
				message,
			)
		}
	})

	// Wiki restore (/v1/wiki/restore) — undoes a soft delete.
	// A soft delete supersedes the page and keeps it for audit, but nothing
	// set state back, so the slug became permanently unusable: it stays out of
	// default listings and a patch setting state is silently ignored.
	v1.post("/wiki/restore", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const slug = String(body.slug ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (!slug.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		try {
			const restored = await withWikiTransaction(async (handle, session) =>
				restoreWikiPage(handle, slug, scope, scopeRef, {
					session,
					editor: principalEditor(c),
				}),
			)
			if (!restored)
				return jsonError(
					c,
					404,
					"WIKI_NOT_FOUND",
					`no superseded wiki page "${slug}" in scope ${scope}:${scopeRef}`,
				)
			const page = await getWikiPage(
				await getWikiStoreHandle(),
				slug,
				scope,
				scopeRef,
			)
			return c.json(page)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_RESTORE_FAILED", message)
		}
	})

	// Wiki lint (/v1/wiki/lint) — T12: lists pages + unresolved contradictions.
	// REV-07 placebo-parameter fix: kind and limit are honored (clamped to
	// 1..MAX_LIST_LIMIT), not silently dropped — the SDK and MCP surfaces
	// advertise both, so the route must consume both.
	v1.get("/wiki/lint", async (c) => {
		const scope = c.req.query("scope")
		const scopeRef = c.req.query("scopeRef")
		const kind = c.req.query("kind")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		const limit = parseListLimit(c.req.query("limit"))
		if (limit === null) {
			return jsonError(c, 400, "VALIDATION_ERROR", "limit must be 1..100")
		}
		try {
			const handle = await readWikiDbHandle(
				String(c.req.query("agentId") ?? ""),
			)
			const governance = buildWikiGovContext(c, scope, scopeRef)
			const [pagesResult, contradictions] = await Promise.all([
				listWikiPages(handle, {
					scope,
					scopeRef,
					kind: kind ?? undefined,
					limit: limit ?? MAX_LIST_LIMIT,
					governance,
				}),
				listUnresolvedContradictions(handle, scope, scopeRef, governance),
			])
			return c.json({
				pages: pagesResult.pages,
				total: pagesResult.total,
				unresolvedContradictions: contradictions,
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_LINT_FAILED", message)
		}
	})

	// Wiki maintenance (/v1/wiki/maintenance) — LOCAL ADDITION, not upstream.
	// wiki-engine ships runGitDiffMaintenance and runDreamerPromotion as
	// library functions with no HTTP or MCP surface, so consolidation was
	// unreachable over the API. This exposes both.
	//
	//   { "source": "dreamer",  "scope", "scopeRef",
	//     "events": [{ "id", "text", "timestamp"? , "agentId"? }] }
	//   { "source": "git-diff", "scope", "scopeRef",
	//     "changedSources": [{ "path", "content", "previousHash"? }] }
	//
	// git-diff needs an LLM (SQRRL_ENRICHMENT_*); dreamer does not.
	v1.post("/wiki/maintenance", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const source = String(body.source ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (source !== "git-diff" && source !== "dreamer")
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"source must be one of git-diff|dreamer",
			)
		if (!WIKI_VALID_SCOPES.includes(scope))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`scope must be one of ${WIKI_VALID_SCOPES.join("|")}`,
			)
		if (!scopeRef.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "scopeRef is required")
		const trustTier = body.trustTier ? String(body.trustTier) : undefined
		if (trustTier && !WIKI_VALID_TRUST_TIERS.includes(trustTier))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`trustTier must be one of ${WIKI_VALID_TRUST_TIERS.join("|")}`,
			)
		const agentId = body.agentId ? String(body.agentId) : undefined
		const extractTasks = body.extractTasks === true
		const noteDate = body.noteDate ? String(body.noteDate) : undefined
		const opts = {
			scope,
			scopeRef,
			...(trustTier ? { trustTier } : {}),
			...(agentId ? { agentId } : {}),
		}

		try {
			const handle = await getWikiStoreHandle()

			if (source === "dreamer") {
				const raw = Array.isArray(body.events) ? body.events : null
				if (!raw || raw.length === 0)
					return jsonError(
						c,
						400,
						"VALIDATION_ERROR",
						"events must be a non-empty array for source=dreamer",
					)
				const events: EventInput[] = []
				for (const item of raw) {
					if (!item || typeof item !== "object")
						return jsonError(
							c,
							400,
							"VALIDATION_ERROR",
							"each event must be an object",
						)
					const e = item as Record<string, unknown>
					const id = String(e.id ?? "").trim()
					const text = redactSecrets(String(e.text ?? "")).text
					if (!id)
						return jsonError(c, 400, "VALIDATION_ERROR", "event.id is required")
					if (!text.trim())
						return jsonError(
							c,
							400,
							"VALIDATION_ERROR",
							`event "${id}" has no text`,
						)
					const ts = e.timestamp ? new Date(String(e.timestamp)) : undefined
					if (ts && Number.isNaN(ts.getTime()))
						return jsonError(
							c,
							400,
							"VALIDATION_ERROR",
							`event "${id}" has an invalid timestamp`,
						)
					events.push({
						id,
						text,
						...(Array.isArray(e.embedding)
							? { embedding: e.embedding as number[] }
							: {}),
						...(ts ? { timestamp: ts } : {}),
						...(e.agentId ? { agentId: String(e.agentId) } : {}),
					})
				}
				const result = await runDreamerPromotion(handle, events, opts)
				return c.json(result)
			}

			// source === "git-diff"
			const raw = Array.isArray(body.changedSources)
				? body.changedSources
				: null
			if (!raw || raw.length === 0)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"changedSources must be a non-empty array for source=git-diff",
				)
			const changed: ChangedSource[] = []
			for (const item of raw) {
				if (!item || typeof item !== "object")
					return jsonError(
						c,
						400,
						"VALIDATION_ERROR",
						"each changedSource must be an object",
					)
				const src = item as Record<string, unknown>
				const path = String(src.path ?? "").trim()
				if (!path)
					return jsonError(
						c,
						400,
						"VALIDATION_ERROR",
						"changedSource.path is required",
					)
				changed.push({
					path,
					content: String(src.content ?? ""),
					...(src.previousHash
						? { previousHash: String(src.previousHash) }
						: {}),
				})
			}
			let llmGenerate: ReturnType<typeof createLlmGenerate>
			try {
				llmGenerate = createLlmGenerate()
			} catch (err) {
				if (err instanceof LlmNotConfiguredError)
					return jsonError(c, 400, "LLM_NOT_CONFIGURED", err.message)
				throw err
			}
			const result = await distillChangedSources(
				handle,
				changed,
				{ llmGenerate, createExtractor: createTaskExtractor },
				{
					...opts,
					extractTasks,
					noteDate,
					parallelExtraction:
						process.env.SQRRL_ENRICHMENT_PARALLEL_EXTRACTION?.trim() === "1",
				},
			)
			return c.json(result)
		} catch (err) {
			if (err instanceof LlmNotConfiguredError)
				return jsonError(c, 400, "LLM_NOT_CONFIGURED", err.message)
			if (err instanceof LlmCallError)
				return jsonError(c, 502, "LLM_CALL_FAILED", err.message)
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_MAINTENANCE_FAILED", message)
		}
	})

	// Wiki revision history (/v1/wiki/revisions, /v1/wiki/revisions/:revision).
	// Each revision is authorized against its OWN snapshot metadata — the
	// permissions/trustTier the page had at that revision. Revision history
	// is never a side channel around governance (a caller who couldn't see a
	// revision when it was written can't read it now), and later restricting
	// or hard-deleting a page never hides the history from readers who could
	// see it: authorization is per revision, not per current page state.
	v1.get("/wiki/revisions", async (c) => {
		const slug = c.req.query("slug")
		const scope = c.req.query("scope")
		const scopeRef = c.req.query("scopeRef")
		const limit = Number(c.req.query("limit") ?? "50")
		if (!slug) return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		try {
			const handle = await readWikiDbHandle(
				String(c.req.query("agentId") ?? ""),
			)
			const governance = buildWikiGovContext(c, scope, scopeRef)
			const revisions = await listWikiPageRevisions(handle, {
				pageSlug: slug,
				scope,
				scopeRef,
				limit: Number.isFinite(limit) ? limit : undefined,
				governance,
			})
			return c.json({ revisions })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_REVISIONS_FAILED", message)
		}
	})

	v1.get("/wiki/revisions/:revision", async (c) => {
		const slug = c.req.query("slug")
		const scope = c.req.query("scope")
		const scopeRef = c.req.query("scopeRef")
		const revision = Number(c.req.param("revision"))
		if (!slug) return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		if (!Number.isFinite(revision) || revision < 1)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"revision must be a positive integer",
			)
		try {
			const handle = await readWikiDbHandle(
				String(c.req.query("agentId") ?? ""),
			)
			const governance = buildWikiGovContext(c, scope, scopeRef)
			const record = await getWikiPageRevision(handle, {
				pageSlug: slug,
				scope,
				scopeRef,
				revision,
				governance,
			})
			if (!record)
				return jsonError(
					c,
					404,
					"WIKI_REVISION_NOT_FOUND",
					`revision ${revision} of "${slug}" not found`,
				)
			return c.json(record)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_REVISIONS_FAILED", message)
		}
	})

	v1.get("/wiki/*", async (c) => {
		const slug = readWikiSlug(c)
		const scope = String(c.req.query("scope") ?? "")
		const scopeRef = String(c.req.query("scopeRef") ?? "")
		const format = c.req.query("format")
		const transclude = c.req.query("transclude") === "true"
		if (!slug) return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef query params are required",
			)
		try {
			const handle = await readWikiDbHandle(
				String(c.req.query("agentId") ?? ""),
			)
			const governance = buildWikiGovContext(c, scope, scopeRef)
			const page = await getWikiPage(handle, slug, scope, scopeRef, governance)
			if (!page)
				return jsonError(
					c,
					404,
					"WIKI_NOT_FOUND",
					`wiki page "${slug}" not found in scope ${scope}:${scopeRef}`,
				)
			// Transclusion resolution is opt-in: the stored body keeps its raw
			// {{page:slug}} markers by default (what an editor should see/edit),
			// resolved only when the caller explicitly asks for it. Resolved
			// through the SAME governance context as the page itself, so a
			// marker referencing a page the caller can't read never leaks
			// content — see wiki-transclusion.ts.
			const resolvedPage = transclude
				? {
						...page,
						body: await resolveTransclusions(handle, page.body, governance),
					}
				: page
			if (format === "html") {
				return c.html(renderHtml(resolvedPage))
			}
			if (format === "markdown") {
				return c.text(renderMarkdown(resolvedPage), 200, {
					"Content-Type": "text/markdown; charset=utf-8",
				})
			}
			return c.json(resolvedPage)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_GET_FAILED", message)
		}
	})

	v1.patch("/wiki/*", async (c) => {
		const slug = readWikiSlug(c)
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scope = String(body.scope ?? c.req.query("scope") ?? "")
		const scopeRef = String(body.scopeRef ?? c.req.query("scopeRef") ?? "")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		if (
			body.frontmatter !== undefined &&
			(!body.frontmatter ||
				typeof body.frontmatter !== "object" ||
				Array.isArray(body.frontmatter) ||
				typeof (body.frontmatter as Record<string, unknown>).type !== "string")
		) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"frontmatter.type is required",
			)
		}
		try {
			const {
				scope: _s,
				scopeRef: _sr,
				slug: _sl,
				expectedRevision: _er,
				...patch
			} = body as Record<string, unknown>
			void _s
			void _sr
			void _sl
			void _er
			// REV-07 C24: optional compare-and-swap precondition. When supplied,
			// the patch applies only if the page is still at the caller's
			// observed revision; otherwise 409 REVISION_CONFLICT (never a blind
			// last-writer-wins overwrite). The client's create-or-update fallback
			// always sends it.
			const expectedRevision =
				typeof body.expectedRevision === "number"
					? body.expectedRevision
					: undefined
			const principal = getApiPrincipal(c)
			if (
				(patch.trustTier !== undefined || patch.permissions !== undefined) &&
				!canChangeWikiPermissions(c)
			) {
				return jsonError(
					c,
					403,
					"FORBIDDEN",
					"change-permissions capability is required",
				)
			}
			const updated = await withWikiTransaction(async (handle, session) => {
				const target = await getWikiPage(
					handle,
					slug,
					scope,
					scopeRef,
					buildWikiGovContext(c, scope, scopeRef),
					session,
				)
				if (!target) return undefined
				if (
					expectedRevision !== undefined &&
					Number(target.revision ?? 1) !== expectedRevision
				) {
					throw new WikiRevisionConflictError(
						slug,
						scope,
						scopeRef,
						expectedRevision,
					)
				}
				const result = await updateWikiPage(
					handle,
					slug,
					scope,
					scopeRef,
					patch as Partial<WikiPageInput>,
					{ session, editor: principalEditor(c) },
				)
				if (!result) return undefined
				await recordWikiMutationIntent(
					handle,
					{
						operationId: readWikiOperationId(c),
						kind: "update",
						pageSlug: slug,
						scope,
						scopeRef,
						principalSubjectId: principal.subjectId,
						payload: patch,
					},
					session,
				)
				return result
			})
			if (!updated)
				return jsonError(
					c,
					404,
					"WIKI_NOT_FOUND",
					`wiki page "${slug}" not found in scope ${scope}:${scopeRef}`,
				)
			return c.json(updated)
		} catch (err) {
			if (err instanceof WikiRevisionConflictError) {
				return jsonError(c, 409, "REVISION_CONFLICT", err.message)
			}
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_UPDATE_FAILED", message)
		}
	})

	v1.delete("/wiki/*", async (c) => {
		const slug = readWikiSlug(c)
		const scope = String(c.req.query("scope") ?? "")
		const scopeRef = String(c.req.query("scopeRef") ?? "")
		const hard = c.req.query("hard") === "true"
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef query params are required",
			)
		try {
			const principal = getApiPrincipal(c)
			const deleted = await withWikiTransaction(async (handle, session) => {
				const target = await getWikiPage(
					handle,
					slug,
					scope,
					scopeRef,
					buildWikiGovContext(c, scope, scopeRef),
					session,
				)
				if (!target) return false
				const result = await deleteWikiPage(handle, slug, scope, scopeRef, {
					hard,
					session,
					editor: principalEditor(c),
				})
				if (!result) return false
				await recordWikiMutationIntent(
					handle,
					{
						operationId: readWikiOperationId(c),
						kind: hard ? "hard-delete" : "soft-delete",
						pageSlug: slug,
						scope,
						scopeRef,
						principalSubjectId: principal.subjectId,
						payload: { hard },
					},
					session,
				)
				return true
			})
			if (!deleted)
				return jsonError(
					c,
					404,
					"WIKI_NOT_FOUND",
					`wiki page "${slug}" not found in scope ${scope}:${scopeRef}`,
				)
			return c.json({ ok: true, slug, scope, scopeRef, hard })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_DELETE_FAILED", message)
		}
	})

	// OKF interchange routes (/v1/wiki/okf-import, /v1/wiki/okf-export)
	v1.post("/wiki/okf-import", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const bundleDir = String(body.bundleDir ?? "")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		const trustTier = String(body.trustTier ?? "")
		const okfBundleId = String(body.okfBundleId ?? "")
		if (!bundleDir.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "bundleDir is required")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		if (!okfBundleId.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "okfBundleId is required")
		if (!["restricted", "standard", "admin"].includes(trustTier))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"trustTier must be restricted|standard|admin",
			)
		try {
			const principal = getApiPrincipal(c)
			if (!canChangeWikiPermissions(c)) {
				return jsonError(
					c,
					403,
					"FORBIDDEN",
					"change-permissions capability is required",
				)
			}
			const result = await withWikiTransaction(async (handle, session) => {
				const imported = await importOkfBundle(handle, bundleDir, {
					scope: scope as WikiScope,
					scopeRef,
					trustTier: trustTier as "restricted" | "standard" | "admin",
					okfBundleId,
					session,
				})
				await recordWikiMutationIntent(
					handle,
					{
						operationId: readWikiOperationId(c),
						kind: "okf-import",
						pageSlug: okfBundleId,
						scope,
						scopeRef,
						principalSubjectId: principal.subjectId,
						payload: {
							bundleDir,
							trustTier,
							okfBundleId,
							conceptIds: imported.conceptIds,
						},
					},
					session,
				)
				return imported
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "OKF_IMPORT_FAILED", message)
		}
	})

	v1.post("/wiki/okf-export", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		const outDir = String(body.outDir ?? "")
		const okfBundleId = body.okfBundleId ? String(body.okfBundleId) : undefined
		const trustTier = body.trustTier ? String(body.trustTier) : undefined
		const returnContent = body.returnContent === true
		if (trustTier && !WIKI_VALID_TRUST_TIERS.includes(trustTier))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"trustTier must be restricted|standard|admin",
			)
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		if (!outDir.trim())
			return jsonError(c, 400, "VALIDATION_ERROR", "outDir is required")
		try {
			const handle = await readWikiDbHandle(String(body.agentId ?? ""))
			const result = await exportOkfBundle(handle, {
				scope,
				scopeRef,
				okfBundleId,
				outDir,
				// Export must never surface a page the requester couldn't otherwise
				// read via a governed GET — filtered exactly like /wiki (list).
				governance: buildWikiGovContext(c, scope, scopeRef),
				returnContent,
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "OKF_EXPORT_FAILED", message)
		}
	})

	// Wiki search (/v1/wiki/search) — T5
	v1.post("/wiki/search", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const query = String(body.query ?? "").trim()
		if (!query)
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		const scope = String(body.scope ?? "")
		const scopeRef = String(body.scopeRef ?? "")
		if (!scope || !scopeRef)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"scope and scopeRef are required",
			)
		const graphExpansion = parseGraphExpansion(body.graphExpansion)
		if (graphExpansion === "invalid")
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`graphExpansion must be a boolean or { maxDepth: 0..${WIKI_GRAPH_MAX_DEPTH} }`,
			)
		try {
			const handle = await readWikiDbHandle(String(body.agentId ?? ""))
			const result = await searchWikiPages(handle, {
				query,
				scope,
				scopeRef,
				kind: body.kind ? String(body.kind) : undefined,
				trustTier: body.trustTier ? String(body.trustTier) : undefined,
				state: body.state ? String(body.state) : undefined,
				privacyTier: body.privacyTier ? String(body.privacyTier) : undefined,
				recipe:
					body.recipe === "fast" ||
					body.recipe === "hybrid" ||
					body.recipe === "deep"
						? body.recipe
						: undefined,
				maxResults:
					typeof body.maxResults === "number" ? body.maxResults : undefined,
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				graphExpansion,
				governance: buildWikiGovContext(c, scope, scopeRef),
			})
			return c.json(result)
		} catch (err) {
			// Search subsystem outage (mongot down, index missing) is NOT a
			// query failure — surface it as 503 so callers retry instead of
			// treating it as "no matches".
			if (err instanceof WikiSearchUnavailableError) {
				return jsonError(
					c,
					503,
					"SEARCH_UNAVAILABLE",
					"wiki search is currently unavailable",
				)
			}
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_SEARCH_FAILED", message)
		}
	})

	// ---------------------------------------------------------------------
	// Scoped API key management (master key only)
	// ---------------------------------------------------------------------

	/** Every route below is gated on the master key rather than on a
	 *  capability. A scoped key policy names its own capabilities, so a
	 *  capability check here would let a key grant itself the right to mint
	 *  further keys. */
	const requireMaster = (c: Context<ApiEnvironment>) =>
		isMasterKeyRequest(c)
			? null
			: jsonError(
					c,
					403,
					"FORBIDDEN",
					"api key management requires the master SQRRL_API_KEY",
				)

	v1.get("/auth/whoami", (c) => {
		// Lets the console decide whether to offer key management at all,
		// without it having to guess from a 403 on some other call.
		const principal = getApiPrincipal(c)
		return c.json({
			subjectId: principal.subjectId,
			displayName: principal.displayName,
			trustTier: principal.trustTier,
			capabilities: principal.capabilities,
			allowedScopes: principal.allowedScopes,
			allowedAgentIds: principal.allowedAgentIds,
			isMasterKey: isMasterKeyRequest(c),
		})
	})

	v1.get("/admin/api-keys", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		try {
			const handle = await getWikiStoreHandle()
			const includeRevoked = c.req.query("includeRevoked") === "true"
			return c.json({ keys: await listApiKeys(handle, { includeRevoked }) })
		} catch (err) {
			return jsonError(
				c,
				500,
				"API_KEY_LIST_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	})

	v1.post("/admin/api-keys", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const subjectId = String(body.subjectId ?? "").trim()
		if (!subjectId)
			return jsonError(c, 400, "VALIDATION_ERROR", "subjectId is required")
		const capabilities = Array.isArray(body.capabilities)
			? body.capabilities.map((x) => String(x))
			: []
		if (capabilities.length === 0)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"at least one capability is required",
			)
		const unknownCapability = capabilities.find(
			(cap) => !(ALL_PRINCIPAL_CAPABILITIES as readonly string[]).includes(cap),
		)
		if (unknownCapability)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`unknown capability "${unknownCapability}"`,
			)
		const allowedScopes = Array.isArray(body.allowedScopes)
			? (body.allowedScopes as Array<Record<string, unknown>>).map((g) => ({
					scope: String(g.scope ?? ""),
					scopeRef: String(g.scopeRef ?? ""),
				}))
			: []
		if (allowedScopes.length === 0)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"at least one allowedScopes grant is required",
			)
		for (const grant of allowedScopes) {
			if (grant.scope !== "*" && !WIKI_VALID_SCOPES.includes(grant.scope))
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					`allowedScopes.scope must be * or one of ${WIKI_VALID_SCOPES.join("|")}`,
				)
			if (!grant.scopeRef)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"allowedScopes.scopeRef is required (use * for any)",
				)
		}
		const trustTier = String(body.trustTier ?? "standard")
		if (!["restricted", "standard", "admin"].includes(trustTier))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"trustTier must be restricted|standard|admin",
			)
		const expiresAt = body.expiresAt ? String(body.expiresAt) : undefined
		if (expiresAt && Number.isNaN(Date.parse(expiresAt)))
			return jsonError(c, 400, "VALIDATION_ERROR", "expiresAt must be a date")
		// A key that is already expired can never authenticate, so accepting it
		// would only create a confusing dead row.
		if (expiresAt && Date.parse(expiresAt) <= Date.now())
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"expiresAt must be in the future",
			)
		try {
			const handle = await getWikiStoreHandle()
			const created = await createApiKey(handle, {
				subjectId,
				...(body.displayName ? { displayName: String(body.displayName) } : {}),
				capabilities,
				allowedScopes,
				...(Array.isArray(body.allowedAgentIds) &&
				body.allowedAgentIds.length > 0
					? { allowedAgentIds: body.allowedAgentIds.map((x) => String(x)) }
					: {}),
				trustTier,
				...(expiresAt ? { expiresAt } : {}),
				createdBy: getApiPrincipal(c).subjectId,
			})
			invalidateApiKeyCache()
			// The only response that ever carries the secret.
			return c.json(created, 201)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (message.includes("E11000") || message.includes("duplicate key"))
				return jsonError(
					c,
					409,
					"SUBJECT_ID_TAKEN",
					`subjectId "${subjectId}" is already in use`,
				)
			return jsonError(c, 500, "API_KEY_CREATE_FAILED", message)
		}
	})

	v1.post("/admin/api-keys/update", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const keyId = String(body.keyId ?? "").trim()
		if (!keyId)
			return jsonError(c, 400, "VALIDATION_ERROR", "keyId is required")
		const patch: Parameters<typeof updateApiKey>[2] = {}
		if (body.displayName !== undefined)
			patch.displayName = String(body.displayName)
		if (Array.isArray(body.capabilities)) {
			const capabilities = body.capabilities.map((x) => String(x))
			const unknown = capabilities.find(
				(cap) =>
					!(ALL_PRINCIPAL_CAPABILITIES as readonly string[]).includes(cap),
			)
			if (unknown)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					`unknown capability "${unknown}"`,
				)
			if (capabilities.length === 0)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"capabilities cannot be emptied; revoke the key instead",
				)
			patch.capabilities = capabilities
		}
		if (Array.isArray(body.allowedScopes)) {
			const grants = (body.allowedScopes as Array<Record<string, unknown>>).map(
				(g) => ({
					scope: String(g.scope ?? ""),
					scopeRef: String(g.scopeRef ?? ""),
				}),
			)
			if (grants.length === 0)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"allowedScopes cannot be emptied; revoke the key instead",
				)
			for (const grant of grants) {
				if (grant.scope !== "*" && !WIKI_VALID_SCOPES.includes(grant.scope))
					return jsonError(
						c,
						400,
						"VALIDATION_ERROR",
						`allowedScopes.scope must be * or one of ${WIKI_VALID_SCOPES.join("|")}`,
					)
				if (!grant.scopeRef)
					return jsonError(
						c,
						400,
						"VALIDATION_ERROR",
						"allowedScopes.scopeRef is required (use * for any)",
					)
			}
			patch.allowedScopes = grants
		}
		if (Array.isArray(body.allowedAgentIds) && body.allowedAgentIds.length > 0)
			patch.allowedAgentIds = body.allowedAgentIds.map((x) => String(x))
		if (body.trustTier !== undefined) {
			const trustTier = String(body.trustTier)
			if (!["restricted", "standard", "admin"].includes(trustTier))
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"trustTier must be restricted|standard|admin",
				)
			patch.trustTier = trustTier
		}
		// null clears the expiry; omitting the field leaves it untouched.
		if (body.expiresAt === null) patch.expiresAt = null
		else if (body.expiresAt !== undefined) {
			const expiresAt = String(body.expiresAt)
			if (Number.isNaN(Date.parse(expiresAt)))
				return jsonError(c, 400, "VALIDATION_ERROR", "expiresAt must be a date")
			patch.expiresAt = expiresAt
		}
		try {
			const handle = await getWikiStoreHandle()
			const updated = await updateApiKey(handle, keyId, patch)
			invalidateApiKeyCache()
			if (!updated)
				return jsonError(
					c,
					404,
					"NOT_FOUND",
					`no active api key with keyId "${keyId}"`,
				)
			return c.json(updated)
		} catch (err) {
			return jsonError(
				c,
				500,
				"API_KEY_UPDATE_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	})

	v1.post("/admin/api-keys/revoke", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const keyId = String(body.keyId ?? "").trim()
		if (!keyId)
			return jsonError(c, 400, "VALIDATION_ERROR", "keyId is required")
		try {
			const handle = await getWikiStoreHandle()
			const revoked = await revokeApiKey(
				handle,
				keyId,
				getApiPrincipal(c).subjectId,
			)
			invalidateApiKeyCache()
			if (!revoked)
				return jsonError(
					c,
					404,
					"NOT_FOUND",
					`no active api key with keyId "${keyId}"`,
				)
			return c.json(revoked)
		} catch (err) {
			return jsonError(
				c,
				500,
				"API_KEY_REVOKE_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	})

	return v1
}
