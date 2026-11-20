// The decision queue over an in-memory collection: queue once per
// suggestion, run in order as the person who clicked, record failures on the
// job, and pick up jobs a previous process left running.

import { ObjectId } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const decisions = vi.hoisted(() => ({
	acceptTaskDecision: vi.fn(),
	dismissTaskDecision: vi.fn(),
	identityDecision: vi.fn(),
	pendingTaskSuggestion: vi.fn(),
}))
vi.mock("./decisions.js", async (orig) => ({
	...(await orig<typeof import("./decisions.js")>()),
	...decisions,
}))
const sl = vi.hoisted(() => ({ getIdentitySuggestion: vi.fn() }))
vi.mock("@sqrrl/source-layer", async (orig) => ({
	...(await orig<typeof import("@sqrrl/source-layer")>()),
	...sl,
}))

import {
	drainDecisionsNow,
	enqueueDecision,
	getDecisionJobs,
	startDecisionWorker,
} from "./decision-queue.js"
import { DecisionError } from "./decisions.js"

type Doc = Record<string, unknown> & { _id: ObjectId }

/** Just the collection calls the queue makes. */
function fakeCollection() {
	const docs: Doc[] = []
	const match = (d: Doc, f: Record<string, unknown>) =>
		Object.entries(f).every(([k, v]) => {
			if (k === "_id" && v && typeof v === "object" && "$in" in v)
				return (v.$in as ObjectId[]).some((id) => id.equals(d._id))
			if (k === "_id") return (v as ObjectId).equals(d._id)
			return d[k] === v
		})
	return {
		docs,
		createIndex: async () => "ok",
		findOne: async (f: Record<string, unknown>) =>
			docs.find((d) => match(d, f)) ?? null,
		insertOne: async (doc: Record<string, unknown>) => {
			const _id = new ObjectId()
			docs.push({ ...doc, _id })
			return { insertedId: _id }
		},
		find: (f: Record<string, unknown>) => ({
			toArray: async () => docs.filter((d) => match(d, f)),
		}),
		findOneAndUpdate: async (
			f: Record<string, unknown>,
			u: { $set: Record<string, unknown> },
		) => {
			const d = docs
				.filter((x) => match(x, f))
				.sort((a, b) => +(a.createdAt as Date) - +(b.createdAt as Date))[0]
			if (!d) return null
			Object.assign(d, u.$set)
			return d
		},
		updateOne: async (
			f: Record<string, unknown>,
			u: { $set: Record<string, unknown> },
		) => {
			const d = docs.find((x) => match(x, f))
			if (d) Object.assign(d, u.$set)
		},
		updateMany: async (
			f: Record<string, unknown>,
			u: { $set: Record<string, unknown> },
		) => {
			for (const d of docs.filter((x) => match(x, f))) Object.assign(d, u.$set)
		},
	}
}

const ACTOR = {
	subjectId: "writer",
	governance: { trustTier: "standard" },
} as never
const SCOPE = { scope: "workspace", scopeRef: "default" }
const tx = (async (op: (h: unknown, s: unknown) => unknown) =>
	op({}, "s")) as never

let coll: ReturnType<typeof fakeCollection>
let handle: never

beforeEach(async () => {
	vi.clearAllMocks()
	coll = fakeCollection()
	handle = { db: { collection: () => coll }, prefix: "t_" } as never
	decisions.pendingTaskSuggestion.mockResolvedValue({ id: "s1" })
	sl.getIdentitySuggestion.mockResolvedValue({
		status: "pending",
		candidates: [{ slug: "people/a" }],
	})
	await startDecisionWorker(handle, tx, { intervalMs: 60_000 })
})

describe("decision queue", () => {
	it("queues once per suggestion and runs it as the person who clicked", async () => {
		const input = {
			...SCOPE,
			kind: "task-suggestion" as const,
			suggestionId: "s1",
			action: "accept" as const,
		}
		const first = await enqueueDecision(handle, input, ACTOR)
		const again = await enqueueDecision(handle, input, ACTOR)
		expect(again.existing).toBe(true)
		expect(again.job.id).toBe(first.job.id)
		await drainDecisionsNow(handle)
		expect(decisions.acceptTaskDecision).toHaveBeenCalledTimes(1)
		expect(decisions.acceptTaskDecision).toHaveBeenCalledWith(handle, tx, {
			...SCOPE,
			id: "s1",
			actor: ACTOR,
			operationId: `decision-${first.job.id}`,
		})
		const [job] = await getDecisionJobs(handle, {
			...SCOPE,
			ids: [first.job.id],
		})
		expect(job.status).toBe("done")
	})

	it("records a failure on the job, with the direct route's code", async () => {
		decisions.identityDecision.mockRejectedValue(
			new DecisionError(409, "IDENTITY_GONE", "people/a no longer exists"),
		)
		const { job } = await enqueueDecision(
			handle,
			{
				...SCOPE,
				kind: "identity-suggestion",
				suggestionId: "q1",
				action: "accept",
				chosen: "people/a",
			},
			ACTOR,
		)
		await drainDecisionsNow(handle)
		const [done] = await getDecisionJobs(handle, { ...SCOPE, ids: [job.id] })
		expect(done).toMatchObject({
			status: "failed",
			error: { code: "IDENTITY_GONE", status: 409 },
		})
		// A failed job no longer blocks a new attempt.
		const retry = await enqueueDecision(
			handle,
			{
				...SCOPE,
				kind: "identity-suggestion",
				suggestionId: "q1",
				action: "dismiss",
			},
			ACTOR,
		)
		expect(retry.existing).toBe(false)
	})

	it("fails at once what it can check now", async () => {
		decisions.pendingTaskSuggestion.mockRejectedValue(
			new DecisionError(
				409,
				"SUGGESTION_DECIDED",
				"suggestion is already accepted",
			),
		)
		await expect(
			enqueueDecision(
				handle,
				{
					...SCOPE,
					kind: "task-suggestion",
					suggestionId: "s9",
					action: "dismiss",
				},
				ACTOR,
			),
		).rejects.toMatchObject({ code: "SUGGESTION_DECIDED" })
		await expect(
			enqueueDecision(
				handle,
				{
					...SCOPE,
					kind: "identity-suggestion",
					suggestionId: "q2",
					action: "accept",
					chosen: "people/zz",
				},
				ACTOR,
			),
		).rejects.toMatchObject({ code: "IDENTITY_BAD_CHOICE" })
		expect(coll.docs).toHaveLength(0)
	})

	it("runs jobs a previous process left running", async () => {
		const other = fakeCollection()
		other.docs.push({
			_id: new ObjectId(),
			...SCOPE,
			kind: "task-suggestion",
			suggestionId: "s5",
			action: "dismiss",
			actor: ACTOR,
			status: "running",
			open: true,
			createdAt: new Date(),
		})
		const h2 = { db: { collection: () => other }, prefix: "t_" } as never
		await startDecisionWorker(h2, tx, { intervalMs: 60_000 })
		await drainDecisionsNow(h2)
		expect(decisions.dismissTaskDecision).toHaveBeenCalledOnce()
		expect(other.docs[0].status).toBe("done")
	})
})
