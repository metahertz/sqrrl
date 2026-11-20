// Graph editing: re-routing edges, merging pages, reassigning tasks.
//
// Ingestion decides where things go on the way in, and gets it right most of
// the time. These are the corrections for when it does not: two hubs that mean
// the same thing, a task filed against the wrong person, an edge pointing
// somewhere it should not.
//
// Relationships could previously only be replaced wholesale through a patch,
// which is a read-modify-write with an obvious race and no way to express
// "remove this one edge". Everything here is built on add and remove instead.

import type { ClientSession } from "mongodb"
import {
	getWikiPage,
	updateWikiPage,
	type WikiDbHandle,
} from "./wiki-bridge.js"
import type { WikiPageEditor } from "./wiki-revisions.js"
import { omitUndefined } from "./omit-undefined.js"
import { wikiPagesCollection, wikiRevisionsCollection } from "./wiki-schema.js"
import { recomputeBacklinksAfterChange } from "./wiki-backlinks.js"

export interface WikiRelationshipSpec {
	targetPageSlug: string
	targetTitle: string
	kind: string
	weight?: number
	confidence?: number
}

/** Identifies edges to remove. Omitting kind removes every edge to that
 *  target, which is what "detach these two pages" means. */
export interface RelationshipMatcher {
	targetPageSlug: string
	kind?: string
}

type PageWithEdges = {
	title?: string
	relationships?: WikiRelationshipSpec[]
	backlinks?: Array<{ sourcePageSlug: string; sourceTitle?: string }>
	claims?: Array<{ id?: string; text: string }>
	state?: string
}

async function readPage(
	handle: WikiDbHandle,
	slug: string,
	scope: string,
	scopeRef: string,
): Promise<PageWithEdges | null> {
	return (await getWikiPage(
		handle,
		slug,
		scope,
		scopeRef,
	)) as PageWithEdges | null
}

/** Adds edges to a page, keeping the ones already there.
 *
 *  A patch REPLACES the relationships array, so a naive write deletes every
 *  edge the page had. Existing edges are keyed by target and kind, so
 *  re-running is a no-op rather than a duplicate. */
export async function addRelationships(
	handle: WikiDbHandle,
	slug: string,
	scope: string,
	scopeRef: string,
	additions: WikiRelationshipSpec[],
): Promise<number> {
	if (additions.length === 0) return 0
	const page = await readPage(handle, slug, scope, scopeRef)
	if (!page) return 0
	const existing = page.relationships ?? []
	const seen = new Set(existing.map((r) => `${r.kind}:${r.targetPageSlug}`))
	const merged = [...existing]
	let added = 0
	for (const rel of additions) {
		const key = `${rel.kind}:${rel.targetPageSlug}`
		if (seen.has(key)) continue
		seen.add(key)
		merged.push(rel)
		added++
	}
	if (added === 0) return 0
	await updateWikiPage(handle, slug, scope, scopeRef, {
		relationships: merged,
	} as never)
	return added
}

/** Removes edges from a page. Returns how many went. */
export async function removeRelationships(
	handle: WikiDbHandle,
	slug: string,
	scope: string,
	scopeRef: string,
	matchers: RelationshipMatcher[],
): Promise<number> {
	if (matchers.length === 0) return 0
	const page = await readPage(handle, slug, scope, scopeRef)
	if (!page) return 0
	const existing = page.relationships ?? []
	const kept = existing.filter(
		(rel) =>
			!matchers.some(
				(m) =>
					m.targetPageSlug === rel.targetPageSlug &&
					(m.kind === undefined || m.kind === rel.kind),
			),
	)
	const removed = existing.length - kept.length
	if (removed === 0) return 0
	await updateWikiPage(handle, slug, scope, scopeRef, {
		relationships: kept,
	} as never)
	// The targets lose a backlink.
	await recomputeBacklinksAfterChange(handle, slug, scope, scopeRef, {
		deleted: false,
	})
	return removed
}

export interface MergeResult {
	edgesRepointed: number
	inboundPagesTouched: number
	outboundEdgesMoved: number
	claimsMoved: number
	errors: string[]
}

/** Folds one page into another and supersedes the loser.
 *
 *  Inbound edges are found through the loser's backlinks, which the engine
 *  already maintains as the reverse of relationships — no collection scan.
 *
 *  The loser is superseded rather than deleted so the audit trail survives,
 *  and supersededBy records where its content went. Without that pointer a
 *  superseded page is a dead end: it is excluded from default listings, it
 *  cannot be revived except through the restore endpoint, and nothing says
 *  what replaced it. */
export async function mergePages(
	handle: WikiDbHandle,
	params: {
		from: string
		into: string
		scope: string
		scopeRef: string
		editor?: WikiPageEditor
		session?: ClientSession
	},
): Promise<MergeResult> {
	const out: MergeResult = {
		edgesRepointed: 0,
		inboundPagesTouched: 0,
		outboundEdgesMoved: 0,
		claimsMoved: 0,
		errors: [],
	}
	const { from, into, scope, scopeRef } = params
	if (from === into) throw new Error("cannot merge a page into itself")

	const loser = await readPage(handle, from, scope, scopeRef)
	if (!loser) throw new Error(`no wiki page "${from}" in ${scope}:${scopeRef}`)
	const winner = await readPage(handle, into, scope, scopeRef)
	if (!winner) throw new Error(`no wiki page "${into}" in ${scope}:${scopeRef}`)
	if (loser.state === "superseded") {
		throw new Error(`"${from}" is already superseded`)
	}

	// 1. Everything pointing at the loser now points at the winner, keeping
	//    the edge kind so "owned_by" does not silently become "relates_to".
	for (const back of loser.backlinks ?? []) {
		try {
			const src = await readPage(handle, back.sourcePageSlug, scope, scopeRef)
			if (!src) continue
			const seen = new Set(
				(src.relationships ?? []).map((r) => `${r.kind}:${r.targetPageSlug}`),
			)
			const rewritten: WikiRelationshipSpec[] = []
			let changed = 0
			for (const rel of src.relationships ?? []) {
				if (rel.targetPageSlug !== from) {
					rewritten.push(rel)
					continue
				}
				// Drop rather than duplicate when the source already links to the
				// winner with this kind.
				if (seen.has(`${rel.kind}:${into}`)) {
					changed++
					continue
				}
				rewritten.push({
					...rel,
					targetPageSlug: into,
					targetTitle: winner.title ?? into,
				})
				seen.add(`${rel.kind}:${into}`)
				changed++
			}
			if (changed === 0) continue
			await updateWikiPage(handle, back.sourcePageSlug, scope, scopeRef, {
				relationships: rewritten,
			} as never)
			await recomputeBacklinksAfterChange(
				handle,
				back.sourcePageSlug,
				scope,
				scopeRef,
				{ deleted: false },
			)
			out.edgesRepointed += changed
			out.inboundPagesTouched++
		} catch (err) {
			out.errors.push(
				`repoint ${back.sourcePageSlug}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	// 2. The loser's own outbound edges become the winner's, minus any that
	//    would point the winner at itself.
	const carried = (loser.relationships ?? []).filter(
		(rel) => rel.targetPageSlug !== into,
	)
	if (carried.length > 0) {
		out.outboundEdgesMoved = await addRelationships(
			handle,
			into,
			scope,
			scopeRef,
			carried,
		)
	}

	// 3. Claims the winner does not already make. updateWikiPage appends
	//    through the pipeline gate, so only the new ones are passed.
	const winnerTexts = new Set((winner.claims ?? []).map((c) => c.text.trim()))
	const newClaims = (loser.claims ?? [])
		.filter((c) => c.text?.trim() && !winnerTexts.has(c.text.trim()))
		.map((c, i) => ({ id: `claim-merged-${Date.now()}-${i}`, text: c.text }))
	if (newClaims.length > 0) {
		await updateWikiPage(handle, into, scope, scopeRef, {
			claims: newClaims,
		} as never)
		out.claimsMoved = newClaims.length
	}

	// 4. Supersede the loser and record where it went.
	const now = new Date()
	await wikiPagesCollection(handle.db, handle.prefix).findOneAndUpdate(
		{ slug: from, scope, scopeRef },
		{
			$set: omitUndefined({
				state: "superseded",
				supersededBy: into,
				updatedAt: now,
				validTo: now,
			}),
			$inc: { revision: 1 },
		},
		{ returnDocument: "after", session: params.session },
	)
	await recomputeBacklinksAfterChange(handle, from, scope, scopeRef, {
		deleted: true,
	})
	return out
}

export interface ReassignResult {
	ownerChanged: boolean
	sourceChanged: boolean
	edgesAdded: number
	edgesRemoved: number
}

/** Moves a task to a different owner and/or a different source page.
 *
 *  Editing taskCard.owner alone leaves the owned_by edge pointing at whoever
 *  used to own it, so the card and the graph disagree — the card is what a
 *  listing shows and the edge is what a traversal follows. This keeps them
 *  together.
 *
 *  The caller supplies the person hub slug rather than a name: minting hubs
 *  is ingestion's job, and guessing one here would create a second page for
 *  someone who already has one. */
export async function reassignTask(
	handle: WikiDbHandle,
	slug: string,
	params: {
		scope: string
		scopeRef: string
		owner?: { name: string; hubSlug: string }
		sourceSlug?: string
		sourceTitle?: string
	},
): Promise<ReassignResult> {
	const out: ReassignResult = {
		ownerChanged: false,
		sourceChanged: false,
		edgesAdded: 0,
		edgesRemoved: 0,
	}
	const page = (await getWikiPage(
		handle,
		slug,
		params.scope,
		params.scopeRef,
	)) as (PageWithEdges & { taskCard?: Record<string, unknown> }) | null
	if (!page) throw new Error(`no wiki page "${slug}"`)
	if (!page.taskCard) throw new Error(`"${slug}" is not a task page`)

	if (params.owner) {
		const previous = (page.relationships ?? []).filter(
			(r) => r.kind === "owned_by",
		)
		out.edgesRemoved += await removeRelationships(
			handle,
			slug,
			params.scope,
			params.scopeRef,
			previous.map((r) => ({
				targetPageSlug: r.targetPageSlug,
				kind: "owned_by",
			})),
		)
		out.edgesAdded += await addRelationships(
			handle,
			slug,
			params.scope,
			params.scopeRef,
			[
				{
					targetPageSlug: params.owner.hubSlug,
					targetTitle: params.owner.name,
					kind: "owned_by",
					weight: 1,
					confidence: 0.9,
				},
			],
		)
		await updateWikiPage(handle, slug, params.scope, params.scopeRef, {
			taskCard: { ...page.taskCard, owner: params.owner.name },
		} as never)
		out.ownerChanged = true
	}

	if (params.sourceSlug) {
		const previous = (page.relationships ?? []).filter(
			(r) => r.kind === "derived_from",
		)
		out.edgesRemoved += await removeRelationships(
			handle,
			slug,
			params.scope,
			params.scopeRef,
			previous.map((r) => ({
				targetPageSlug: r.targetPageSlug,
				kind: "derived_from",
			})),
		)
		out.edgesAdded += await addRelationships(
			handle,
			slug,
			params.scope,
			params.scopeRef,
			[
				{
					targetPageSlug: params.sourceSlug,
					targetTitle: params.sourceTitle ?? params.sourceSlug,
					kind: "derived_from",
					weight: 1,
					confidence: 0.9,
				},
			],
		)
		const card = { ...(page.taskCard ?? {}), sourceRef: params.sourceSlug }
		await updateWikiPage(handle, slug, params.scope, params.scopeRef, {
			taskCard: card,
		} as never)
		out.sourceChanged = true
	}
	return out
}

// ---------------------------------------------------------------------------
// Purge
//
// Distinct from both deletes already here, and the distinction matters.
//
//   delete            supersedes the page, keeps everything, reversible
//   delete ?hard=true removes the page — and writes the whole document into a
//                     revision snapshot on the way out, so the content stays
//   purge             the content goes
//
// The hard delete's snapshot is deliberate: it is an audit trail. But it makes
// hard delete the wrong tool for material that should never have been stored,
// which is the only reason to want this. Purge therefore deletes the page's
// revisions too, and cascades to the task pages derived from it, because a
// task's body is a source_quote — text copied verbatim out of the note.
//
// Person and topic hubs are never purged: they hold no note content, and they
// are shared, so removing one would damage every other note that links to it.
// ---------------------------------------------------------------------------

export interface PurgeResult {
	pagesPurged: string[]
	revisionsDeleted: number
	inboundEdgesRemoved: number
	errors: string[]
}

/** Permanently removes a page, its revision history, and optionally the tasks
 *  derived from it. There is no undo. */
export async function purgeWikiPage(
	handle: WikiDbHandle,
	params: {
		slug: string
		scope: string
		scopeRef: string
		/** Also purge task pages whose taskCard.sourceRef is this page. */
		cascadeTasks?: boolean
	},
): Promise<PurgeResult> {
	const { slug, scope, scopeRef } = params
	const out: PurgeResult = {
		pagesPurged: [],
		revisionsDeleted: 0,
		inboundEdgesRemoved: 0,
		errors: [],
	}
	const pages = wikiPagesCollection(handle.db, handle.prefix)
	const revisions = wikiRevisionsCollection(handle.db, handle.prefix)

	const target = await readPage(handle, slug, scope, scopeRef)
	if (!target) throw new Error(`no wiki page "${slug}" in ${scope}:${scopeRef}`)

	const doomed = [slug]
	if (params.cascadeTasks) {
		// Derived tasks are found by taskCard.sourceRef rather than by walking
		// edges: an edge may already have been re-routed by hand, but the card
		// still records where the text came from.
		const derived = await pages
			.find(
				{ scope, scopeRef, kind: "procedure", "taskCard.sourceRef": slug },
				{ projection: { slug: 1 } },
			)
			.toArray()
		for (const d of derived) doomed.push(String(d.slug))
	}

	for (const victim of doomed) {
		try {
			// Pages pointing at this one keep a dangling edge otherwise: backlinks
			// are recomputed on delete but relationships are not.
			const page = await readPage(handle, victim, scope, scopeRef)
			for (const back of page?.backlinks ?? []) {
				if (doomed.includes(back.sourcePageSlug)) continue
				out.inboundEdgesRemoved += await removeRelationships(
					handle,
					back.sourcePageSlug,
					scope,
					scopeRef,
					[{ targetPageSlug: victim }],
				)
			}
			const revs = await revisions.deleteMany({
				pageSlug: victim,
				scope,
				scopeRef,
			})
			out.revisionsDeleted += revs.deletedCount ?? 0
			// findOneAndDelete directly, NOT deleteWikiPage: its hard branch
			// records a revision holding the whole document, which is exactly
			// what a purge exists to prevent.
			const removed = await pages.findOneAndDelete({
				slug: victim,
				scope,
				scopeRef,
			})
			if (removed) {
				out.pagesPurged.push(victim)
				// The pages this one linked TO hold a backlink entry naming it,
				// with its title. Deleting the document directly skips the
				// recompute that deleteWikiPage does, so without this the
				// purged page's title — the very text a purge removes —
				// survives in its targets' backlinks.
				await recomputeBacklinksAfterChange(handle, victim, scope, scopeRef, {
					deleted: true,
				})
			}
		} catch (err) {
			out.errors.push(
				`${victim}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return out
}
