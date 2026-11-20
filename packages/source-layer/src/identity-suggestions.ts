// "Same person?" suggestions, next to wiki_pages in the wiki database.
//
//   identity_suggestions  one document per open question:
//     - kind "link": a page names someone ambiguously ("Taylor" in a note
//       when there are two Taylors). The link points at the first-name hub
//       until the user picks who it is; accepting moves that one link.
//     - kind "merge": two people pages are probably one person (Ben and
//       Benjamin Castell at the same company). Accepting merges them.
//
// Nothing here changes the wiki. Deciding is the API's job, so the change
// carries the caller's identity. A dismissed question is kept, so the same
// question is never asked twice.

import { type Collection, type Db, ObjectId } from "mongodb"
import type { WikiDbHandle } from "@sqrrl/wiki-engine"

export type IdentitySuggestionKind = "link" | "merge"
export type IdentitySuggestionStatus = "pending" | "accepted" | "dismissed"

export interface IdentityCandidate {
	slug: string
	title: string
	/** Why this person is a candidate, for the user. */
	reason: string
}

export interface IdentitySuggestion {
	id: string
	scope: string
	scopeRef: string
	kind: IdentitySuggestionKind
	/** link: the hub the page links to now (people/taylor).
	 *  merge: the page that would be folded into a candidate. */
	subjectSlug: string
	subjectTitle: string
	/** link only: the page whose link is in question, and the edge kind. */
	fromSlug?: string
	fromTitle?: string
	edgeKind?: string
	candidates: IdentityCandidate[]
	status: IdentitySuggestionStatus
	chosen?: string
	createdAt: string
	updatedAt: string
	decidedAt?: string
	decidedBy?: string
}

export function identitySuggestionsCollection(
	db: Db,
	prefix: string,
): Collection {
	return db.collection(`${prefix}identity_suggestions`)
}

const ensured = new WeakMap<Db, Set<string>>()

export async function ensureIdentitySchema(
	handle: WikiDbHandle,
): Promise<void> {
	const done = ensured.get(handle.db) ?? new Set<string>()
	if (done.has(handle.prefix)) return
	const c = identitySuggestionsCollection(handle.db, handle.prefix)
	await c.createIndex(
		{ scope: 1, scopeRef: 1, status: 1, updatedAt: -1 },
		{ name: "scope_status" },
	)
	// One question per (subject, page, edge) ever: a dismissal is final.
	await c.createIndex(
		{
			scope: 1,
			scopeRef: 1,
			kind: 1,
			subjectSlug: 1,
			fromSlug: 1,
			edgeKind: 1,
		},
		{ name: "one_question", unique: true },
	)
	done.add(handle.prefix)
	ensured.set(handle.db, done)
}

type Scope = { scope: string; scopeRef: string }

/** Records a question unless it was already asked. Pending questions get
 *  the latest candidates; decided ones are left alone. */
export async function recordIdentitySuggestion(
	handle: WikiDbHandle,
	p: Scope & {
		kind: IdentitySuggestionKind
		subjectSlug: string
		subjectTitle: string
		fromSlug?: string
		fromTitle?: string
		edgeKind?: string
		candidates: IdentityCandidate[]
	},
): Promise<void> {
	await ensureIdentitySchema(handle)
	const now = new Date()
	const key = {
		scope: p.scope,
		scopeRef: p.scopeRef,
		kind: p.kind,
		subjectSlug: p.subjectSlug,
		fromSlug: p.fromSlug ?? null,
		edgeKind: p.edgeKind ?? null,
	}
	const c = identitySuggestionsCollection(handle.db, handle.prefix)
	try {
		await c.updateOne(
			key,
			{
				$setOnInsert: { ...key, status: "pending", createdAt: now },
				$set: {
					subjectTitle: p.subjectTitle,
					...(p.fromTitle ? { fromTitle: p.fromTitle } : {}),
					updatedAt: now,
				},
			},
			{ upsert: true },
		)
		await c.updateOne(
			{ ...key, status: "pending" },
			{ $set: { candidates: p.candidates } },
		)
	} catch (err) {
		// Two writers raced on the unique key: the other one recorded it.
		if ((err as { code?: number }).code !== 11000) throw err
	}
}

function view(d: Record<string, unknown>): IdentitySuggestion {
	const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : undefined)
	return {
		id: String(d._id),
		scope: String(d.scope),
		scopeRef: String(d.scopeRef),
		kind: d.kind as IdentitySuggestionKind,
		subjectSlug: String(d.subjectSlug),
		subjectTitle: String(d.subjectTitle ?? d.subjectSlug),
		...(d.fromSlug ? { fromSlug: String(d.fromSlug) } : {}),
		...(d.fromTitle ? { fromTitle: String(d.fromTitle) } : {}),
		...(d.edgeKind ? { edgeKind: String(d.edgeKind) } : {}),
		candidates: (d.candidates as IdentityCandidate[] | undefined) ?? [],
		status: d.status as IdentitySuggestionStatus,
		...(d.chosen ? { chosen: String(d.chosen) } : {}),
		createdAt: iso(d.createdAt) ?? "",
		updatedAt: iso(d.updatedAt) ?? "",
		...(iso(d.decidedAt) ? { decidedAt: iso(d.decidedAt) } : {}),
		...(d.decidedBy ? { decidedBy: String(d.decidedBy) } : {}),
	}
}

export async function listIdentitySuggestions(
	handle: WikiDbHandle,
	p: Scope & { status?: IdentitySuggestionStatus; limit?: number },
): Promise<IdentitySuggestion[]> {
	await ensureIdentitySchema(handle)
	const docs = await identitySuggestionsCollection(handle.db, handle.prefix)
		.find({
			scope: p.scope,
			scopeRef: p.scopeRef,
			status: p.status ?? "pending",
		})
		.sort({ updatedAt: -1 })
		.limit(Math.min(p.limit ?? 100, 500))
		.toArray()
	return docs.map((d) => view(d))
}

export async function countIdentitySuggestions(
	handle: WikiDbHandle,
	p: Scope,
): Promise<Record<IdentitySuggestionStatus, number>> {
	await ensureIdentitySchema(handle)
	const rows = await identitySuggestionsCollection(handle.db, handle.prefix)
		.aggregate<{ _id: IdentitySuggestionStatus; n: number }>([
			{ $match: { scope: p.scope, scopeRef: p.scopeRef } },
			{ $group: { _id: "$status", n: { $sum: 1 } } },
		])
		.toArray()
	const out = { pending: 0, accepted: 0, dismissed: 0 }
	for (const r of rows) out[r._id] = r.n
	return out
}

export async function getIdentitySuggestion(
	handle: WikiDbHandle,
	p: Scope & { id: string },
): Promise<IdentitySuggestion | undefined> {
	if (!ObjectId.isValid(p.id)) return undefined
	const d = await identitySuggestionsCollection(
		handle.db,
		handle.prefix,
	).findOne({ _id: new ObjectId(p.id), scope: p.scope, scopeRef: p.scopeRef })
	return d ? view(d) : undefined
}

/** Marks a pending suggestion decided. False when it was not pending. */
export async function decideIdentitySuggestion(
	handle: WikiDbHandle,
	p: Scope & {
		id: string
		status: "accepted" | "dismissed"
		chosen?: string
		decidedBy?: string
	},
): Promise<boolean> {
	if (!ObjectId.isValid(p.id)) return false
	const now = new Date()
	const r = await identitySuggestionsCollection(
		handle.db,
		handle.prefix,
	).updateOne(
		{
			_id: new ObjectId(p.id),
			scope: p.scope,
			scopeRef: p.scopeRef,
			status: "pending",
		},
		{
			$set: {
				status: p.status,
				decidedAt: now,
				updatedAt: now,
				...(p.chosen ? { chosen: p.chosen } : {}),
				...(p.decidedBy ? { decidedBy: p.decidedBy } : {}),
			},
		},
	)
	return r.modifiedCount === 1
}
