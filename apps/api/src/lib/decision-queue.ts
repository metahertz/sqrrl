// The decision queue: accept/dismiss clicks from the console, carried out in
// the background so the click returns at once.
//
//   POST /v1/wiki/decisions   checks the suggestion is pending and records a
//                             job (202); a second click on the same
//                             suggestion returns the job already queued;
//   the worker               takes jobs one at a time, oldest first, and
//                             runs the same code as the accept/dismiss routes
//                             (lib/decisions.ts) as the person who clicked;
//   GET /v1/wiki/decisions    lets the console watch its jobs and put an item
//                             back if its job failed.
//
// Jobs live in <prefix>decision_jobs next to the wiki, so a restart loses
// nothing: jobs left "running" go back to "queued" when the worker starts.
// Finished jobs expire after a week. One worker per API process; decisions
// are small, and running them in order keeps two merges from racing.

import type { Collection, Db, ObjectId } from "mongodb"
import { ObjectId as Oid } from "mongodb"
import { getIdentitySuggestion } from "@sqrrl/source-layer"
import type { WikiDbHandle } from "@sqrrl/wiki-engine"
import {
	type Actor,
	acceptTaskDecision,
	DecisionError,
	dismissTaskDecision,
	identityDecision,
	pendingTaskSuggestion,
} from "./decisions.js"

export type DecisionKind = "task-suggestion" | "identity-suggestion"
export type DecisionAction = "accept" | "dismiss"
export type JobStatus = "queued" | "running" | "done" | "failed"

export interface DecisionInput {
	scope: string
	scopeRef: string
	kind: DecisionKind
	suggestionId: string
	action: DecisionAction
	/** identity accept: the chosen person. */
	chosen?: string
	/** task dismiss: why. */
	note?: string
	expectedRevision?: number
}

export interface DecisionJob extends DecisionInput {
	id: string
	status: JobStatus
	error?: { code: string; message: string; status: number }
	createdAt: string
	finishedAt?: string
}

const KEEP_FINISHED_S = 7 * 24 * 3600

export function decisionJobsCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}decision_jobs`)
}

const ensured = new WeakMap<object, Set<string>>()

async function ensureSchema(handle: WikiDbHandle): Promise<Collection> {
	const c = decisionJobsCollection(handle.db, handle.prefix)
	const done = ensured.get(handle.db) ?? new Set<string>()
	if (done.has(handle.prefix)) return c
	await c.createIndex({ status: 1, createdAt: 1 }, { name: "status_created" })
	// One open job per suggestion: a double click queues once.
	await c.createIndex(
		{ kind: 1, suggestionId: 1 },
		{
			name: "one_open_job",
			unique: true,
			partialFilterExpression: { open: true },
		},
	)
	await c.createIndex(
		{ finishedAt: 1 },
		{ name: "expire_finished", expireAfterSeconds: KEEP_FINISHED_S },
	)
	done.add(handle.prefix)
	ensured.set(handle.db, done)
	return c
}

function view(d: Record<string, unknown>): DecisionJob {
	const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : undefined)
	return {
		id: String(d._id),
		scope: String(d.scope),
		scopeRef: String(d.scopeRef),
		kind: d.kind as DecisionKind,
		suggestionId: String(d.suggestionId),
		action: d.action as DecisionAction,
		...(d.chosen ? { chosen: String(d.chosen) } : {}),
		status: d.status as JobStatus,
		...(d.error ? { error: d.error as DecisionJob["error"] } : {}),
		createdAt: iso(d.createdAt) ?? "",
		...(iso(d.finishedAt) ? { finishedAt: iso(d.finishedAt) } : {}),
	}
}

/** Fails fast on what can be known now, so the console can put the item
 *  back at once: unknown or already decided suggestion, missing choice. */
async function precheck(handle: WikiDbHandle, input: DecisionInput) {
	if (input.kind === "task-suggestion") {
		await pendingTaskSuggestion(handle, {
			scope: input.scope,
			scopeRef: input.scopeRef,
			id: input.suggestionId,
		})
		return
	}
	if (input.action === "accept" && !input.chosen)
		throw new DecisionError(400, "VALIDATION_ERROR", "chosen is required")
	const q = await getIdentitySuggestion(handle, {
		scope: input.scope,
		scopeRef: input.scopeRef,
		id: input.suggestionId,
	})
	if (!q)
		throw new DecisionError(404, "IDENTITY_NOT_FOUND", "no such suggestion")
	if (q.status !== "pending")
		throw new DecisionError(409, "IDENTITY_NOT_PENDING", `already ${q.status}`)
	if (input.chosen && !q.candidates.some((c) => c.slug === input.chosen))
		throw new DecisionError(
			400,
			"IDENTITY_BAD_CHOICE",
			`"${input.chosen}" is not one of the candidates`,
		)
}

export async function enqueueDecision(
	handle: WikiDbHandle,
	input: DecisionInput,
	actor: Actor,
): Promise<{ job: DecisionJob; existing: boolean }> {
	const c = await ensureSchema(handle)
	const open = await c.findOne({
		kind: input.kind,
		suggestionId: input.suggestionId,
		open: true,
	})
	if (open) return { job: view(open), existing: true }
	await precheck(handle, input)
	const doc = {
		...input,
		actor,
		status: "queued" as JobStatus,
		open: true,
		attempts: 0,
		createdAt: new Date(),
	}
	try {
		const r = await c.insertOne(doc)
		kickWorker(handle)
		return { job: view({ ...doc, _id: r.insertedId }), existing: false }
	} catch (err) {
		// The same click raced in twice: report the job that won.
		if ((err as { code?: number }).code !== 11000) throw err
		const won = await c.findOne({
			kind: input.kind,
			suggestionId: input.suggestionId,
			open: true,
		})
		if (!won) throw err
		return { job: view(won), existing: true }
	}
}

export async function getDecisionJobs(
	handle: WikiDbHandle,
	p: { scope: string; scopeRef: string; ids: string[] },
): Promise<DecisionJob[]> {
	const ids = p.ids.filter((id) => Oid.isValid(id)).map((id) => new Oid(id))
	if (!ids.length) return []
	const c = await ensureSchema(handle)
	const docs = await c
		.find({ _id: { $in: ids }, scope: p.scope, scopeRef: p.scopeRef })
		.toArray()
	return docs.map((d) => view(d))
}

// ---------------------------------------------------------------- worker

type Tx = Parameters<typeof acceptTaskDecision>[1]

interface Worker {
	handle: WikiDbHandle
	tx: Tx
	running: boolean
	again: boolean
	timer?: ReturnType<typeof setInterval>
}

const workers = new WeakMap<object, Worker>()

/** Runs one job; failures are recorded on the job, never thrown. */
async function runJob(w: Worker, c: Collection, d: Record<string, unknown>) {
	const job = view(d)
	const actor = d.actor as Actor
	const base = {
		scope: job.scope,
		scopeRef: job.scopeRef,
		id: job.suggestionId,
		actor,
	}
	try {
		if (job.kind === "task-suggestion") {
			if (job.action === "accept")
				await acceptTaskDecision(w.handle, w.tx, {
					...base,
					...(typeof d.expectedRevision === "number"
						? { expectedRevision: d.expectedRevision }
						: {}),
					operationId: `decision-${job.id}`,
				})
			else
				await dismissTaskDecision(w.handle, {
					...base,
					...(typeof d.note === "string" ? { note: d.note } : {}),
				})
		} else
			await identityDecision(w.handle, {
				...base,
				...(job.action === "accept" && job.chosen
					? { chosen: job.chosen }
					: {}),
			})
		await c.updateOne(
			{ _id: d._id as ObjectId },
			{ $set: { status: "done", open: false, finishedAt: new Date() } },
		)
	} catch (err) {
		const error =
			err instanceof DecisionError
				? { code: err.code, message: err.message, status: err.status }
				: {
						code: "DECISION_FAILED",
						message: err instanceof Error ? err.message : String(err),
						status: 500,
					}
		await c.updateOne(
			{ _id: d._id as ObjectId },
			{
				$set: { status: "failed", open: false, error, finishedAt: new Date() },
			},
		)
	}
}

async function drain(w: Worker): Promise<void> {
	if (w.running) {
		w.again = true
		return
	}
	w.running = true
	try {
		const c = await ensureSchema(w.handle)
		do {
			w.again = false
			for (;;) {
				const d = await c.findOneAndUpdate(
					{ status: "queued" },
					{
						$set: { status: "running", startedAt: new Date() },
						$inc: { attempts: 1 },
					},
					{ sort: { createdAt: 1 }, returnDocument: "after" },
				)
				if (!d) break
				await runJob(w, c, d)
			}
		} while (w.again)
	} catch {
		// The database is unreachable: the interval tries again.
	} finally {
		w.running = false
	}
}

function kickWorker(handle: WikiDbHandle): void {
	const w = workers.get(handle.db)
	if (w) void drain(w)
}

/** Starts the worker for this database once per process. Jobs a previous
 *  process left running are queued again. */
export async function startDecisionWorker(
	handle: WikiDbHandle,
	tx: Tx,
	opts: { intervalMs?: number } = {},
): Promise<void> {
	if (workers.has(handle.db)) return
	const w: Worker = { handle, tx, running: false, again: false }
	workers.set(handle.db, w)
	const c = await ensureSchema(handle)
	await c.updateMany({ status: "running" }, { $set: { status: "queued" } })
	w.timer = setInterval(() => void drain(w), opts.intervalMs ?? 5_000)
	w.timer.unref?.()
	void drain(w)
}

/** For tests: runs queued jobs now and waits for them. */
export async function drainDecisionsNow(handle: WikiDbHandle): Promise<void> {
	const w = workers.get(handle.db)
	if (w) await drain(w)
}
