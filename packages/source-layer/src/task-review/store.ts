// Where task review keeps its state, next to wiki_pages in the wiki database.
//
//   task_review_queue  source pages distilled since the last run, to be
//                      expanded into the open tasks they might close;
//   task_reviews       one document per task: whether it is waiting for a
//                      review, why (hints: pages that might be evidence),
//                      when it was last reviewed, retry state, and the
//                      evidence the user has dismissed for it;
//   task_suggestions   what the reviewer proposes: one pending suggestion
//                      per task at most, merged as evidence accumulates,
//                      then accepted, dismissed or stale.
//
// Nothing here changes a task. Accepting a suggestion is the API's job, so
// the change carries the caller's identity and a revision.

import { type Collection, type Db, type Document, ObjectId } from "mongodb"
import type { WikiDbHandle } from "@sqrrl/wiki-engine"

export type ProposedStatus = "done" | "dropped"
export type SuggestionStatus = "pending" | "accepted" | "dismissed" | "stale"

export interface SuggestionEvidence {
	/** "page:<slug>" or "raw:<id>": what a dismissal remembers. */
	key: string
	kind: "page" | "raw"
	slug?: string
	rawItemId?: string
	title: string
	quote: string
	occurredAt?: string
	source?: string
}

export interface TaskSuggestion {
	id: string
	scope: string
	scopeRef: string
	taskSlug: string
	taskTitle: string
	proposed: ProposedStatus
	confidence: number
	rationale: string
	evidence: SuggestionEvidence[]
	status: SuggestionStatus
	createdAt: string
	updatedAt: string
	decidedAt?: string
	decidedBy?: string
	note?: string
}

export function taskSuggestionsCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}task_suggestions`)
}
export function taskReviewsCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}task_reviews`)
}
export function taskReviewQueueCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}task_review_queue`)
}

const ensured = new WeakMap<Db, Set<string>>()

export async function ensureTaskReviewSchema(
	handle: WikiDbHandle,
): Promise<void> {
	const done = ensured.get(handle.db) ?? new Set<string>()
	if (done.has(handle.prefix)) return
	const s = taskSuggestionsCollection(handle.db, handle.prefix)
	await s.createIndex(
		{ scope: 1, scopeRef: 1, status: 1, updatedAt: -1 },
		{ name: "scope_status" },
	)
	// At most one pending suggestion per task: new evidence merges into it.
	await s.createIndex(
		{ scope: 1, scopeRef: 1, taskSlug: 1 },
		{
			name: "one_pending_per_task",
			unique: true,
			partialFilterExpression: { status: "pending" },
		},
	)
	const r = taskReviewsCollection(handle.db, handle.prefix)
	await r.createIndex(
		{ scope: 1, scopeRef: 1, taskSlug: 1 },
		{ name: "task", unique: true },
	)
	await r.createIndex({ pending: 1, enqueuedAt: 1 }, { name: "pending" })
	await taskReviewQueueCollection(handle.db, handle.prefix).createIndex(
		{ scope: 1, scopeRef: 1, sourceSlug: 1 },
		{ name: "source", unique: true },
	)
	done.add(handle.prefix)
	ensured.set(handle.db, done)
}

type Scope = { scope: string; scopeRef: string }

// ---------------------------------------------------------------------------
// Queue of distilled source pages
// ---------------------------------------------------------------------------

/** Called by the distillers after a source page is written. Repeat edits
 *  of one page before the next run coalesce into one entry. */
export async function enqueueSourceReview(
	handle: WikiDbHandle,
	p: Scope & { sourceSlug: string },
): Promise<void> {
	await taskReviewQueueCollection(handle.db, handle.prefix).updateOne(
		{ scope: p.scope, scopeRef: p.scopeRef, sourceSlug: p.sourceSlug },
		{ $set: { enqueuedAt: new Date() } },
		{ upsert: true },
	)
}

export async function takeSourceQueue(
	handle: WikiDbHandle,
	p: Scope & { limit: number },
) {
	return (await taskReviewQueueCollection(handle.db, handle.prefix)
		.find({ scope: p.scope, scopeRef: p.scopeRef })
		.sort({ enqueuedAt: 1 })
		.limit(p.limit)
		.toArray()) as Array<
		Document & { _id: ObjectId; sourceSlug: string; enqueuedAt: Date }
	>
}

/** Removes an entry unless the page was queued again while it was being
 *  expanded (enqueuedAt moved), in which case it waits for the next run. */
export async function clearSourceQueueEntry(
	handle: WikiDbHandle,
	id: ObjectId,
	enqueuedAt: Date,
): Promise<void> {
	await taskReviewQueueCollection(handle.db, handle.prefix).deleteOne({
		_id: id,
		enqueuedAt,
	})
}

// ---------------------------------------------------------------------------
// Per-task review state
// ---------------------------------------------------------------------------

export type ReviewReason = "evidence" | "sweep" | "manual"

export async function markTasksForReview(
	handle: WikiDbHandle,
	p: Scope & { taskSlugs: string[]; reason: ReviewReason; hint?: string },
): Promise<void> {
	const coll = taskReviewsCollection(handle.db, handle.prefix)
	for (const taskSlug of new Set(p.taskSlugs)) {
		await coll.updateOne(
			{ scope: p.scope, scopeRef: p.scopeRef, taskSlug },
			{
				$set: { pending: true, enqueuedAt: new Date(), reason: p.reason },
				...(p.hint ? { $addToSet: { hints: p.hint } } : {}),
				$setOnInsert: { dismissed: [] },
			},
			{ upsert: true },
		)
	}
}

export interface ReviewState {
	_id: ObjectId
	taskSlug: string
	hints?: string[]
	dismissed?: string[]
	/** When the user last dismissed a suggestion for this task: later
	 *  reviews only consider evidence newer than this, so the same facts
	 *  seen through another page or message do not raise it again. */
	dismissedAt?: Date
	attempts?: number
	reviewedAt?: Date
}

export async function takePendingReviews(
	handle: WikiDbHandle,
	p: Scope & { limit: number; now?: Date },
) {
	const now = p.now ?? new Date()
	return (await taskReviewsCollection(handle.db, handle.prefix)
		.find({
			scope: p.scope,
			scopeRef: p.scopeRef,
			pending: true,
			$or: [
				{ nextAttemptAt: { $exists: false } },
				{ nextAttemptAt: { $lte: now } },
			],
		})
		.sort({ enqueuedAt: 1 })
		.limit(p.limit)
		.toArray()) as unknown as ReviewState[]
}

export async function getReviewState(
	handle: WikiDbHandle,
	p: Scope & { taskSlug: string },
) {
	return (await taskReviewsCollection(handle.db, handle.prefix).findOne({
		scope: p.scope,
		scopeRef: p.scopeRef,
		taskSlug: p.taskSlug,
	})) as unknown as ReviewState | null
}

/** Success clears the hints; failure backs off (15 min, doubling, at most a
 *  day) so a down LLM does not spin. */
export async function finishReview(
	handle: WikiDbHandle,
	id: ObjectId,
	error?: string,
	attempts = 0,
): Promise<void> {
	const coll = taskReviewsCollection(handle.db, handle.prefix)
	if (!error) {
		await coll.updateOne(
			{ _id: id },
			{
				$set: {
					pending: false,
					reviewedAt: new Date(),
					attempts: 0,
					hints: [],
				},
				$unset: { lastError: "", nextAttemptAt: "" },
			},
		)
		return
	}
	const wait = Math.min(15 * 60_000 * 2 ** attempts, 24 * 3600_000)
	await coll.updateOne(
		{ _id: id },
		{
			$set: {
				lastError: error.slice(0, 500),
				nextAttemptAt: new Date(Date.now() + wait),
			},
			$inc: { attempts: 1 },
		},
	)
}

/** Open tasks not reviewed in `staleDays`, overdue first: what a sweep
 *  looks at. */
export async function tasksDueForSweep(
	handle: WikiDbHandle,
	p: Scope & { limit: number; staleDays: number; now?: Date; today: string },
): Promise<string[]> {
	const now = p.now ?? new Date()
	const pages = (await handle.db
		.collection(`${handle.prefix}wiki_pages`)
		.find(
			{
				scope: p.scope,
				scopeRef: p.scopeRef,
				kind: "procedure",
				"taskCard.status": { $in: ["open", "in-progress", "blocked"] },
			},
			{ projection: { slug: 1, "taskCard.dueDate": 1, createdAt: 1 } },
		)
		.toArray()) as unknown as Array<{
		slug: string
		taskCard?: { dueDate?: string }
		createdAt?: Date
	}>
	const recent = new Set(
		(
			await taskReviewsCollection(handle.db, handle.prefix)
				.find(
					{
						scope: p.scope,
						scopeRef: p.scopeRef,
						reviewedAt: {
							$gte: new Date(now.getTime() - p.staleDays * 86400_000),
						},
					},
					{ projection: { taskSlug: 1 } },
				)
				.toArray()
		).map((d) => d.taskSlug as string),
	)
	const rank = (t: (typeof pages)[number]) => {
		const due = t.taskCard?.dueDate
		return due && due < p.today
			? `0${due}`
			: due
				? `1${due}`
				: `2${String(t.createdAt?.toISOString?.() ?? "")}`
	}
	return pages
		.filter((t) => !recent.has(t.slug))
		.sort((a, b) => rank(a).localeCompare(rank(b)))
		.slice(0, p.limit)
		.map((t) => t.slug)
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function toSuggestion(doc: Document): TaskSuggestion {
	const iso = (d: unknown) =>
		d instanceof Date ? d.toISOString() : (d as string | undefined)
	return {
		id: String(doc._id),
		scope: doc.scope,
		scopeRef: doc.scopeRef,
		taskSlug: doc.taskSlug,
		taskTitle: doc.taskTitle,
		proposed: doc.proposed,
		confidence: doc.confidence,
		rationale: doc.rationale ?? "",
		evidence: doc.evidence ?? [],
		status: doc.status,
		createdAt: iso(doc.createdAt) as string,
		updatedAt: iso(doc.updatedAt) as string,
		...(doc.decidedAt ? { decidedAt: iso(doc.decidedAt) } : {}),
		...(doc.decidedBy ? { decidedBy: doc.decidedBy } : {}),
		...(doc.note ? { note: doc.note } : {}),
	}
}

/** Records a proposal, merging into the task's pending suggestion if there
 *  is one: evidence is unioned by key, the stronger verdict wins. Evidence
 *  the user dismissed for this task never comes back. Returns undefined
 *  when nothing new remains. */
export async function recordSuggestion(
	handle: WikiDbHandle,
	p: Scope & {
		taskSlug: string
		taskTitle: string
		proposed: ProposedStatus
		confidence: number
		rationale: string
		evidence: SuggestionEvidence[]
		dismissed?: string[]
	},
): Promise<TaskSuggestion | undefined> {
	const dismissed = new Set(p.dismissed ?? [])
	const fresh = p.evidence.filter((e) => !dismissed.has(e.key))
	if (!fresh.length) return undefined
	const coll = taskSuggestionsCollection(handle.db, handle.prefix)
	const key = {
		scope: p.scope,
		scopeRef: p.scopeRef,
		taskSlug: p.taskSlug,
		status: "pending",
	}
	const now = new Date()
	const existing = await coll.findOne(key)
	if (existing) {
		const known = new Set(
			(existing.evidence as SuggestionEvidence[]).map((e) => e.key),
		)
		const added = fresh.filter((e) => !known.has(e.key))
		const stronger = p.confidence > (existing.confidence as number)
		if (!added.length && !stronger) return toSuggestion(existing)
		await coll.updateOne({ _id: existing._id }, {
			$set: {
				updatedAt: now,
				...(stronger
					? {
							proposed: p.proposed,
							confidence: p.confidence,
							rationale: p.rationale,
						}
					: {}),
			},
			...(added.length ? { $push: { evidence: { $each: added } } } : {}),
		} as Document)
		return toSuggestion((await coll.findOne({ _id: existing._id })) as Document)
	}
	const doc = {
		...key,
		taskTitle: p.taskTitle,
		proposed: p.proposed,
		confidence: p.confidence,
		rationale: p.rationale,
		evidence: fresh,
		createdAt: now,
		updatedAt: now,
	}
	const inserted = await coll.insertOne(doc)
	return toSuggestion({ ...doc, _id: inserted.insertedId })
}

export async function listSuggestions(
	handle: WikiDbHandle,
	p: Scope & { status?: SuggestionStatus; taskSlug?: string; limit?: number },
): Promise<TaskSuggestion[]> {
	const docs = await taskSuggestionsCollection(handle.db, handle.prefix)
		.find({
			scope: p.scope,
			scopeRef: p.scopeRef,
			...(p.status ? { status: p.status } : {}),
			...(p.taskSlug ? { taskSlug: p.taskSlug } : {}),
		})
		.sort({ confidence: -1, updatedAt: -1 })
		.limit(Math.min(p.limit ?? 100, 500))
		.toArray()
	return docs.map(toSuggestion)
}

export interface TaskReviewCounts {
	suggestions: Record<SuggestionStatus, number>
	/** Distilled pages waiting to be expanded into tasks. */
	queuedSources: number
	/** Tasks marked for review and not yet judged. */
	pendingTasks: number
}

/** Totals for the console and the exporter: suggestions by status (the
 *  acceptance rate is accepted / (accepted + dismissed)) and queue depth. */
export async function taskReviewCounts(
	handle: WikiDbHandle,
	p: Scope,
): Promise<TaskReviewCounts> {
	const where = { scope: p.scope, scopeRef: p.scopeRef }
	const [byStatus, queuedSources, pendingTasks] = await Promise.all([
		taskSuggestionsCollection(handle.db, handle.prefix)
			.aggregate<{ _id: SuggestionStatus; n: number }>([
				{ $match: where },
				{ $group: { _id: "$status", n: { $sum: 1 } } },
			])
			.toArray(),
		taskReviewQueueCollection(handle.db, handle.prefix).countDocuments(where),
		taskReviewsCollection(handle.db, handle.prefix).countDocuments({
			...where,
			pending: true,
		}),
	])
	const suggestions = { pending: 0, accepted: 0, dismissed: 0, stale: 0 }
	for (const r of byStatus) if (r._id in suggestions) suggestions[r._id] = r.n
	return { suggestions, queuedSources, pendingTasks }
}

export async function getSuggestion(
	handle: WikiDbHandle,
	id: string,
): Promise<TaskSuggestion | undefined> {
	if (!ObjectId.isValid(id)) return undefined
	const doc = await taskSuggestionsCollection(handle.db, handle.prefix).findOne(
		{ _id: new ObjectId(id) },
	)
	return doc ? toSuggestion(doc) : undefined
}

/** Closes a pending suggestion. Dismissing remembers its evidence for the
 *  task, so the same evidence cannot raise it again. */
export async function decideSuggestion(
	handle: WikiDbHandle,
	s: TaskSuggestion,
	p: {
		status: Exclude<SuggestionStatus, "pending">
		by?: string
		note?: string
	},
): Promise<void> {
	await taskSuggestionsCollection(handle.db, handle.prefix).updateOne(
		{ _id: new ObjectId(s.id), status: "pending" },
		{
			$set: {
				status: p.status,
				decidedAt: new Date(),
				...(p.by ? { decidedBy: p.by } : {}),
				...(p.note ? { note: p.note } : {}),
			},
		},
	)
	if (p.status === "dismissed")
		await taskReviewsCollection(handle.db, handle.prefix).updateOne(
			{ scope: s.scope, scopeRef: s.scopeRef, taskSlug: s.taskSlug },
			{
				$addToSet: { dismissed: { $each: s.evidence.map((e) => e.key) } },
				$set: { dismissedAt: new Date() },
				$setOnInsert: { pending: false },
			},
			{ upsert: true },
		)
}

/** A task closed or removed some other way makes its suggestion moot. */
export async function markSuggestionsStale(
	handle: WikiDbHandle,
	p: Scope & { taskSlug: string },
): Promise<void> {
	await taskSuggestionsCollection(handle.db, handle.prefix).updateMany(
		{
			scope: p.scope,
			scopeRef: p.scopeRef,
			taskSlug: p.taskSlug,
			status: "pending",
		},
		{ $set: { status: "stale", decidedAt: new Date() } },
	)
}
