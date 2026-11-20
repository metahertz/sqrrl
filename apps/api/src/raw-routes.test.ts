// Layer 1 routes (/v1/raw/*): validation, error mapping, and that the /v1
// auth middleware scopes them like every other data route.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const source = vi.hoisted(() => ({
	ensureRawItemsSchema: vi.fn(),
	upsertRawItems: vi.fn(),
	searchRawItems: vi.fn(),
	retireMissingRawItems: vi.fn(),
	listCurrentRawItems: vi.fn(),
	distillCalendarEvents: vi.fn(),
}))
const store = vi.hoisted(() => ({
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
}))

vi.mock("@sqrrl/source-layer", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sqrrl/source-layer")>()),
	...source,
}))
vi.mock("./wiki-store-runtime.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wiki-store-runtime.js")>()),
	...store,
}))

import {
	RawItemValidationError,
	RawSearchUnavailableError,
} from "@sqrrl/source-layer"

const MASTER = "master-token"
const READER = "reader-token"
const HANDLE = { db: {}, prefix: "t_" }
const NOTE = { source: "apple-notes", sourceId: "x1", kind: "note", text: "hi" }

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
	delete process.env.VOYAGE_API_KEY
	;({ createApp } = await import("./app.js"))
	store.getWikiStoreHandle.mockResolvedValue(HANDLE)
	store.withWikiTransaction.mockImplementation(async (op) =>
		op(HANDLE, "session-1"),
	)
	source.ensureRawItemsSchema.mockResolvedValue(undefined)
})

afterEach(() => {
	process.env.SQRRL_API_KEY = undefined
	process.env.SQRRL_API_SCOPED_KEYS = undefined
	delete process.env.VOYAGE_API_KEY
	vi.clearAllMocks()
})

function post(path: string, body: unknown, token = MASTER) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	})
}

describe("POST /v1/raw/items", () => {
	it("writes the batch under the request scope, as the caller, in transactions", async () => {
		source.upsertRawItems.mockImplementation(
			async (_h, items, _opts, runInTransaction) => {
				// The route must hand the store a working transaction runner.
				expect(await runInTransaction(async (s: unknown) => s)).toBe(
					"session-1",
				)
				return items.map((_: unknown, i: number) => ({
					source: "apple-notes",
					sourceId: `x${i}`,
					version: 1,
					status: i === 0 ? "created" : "unchanged",
					id: `id${i}`,
				}))
			},
		)
		const res = await post("/v1/raw/items", {
			scope: "workspace",
			scopeRef: "default",
			items: [NOTE, { ...NOTE, sourceId: "x2" }],
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			scope: "workspace",
			scopeRef: "default",
			created: 1,
			updated: 0,
			unchanged: 1,
		})
		const [handle, items, opts] = source.upsertRawItems.mock.calls[0]
		expect(handle).toBe(HANDLE)
		expect(items).toHaveLength(2)
		expect(opts).toMatchObject({ scope: "workspace", scopeRef: "default" })
		expect(typeof opts.writer).toBe("string")
		expect(source.ensureRawItemsSchema).toHaveBeenCalledWith({}, "t_")
	})

	it("rejects a bad scope, a missing batch and invalid items with 400", async () => {
		for (const body of [
			{ scope: "planet", scopeRef: "default", items: [NOTE] },
			{ scope: "workspace", scopeRef: " ", items: [NOTE] },
			{ scope: "workspace", scopeRef: "default", items: "nope" },
		]) {
			expect((await post("/v1/raw/items", body)).status).toBe(400)
		}
		source.upsertRawItems.mockRejectedValue(
			new RawItemValidationError("items[0]: kind must be one of note|file"),
		)
		const res = await post("/v1/raw/items", {
			scope: "workspace",
			scopeRef: "default",
			items: [NOTE],
		})
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({
			error: {
				code: "VALIDATION_ERROR",
				message: expect.stringMatching(/items\[0\]/),
			},
		})
	})

	it("refuses a read-only key", async () => {
		const res = await post(
			"/v1/raw/items",
			{ scope: "workspace", scopeRef: "default", items: [NOTE] },
			READER,
		)
		expect(res.status).toBe(403)
		expect(source.upsertRawItems).not.toHaveBeenCalled()
	})
})

describe("POST /v1/raw/search", () => {
	const HIT = {
		item: { sourceId: "x1", text: "hi" },
		score: 0.1,
		reranked: false,
	}

	it("lets a scoped reader search its own scope and forwards the filters", async () => {
		source.searchRawItems.mockResolvedValue([HIT])
		const res = await post(
			"/v1/raw/search",
			{
				query: "  oidc  ",
				scope: "workspace",
				scopeRef: "default",
				kind: "message",
				channel: "#eng",
				from: "2026-11-01",
				limit: 5,
				includeHistory: true,
			},
			READER,
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ rerank: "off", results: [HIT] })
		expect(source.searchRawItems.mock.calls[0][1]).toMatchObject({
			query: "oidc",
			scope: "workspace",
			scopeRef: "default",
			kind: "message",
			channel: "#eng",
			from: "2026-11-01",
			limit: 5,
			includeHistory: true,
			rerank: undefined,
		})
	})

	it("refuses a scoped reader outside its scope", async () => {
		const res = await post(
			"/v1/raw/search",
			{ query: "q", scope: "workspace", scopeRef: "someone-else" },
			READER,
		)
		expect(res.status).toBe(403)
		expect(source.searchRawItems).not.toHaveBeenCalled()
	})

	it("reports whether rerank was off, unavailable, applied or failed", async () => {
		const body = {
			query: "q",
			scope: "workspace",
			scopeRef: "default",
			rerank: true,
		}
		source.searchRawItems.mockResolvedValue([HIT, HIT])
		expect(await (await post("/v1/raw/search", body)).json()).toMatchObject({
			rerank: "unavailable",
		})
		expect(source.searchRawItems.mock.calls[0][1].rerank).toBeUndefined()

		process.env.VOYAGE_API_KEY = "al-test"
		expect(await (await post("/v1/raw/search", body)).json()).toMatchObject({
			rerank: "failed",
		})
		expect(typeof source.searchRawItems.mock.calls[1][1].rerank).toBe(
			"function",
		)

		source.searchRawItems.mockResolvedValue([{ ...HIT, reranked: true }, HIT])
		expect(await (await post("/v1/raw/search", body)).json()).toMatchObject({
			rerank: "applied",
		})
		source.searchRawItems.mockResolvedValue([HIT])
		expect(await (await post("/v1/raw/search", body)).json()).toMatchObject({
			rerank: "skipped",
		})
	})

	it("maps an outage to 503 and bad input to 400", async () => {
		source.searchRawItems.mockRejectedValue(new RawSearchUnavailableError())
		const down = await post("/v1/raw/search", {
			query: "q",
			scope: "workspace",
			scopeRef: "default",
		})
		expect(down.status).toBe(503)
		expect(await down.json()).toMatchObject({
			error: { code: "SEARCH_UNAVAILABLE" },
		})
		for (const body of [
			{ query: " ", scope: "workspace", scopeRef: "default" },
			{ query: "q", scope: "workspace", scopeRef: "default", kind: "tweet" },
		]) {
			expect((await post("/v1/raw/search", body)).status).toBe(400)
		}
	})
})

describe("POST /v1/raw/sync", () => {
	const WINDOW = { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }
	const EVENT = {
		source: "calendar",
		sourceId: "e1",
		kind: "event",
		text: "Standup",
		occurredAt: "2026-11-10T09:00:00Z",
	}
	const SYNC = {
		scope: "workspace",
		scopeRef: "default",
		source: "calendar",
		window: WINDOW,
		items: [EVENT],
	}
	const receipt = (sourceId: string, status: string) => ({
		source: "calendar",
		sourceId,
		version: 1,
		status,
		id: `id-${sourceId}`,
	})

	beforeEach(() => {
		source.upsertRawItems.mockResolvedValue([receipt("e1", "created")])
		source.retireMissingRawItems.mockResolvedValue([receipt("gone", "updated")])
		source.listCurrentRawItems.mockImplementation(async (_h, p) =>
			p.sourceIds.map((id: string) => ({ sourceId: id, kind: "event" })),
		)
		source.distillCalendarEvents.mockResolvedValue({
			created: 1,
			updated: 0,
			cancelled: 1,
			peopleCreated: 0,
			peopleLinked: 0,
			transcriptsLinked: 0,
			errors: [],
		})
	})

	it("writes, retires the rest of the window, and distills what changed", async () => {
		const res = await post("/v1/raw/sync", SYNC)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			created: 1,
			retired: 1,
			distilled: { meetings: { created: 1, cancelled: 1 }, undistilled: 0 },
		})
		expect(source.retireMissingRawItems).toHaveBeenCalledWith(
			HANDLE,
			expect.objectContaining({
				source: "calendar",
				from: new Date(WINDOW.from),
				to: new Date(WINDOW.to),
				presentIds: ["e1"],
				writer: expect.any(String),
			}),
			expect.any(Function),
		)
		expect(source.listCurrentRawItems).toHaveBeenCalledWith(HANDLE, {
			scope: "workspace",
			scopeRef: "default",
			source: "calendar",
			sourceIds: ["e1", "gone"],
		})
	})

	it("skips unchanged items unless asked to redistill", async () => {
		source.upsertRawItems.mockResolvedValue([receipt("e1", "unchanged")])
		source.retireMissingRawItems.mockResolvedValue([])
		await post("/v1/raw/sync", SYNC)
		expect(source.distillCalendarEvents).not.toHaveBeenCalled()
		await post("/v1/raw/sync", { ...SYNC, redistill: true })
		expect(source.distillCalendarEvents).toHaveBeenCalledTimes(1)
	})

	it("accepts an empty window, which retires everything in it", async () => {
		const res = await post("/v1/raw/sync", { ...SYNC, items: [] })
		expect(res.status).toBe(200)
		expect(source.upsertRawItems).not.toHaveBeenCalled()
		expect(source.retireMissingRawItems).toHaveBeenCalledWith(
			HANDLE,
			expect.objectContaining({ presentIds: [] }),
			expect.any(Function),
		)
	})

	it("retires nothing without a window", async () => {
		await post("/v1/raw/sync", { ...SYNC, window: undefined })
		expect(source.retireMissingRawItems).not.toHaveBeenCalled()
	})

	it("rejects items from another source or outside the window", async () => {
		for (const body of [
			{ ...SYNC, items: [{ ...EVENT, source: "slack" }] },
			{ ...SYNC, items: [{ ...EVENT, occurredAt: "2026-12-01T00:00:00Z" }] },
			{ ...SYNC, items: [{ ...EVENT, occurredAt: undefined }] },
			{ ...SYNC, window: { from: WINDOW.to, to: WINDOW.from } },
			{ ...SYNC, source: "" },
		]) {
			const res = await post("/v1/raw/sync", body)
			expect(res.status, JSON.stringify(body)).toBe(400)
		}
		expect(source.upsertRawItems).not.toHaveBeenCalled()
	})

	it("scopes retirement to one channel and can spare replies", async () => {
		const item = { ...EVENT, source: "slack", channel: "general" }
		await post("/v1/raw/sync", {
			...SYNC,
			source: "slack",
			channel: "general",
			excludeReplies: true,
			items: [item],
		})
		expect(source.retireMissingRawItems).toHaveBeenCalledWith(
			HANDLE,
			expect.objectContaining({ channel: "general", excludeReplies: true }),
			expect.any(Function),
		)
		const res = await post("/v1/raw/sync", {
			...SYNC,
			source: "slack",
			channel: "general",
			items: [{ ...item, channel: "random" }],
		})
		expect(res.status).toBe(400)
	})

	it("needs the write capability", async () => {
		const res = await post("/v1/raw/sync", SYNC, READER)
		expect(res.status).toBe(403)
	})
})
