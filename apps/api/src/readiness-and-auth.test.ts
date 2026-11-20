// Readiness and scoped-key authorization, driven through the wiki and raw
// routes. These cases used to ride on the memory routes (/v1/search,
// /v1/add); they moved here when memongo was retired (roadmap, Phase 3).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
	checkWikiStoreReadiness: vi.fn(),
}))
const engine = vi.hoisted(() => ({ searchWikiPages: vi.fn() }))
const source = vi.hoisted(() => ({
	ensureRawItemsSchema: vi.fn(),
	upsertRawItems: vi.fn(),
	searchRawItems: vi.fn(),
}))
const raw = vi.hoisted(() => ({ checkRawStoreReadiness: vi.fn() }))

vi.mock("./wiki-store-runtime.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wiki-store-runtime.js")>()),
	...store,
}))
vi.mock("@sqrrl/wiki-engine", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sqrrl/wiki-engine")>()),
	...engine,
}))
vi.mock("@sqrrl/source-layer", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sqrrl/source-layer")>()),
	...source,
}))
vi.mock("./routes/raw.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./routes/raw.js")>()),
	...raw,
}))

const HANDLE = { db: {}, prefix: "t_" }
let createApp: typeof import("./app.js").createApp

beforeEach(async () => {
	vi.resetModules()
	delete process.env.SQRRL_API_KEY
	delete process.env.SQRRL_API_SCOPED_KEYS
	;({ createApp } = await import("./app.js"))
	store.getWikiStoreHandle.mockResolvedValue(HANDLE)
	store.withWikiTransaction.mockImplementation(async (op) => op(HANDLE, {}))
	store.checkWikiStoreReadiness.mockResolvedValue({
		transactional: true,
		search: true,
	})
	raw.checkRawStoreReadiness.mockResolvedValue({ search: true })
	engine.searchWikiPages.mockResolvedValue({
		results: [],
		total: 0,
		recipe: "hybrid",
		mode: "hybrid",
	})
	source.upsertRawItems.mockResolvedValue([])
})

afterEach(() => {
	delete process.env.SQRRL_API_KEY
	delete process.env.SQRRL_API_SCOPED_KEYS
	vi.clearAllMocks()
})

function scopedKeys(keys: unknown[]) {
	process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify(keys)
}

function post(path: string, token: string, body: Record<string, unknown>) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	})
}

const search = (token: string, scope: string, scopeRef: string, extra = {}) =>
	post("/v1/wiki/search", token, { query: "q", scope, scopeRef, ...extra })

describe("/ready", () => {
	it("is ready when the wiki and raw stores are, and no longer reports memongo", async () => {
		const res = await createApp().request("/ready")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ok: true,
			service: "sqrrl-api",
			wiki: { transactional: true, search: true },
			raw: { search: true },
		})
	})

	it("coalesces and briefly caches readiness probes", async () => {
		const app = createApp()
		const [first, second] = await Promise.all([
			app.request("/ready"),
			app.request("/ready"),
		])
		const third = await app.request("/ready")
		expect([first.status, second.status, third.status]).toEqual([200, 200, 200])
		expect(store.checkWikiStoreReadiness).toHaveBeenCalledTimes(1)
		expect(raw.checkRawStoreReadiness).toHaveBeenCalledTimes(1)
	})

	it("names the dependency that is not ready", async () => {
		const cases: Array<[() => void, string[]]> = [
			// Ping + transactions can succeed while mongot is dead, so the wiki
			// check probes search; either failure lands here.
			[
				() =>
					store.checkWikiStoreReadiness.mockRejectedValueOnce(new Error("x")),
				["wiki"],
			],
			[
				() => raw.checkRawStoreReadiness.mockRejectedValueOnce(new Error("x")),
				["raw"],
			],
			[
				() => {
					store.checkWikiStoreReadiness.mockRejectedValueOnce(new Error("x"))
					raw.checkRawStoreReadiness.mockRejectedValueOnce(new Error("x"))
				},
				["wiki", "raw"],
			],
		]
		for (const [arrange, dependencies] of cases) {
			arrange()
			const res = await createApp().request("/ready")
			expect(res.status).toBe(503)
			expect(await res.json()).toEqual({
				ok: false,
				service: "sqrrl-api",
				error: {
					code: "DEPENDENCY_NOT_READY",
					message: "The wiki or raw item store is not ready",
					dependencies,
				},
			})
		}
	})
})

describe("scoped API key authorization", () => {
	it("allows a scoped key inside its scope policy and passes the scope through", async () => {
		scopedKeys([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["team-a"],
			},
		])
		const res = await search("scoped-secret", "workspace", "team-a", {
			agentId: "codex",
		})
		expect(res.status).toBe(200)
		expect(engine.searchWikiPages.mock.calls[0][1]).toMatchObject({
			scope: "workspace",
			scopeRef: "team-a",
		})
		expect((await search("scoped-secret", "workspace", "team-b")).status).toBe(
			403,
		)
		expect(engine.searchWikiPages).toHaveBeenCalledTimes(1)
	})

	it("enforces server-assigned capabilities by route", async () => {
		scopedKeys([
			{
				token: "read-only-secret",
				subjectId: "service:reader",
				scopes: ["workspace"],
				scopeRefs: ["team-a"],
				capabilities: ["read"],
			},
		])
		expect(
			(await search("read-only-secret", "workspace", "team-a")).status,
		).toBe(200)
		const write = await post("/v1/raw/items", "read-only-secret", {
			scope: "workspace",
			scopeRef: "team-a",
			items: [{ source: "s", sourceId: "1", kind: "note", text: "t" }],
		})
		expect(write.status).toBe(403)
		expect(await write.json()).toEqual({
			error: {
				code: "FORBIDDEN",
				message: "capability is not allowed for this API key",
			},
		})
		expect(source.upsertRawItems).not.toHaveBeenCalled()
	})

	it("keeps SQRRL_API_KEY as the admin key when scoped keys are configured", async () => {
		process.env.SQRRL_API_KEY = "admin-secret"
		scopedKeys([
			{
				token: "scoped-secret",
				scopes: ["workspace"],
				scopeRefs: ["team-a"],
			},
		])
		const res = await search("admin-secret", "user", "someone")
		expect(res.status).toBe(200)
		expect(engine.searchWikiPages.mock.calls[0][1]).toMatchObject({
			scope: "user",
			scopeRef: "someone",
		})
	})

	it("rejects the scope kinds removed from the set, even for the admin key", async () => {
		process.env.SQRRL_API_KEY = "admin-secret"
		for (const kind of ["session", "agent", "tenant", "global"]) {
			const res = await search("admin-secret", kind, "x")
			expect(res.status, kind).toBe(400)
		}
		expect(engine.searchWikiPages).not.toHaveBeenCalled()
	})

	it("honors exact pair grants without the Cartesian cross product", async () => {
		scopedKeys([
			{
				token: "pair-secret",
				grants: [
					{ scope: "workspace", scopeRef: "ws:a" },
					{ scope: "user", scopeRef: "ws:b" },
				],
			},
		])
		expect((await search("pair-secret", "workspace", "ws:a")).status).toBe(200)
		expect((await search("pair-secret", "user", "ws:b")).status).toBe(200)
		expect((await search("pair-secret", "workspace", "ws:b")).status).toBe(403)
	})

	it("keeps the documented Cartesian semantics for scope arrays", async () => {
		scopedKeys([
			{
				token: "cartesian-secret",
				scopes: ["workspace", "user"],
				scopeRefs: ["ws:a", "ws:b"],
			},
		])
		// (workspace, ws:b) is granted: arrays expand to the full cross product.
		expect((await search("cartesian-secret", "workspace", "ws:b")).status).toBe(
			200,
		)
	})
})

describe("request body limit", () => {
	afterEach(() => {
		delete process.env.SQRRL_API_MAX_BODY_BYTES
	})

	it("rejects an oversized body with a JSON 413 the clients can show", async () => {
		process.env.SQRRL_API_KEY = "admin-secret"
		process.env.SQRRL_API_MAX_BODY_BYTES = "1024"
		const res = await post("/v1/raw/mail", "admin-secret", {
			scope: "workspace",
			scopeRef: "default",
			messages: [{ content: "x".repeat(4096) }],
		})
		expect(res.status).toBe(413)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE")
		expect(body.error.message).toMatch(/1024-byte limit/)
	})
})
