// Task suggestions: listing, accepting (an ordinary guarded task edit),
// dismissing, review runs, and who may do which.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sl = vi.hoisted(() => ({
	ensureTaskReviewSchema: vi.fn(),
	listSuggestions: vi.fn(),
	getSuggestion: vi.fn(),
	decideSuggestion: vi.fn(),
	markSuggestionsStale: vi.fn(),
	reviewTask: vi.fn(),
	processQueue: vi.fn(),
	sweep: vi.fn(),
	taskReviewCounts: vi.fn(),
}))
const engine = vi.hoisted(() => ({
	getWikiPage: vi.fn(),
	updateWikiPage: vi.fn(),
	recordWikiMutationIntent: vi.fn(),
	addRelationships: vi.fn(),
}))
const store = vi.hoisted(() => ({
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
}))
const llm = vi.hoisted(() => ({ createTaskJudge: vi.fn() }))

vi.mock("@sqrrl/source-layer", async (orig) => ({
	...(await orig<typeof import("@sqrrl/source-layer")>()),
	...sl,
}))
vi.mock("@sqrrl/wiki-engine", async (orig) => ({
	...(await orig<typeof import("@sqrrl/wiki-engine")>()),
	...engine,
}))
vi.mock("./wiki-store-runtime.js", async (orig) => ({
	...(await orig<typeof import("./wiki-store-runtime.js")>()),
	...store,
}))
vi.mock("./lib/llm-generate.js", async (orig) => ({
	...(await orig<typeof import("./lib/llm-generate.js")>()),
	...llm,
}))

import { LlmNotConfiguredError } from "./lib/llm-generate.js"

const MASTER = "master-token"
const READER = "reader-token"
const HANDLE = { db: {}, prefix: "t_" }
const SCOPE = { scope: "workspace", scopeRef: "default" }
const SUGGESTION = {
	id: "s1",
	...SCOPE,
	taskSlug: "tasks/me-send-deck",
	taskTitle: "Send the deck",
	proposed: "done",
	confidence: 0.9,
	rationale: "sent",
	status: "pending",
	evidence: [
		{
			key: "raw:r1",
			kind: "raw",
			rawItemId: "r1",
			title: "Re: deck",
			quote: "Sent the deck",
			occurredAt: "2026-11-17T09:00:00.000Z",
		},
		{
			key: "page:sources/email/x",
			kind: "page",
			slug: "sources/email/x",
			title: "Deck thread",
			quote: "Sent the deck",
			occurredAt: "2026-11-16T09:00:00.000Z",
		},
	],
}
const TASK = {
	slug: "tasks/me-send-deck",
	kind: "procedure",
	revision: 3,
	taskCard: { owner: "me", status: "open", dueDate: "2026-11-14" },
}

let createApp: typeof import("./app.js").createApp

beforeEach(async () => {
	vi.resetModules()
	process.env.SQRRL_API_KEY = MASTER
	process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
		{
			token: READER,
			subjectId: "reader",
			trustTier: "standard",
			capabilities: ["read"],
			scopes: ["workspace"],
			scopeRefs: ["default"],
			agentIds: ["*"],
		},
	])
	;({ createApp } = await import("./app.js"))
	store.getWikiStoreHandle.mockResolvedValue(HANDLE)
	store.withWikiTransaction.mockImplementation(async (op) =>
		op(HANDLE, "session"),
	)
	sl.getSuggestion.mockResolvedValue(SUGGESTION)
	sl.listSuggestions.mockResolvedValue([SUGGESTION])
	sl.taskReviewCounts.mockResolvedValue({
		suggestions: { pending: 1, accepted: 0, dismissed: 0, stale: 0 },
		queuedSources: 0,
		pendingTasks: 0,
	})
	engine.getWikiPage.mockResolvedValue(TASK)
	engine.updateWikiPage.mockImplementation(async (_h, slug, _s, _r, patch) => ({
		...TASK,
		slug,
		...patch,
		revision: 4,
	}))
	llm.createTaskJudge.mockReturnValue(vi.fn())
})

afterEach(() => {
	delete process.env.SQRRL_API_KEY
	delete process.env.SQRRL_API_SCOPED_KEYS
	vi.clearAllMocks()
})

const req = (method: string, path: string, body?: unknown, token = MASTER) =>
	createApp().request(path, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	})
const json = async (res: Response) => (await res.json()) as Record<string, any>

describe("task suggestions", () => {
	it("lists pending suggestions for a reader", async () => {
		const res = await req(
			"GET",
			"/v1/wiki/task-suggestions?scope=workspace&scopeRef=default",
			undefined,
			READER,
		)
		expect(res.status).toBe(200)
		const out = await json(res)
		expect(out.suggestions).toHaveLength(1)
		expect(out.counts.suggestions.pending).toBe(1)
		expect(sl.listSuggestions).toHaveBeenCalledWith(
			HANDLE,
			expect.objectContaining({ ...SCOPE, status: "pending" }),
		)
	})

	it("accepts: closes the task as the caller, dated by the evidence, linked to the evidence page", async () => {
		const res = await req("POST", "/v1/wiki/task-suggestions/s1/accept", {
			...SCOPE,
			expectedRevision: 3,
		})
		expect(res.status).toBe(200)
		const [, slug, , , patch, opts] = engine.updateWikiPage.mock.calls[0]
		expect(slug).toBe("tasks/me-send-deck")
		expect(patch.taskCard).toEqual({
			owner: "me",
			status: "done",
			dueDate: "2026-11-14",
			completedAt: "2026-11-17T09:00:00.000Z",
		})
		expect(opts).toMatchObject({
			session: "session",
			editor: { id: expect.any(String) },
		})
		expect(engine.recordWikiMutationIntent).toHaveBeenCalled()
		expect(engine.addRelationships).toHaveBeenCalledWith(
			HANDLE,
			"tasks/me-send-deck",
			"workspace",
			"default",
			[
				expect.objectContaining({
					targetPageSlug: "sources/email/x",
					kind: "resolved_by",
				}),
			],
		)
		expect(sl.decideSuggestion).toHaveBeenCalledWith(
			HANDLE,
			SUGGESTION,
			expect.objectContaining({ status: "accepted" }),
		)
	})

	it("refuses to accept over a newer revision, a closed task, or a decided suggestion", async () => {
		expect(
			(
				await req("POST", "/v1/wiki/task-suggestions/s1/accept", {
					...SCOPE,
					expectedRevision: 2,
				})
			).status,
		).toBe(409)
		engine.getWikiPage.mockResolvedValueOnce({
			...TASK,
			taskCard: { status: "done" },
		})
		const closed = await req(
			"POST",
			"/v1/wiki/task-suggestions/s1/accept",
			SCOPE,
		)
		expect(closed.status).toBe(409)
		expect((await json(closed)).error.code).toBe("TASK_NOT_OPEN")
		expect(sl.markSuggestionsStale).toHaveBeenCalled()
		sl.getSuggestion.mockResolvedValueOnce({
			...SUGGESTION,
			status: "dismissed",
		})
		expect(
			(await req("POST", "/v1/wiki/task-suggestions/s1/accept", SCOPE)).status,
		).toBe(409)
		expect(engine.updateWikiPage).not.toHaveBeenCalled()
	})

	it("keeps suggestions inside their scope", async () => {
		const res = await req("POST", "/v1/wiki/task-suggestions/s1/accept", {
			scope: "workspace",
			scopeRef: "other",
		})
		expect(res.status).toBe(404)
	})

	it("dismisses with a note", async () => {
		const res = await req("POST", "/v1/wiki/task-suggestions/s1/dismiss", {
			...SCOPE,
			note: "not the same deck",
		})
		expect(res.status).toBe(200)
		expect(sl.decideSuggestion).toHaveBeenCalledWith(
			HANDLE,
			SUGGESTION,
			expect.objectContaining({
				status: "dismissed",
				note: "not the same deck",
			}),
		)
	})

	it("needs write to accept, dismiss or run a review", async () => {
		for (const path of [
			"/v1/wiki/task-suggestions/s1/accept",
			"/v1/wiki/task-suggestions/s1/dismiss",
			"/v1/wiki/task-review/run",
		]) {
			expect((await req("POST", path, SCOPE, READER)).status, path).toBe(403)
		}
	})
})

describe("task review runs", () => {
	it("reviews one task on demand and processes the queue", async () => {
		sl.reviewTask.mockResolvedValue({ slug: "tasks/x", result: "no-evidence" })
		const one = await req("POST", "/v1/wiki/task-review/task", {
			...SCOPE,
			slug: "tasks/x",
		})
		expect(await json(one)).toMatchObject({
			outcome: { result: "no-evidence" },
		})
		sl.processQueue.mockResolvedValue({ reviewed: 2, suggested: 1, errors: [] })
		const run = await req("POST", "/v1/wiki/task-review/run", {
			...SCOPE,
			limit: 5,
			sourceLimit: 5000,
		})
		expect(await json(run)).toMatchObject({ reviewed: 2, suggested: 1 })
		// sourceLimit is capped; concurrency defaults to 4.
		expect(sl.processQueue).toHaveBeenCalledWith(HANDLE, expect.any(Object), {
			...SCOPE,
			limit: 5,
			sourceLimit: 1000,
			concurrency: 4,
		})
	})

	it("is 503 without an LLM", async () => {
		llm.createTaskJudge.mockImplementation(() => {
			throw new LlmNotConfiguredError("no llm")
		})
		const res = await req("POST", "/v1/wiki/task-review/sweep", SCOPE)
		expect(res.status).toBe(503)
	})
})
