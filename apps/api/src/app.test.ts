import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import contractFixtures from "./__fixtures__/contract-fixtures.js"

const wikiStoreMocks = vi.hoisted(() => ({
	checkWikiStoreReadiness: vi.fn(),
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
	closeWikiStore: vi.fn(),
}))

vi.mock("./wiki-store-runtime.js", () => wikiStoreMocks)

import { createApp } from "./app.js"

describe("createApp", () => {
	const prevEnv = { ...process.env }

	beforeEach(() => {
		process.env = { ...prevEnv }
		wikiStoreMocks.checkWikiStoreReadiness.mockReset()
		wikiStoreMocks.checkWikiStoreReadiness.mockResolvedValue({
			transactional: true,
		})
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	it("returns the public health payload", async () => {
		const res = await createApp().request("/health")

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			ok: true,
			service: "sqrrl-api",
		})
	})

	it("serves the OpenAPI document without auth", async () => {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as { paths?: Record<string, unknown> }

		expect(res.status).toBe(200)
		for (const path of contractFixtures.corePaths) {
			expect(json.paths).toHaveProperty(path)
		}
		for (const path of [
			"/ready",
			"/v1/wiki/revisions",
			"/v1/wiki/revisions/{revision}",
		]) {
			expect(json.paths).toHaveProperty(path)
		}
		for (const path of [
			"/v1/import/conversations",
			"/v1/read-file",
			"/v1/status/detailed",
			"/v1/stats",
			"/v1/sync",
			"/v1/admin/relevance/explain",
			"/v1/admin/relevance/benchmark",
			"/v1/admin/benchmarks/ingest",
			"/v1/admin/relevance/report",
			"/v1/admin/relevance/sample-rate",
			"/v1/admin/access-trends",
			"/v1/admin/traces",
			"/v1/admin/traces/{traceId}",
			"/v1/admin/access-summaries",
			"/v1/jobs",
			"/v1/jobs/{jobId}",
			"/v1/chain-trace",
			"/v1/novelty-scan",
			"/v1/consolidate",
			"/v1/self-edit",
		]) {
			expect(json.paths).not.toHaveProperty(path)
		}
		for (const path of contractFixtures.removedTenantControlPaths) {
			expect(json.paths).not.toHaveProperty(path)
		}
	})

	it("does not expose the old control operations to authenticated tenants", async () => {
		process.env.SQRRL_API_KEY = "secret"

		for (const path of [
			"/v1/status",
			"/v1/probes/embedding",
			"/v1/probes/vector",
		]) {
			const response = await createApp().request(path, {
				headers: { Authorization: "Bearer secret" },
			})
			expect(response.status).toBe(404)
		}
	})

	it("logs a prominent warning once when API auth is disabled", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			createApp()
			createApp()

			expect(warn).toHaveBeenCalledTimes(1)
			expect(warn.mock.calls[0]?.[0]).toContain(
				"routes run as the unauthenticated development principal",
			)
		} finally {
			warn.mockRestore()
		}
	})

	it("does not warn when admin or scoped API auth is configured", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			process.env.SQRRL_API_KEY = "secret"
			createApp()
			process.env.SQRRL_API_KEY = ""
			process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
				{ token: "scoped-secret", agentIds: ["agent"] },
			])
			createApp()

			expect(warn).not.toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("registers a graceful shutdown handler that runs bridge close on SIGTERM/SIGINT (bridge shutdown part 2)", async () => {
		const { registerGracefulShutdown } = await import("./app.js")
		expect(typeof registerGracefulShutdown).toBe("function")

		const emitter = new (await import("node:events")).EventEmitter()
		const shutdownCalls: string[] = []
		const closeStores = vi.fn(async () => {
			shutdownCalls.push("bridge-closed")
		})
		const closeServer = vi.fn(async () => {
			shutdownCalls.push("server-closed")
		})
		const exit = vi.fn()

		registerGracefulShutdown({
			signals: ["SIGTERM", "SIGINT"],
			process: emitter as unknown as NodeJS.Process,
			closeStores,
			closeServer,
			exit,
			timeoutMs: 50,
		})

		// Emit SIGTERM — expect closeStores and closeServer both called, process.exit(0).
		emitter.emit("SIGTERM")
		// Handler is async; give it a tick to run.
		await new Promise((r) => setTimeout(r, 10))
		expect(closeStores).toHaveBeenCalledOnce()
		expect(closeServer).toHaveBeenCalledOnce()
		expect(exit).toHaveBeenCalledWith(0)
		expect(shutdownCalls).toEqual(["server-closed", "bridge-closed"])
	})

	it("shutdown forces exit(1) when close handlers exceed the timeout (bridge shutdown part 2)", async () => {
		const { registerGracefulShutdown } = await import("./app.js")
		const emitter = new (await import("node:events")).EventEmitter()

		// closeStores hangs past the timeout.
		const closeStores = vi.fn(
			() => new Promise<void>((resolve) => setTimeout(resolve, 500)),
		)
		const closeServer = vi.fn(async () => {})
		const exit = vi.fn()

		registerGracefulShutdown({
			signals: ["SIGTERM"],
			process: emitter as unknown as NodeJS.Process,
			closeStores,
			closeServer,
			exit,
			timeoutMs: 20,
		})

		emitter.emit("SIGTERM")
		// Wait past the timeout.
		await new Promise((r) => setTimeout(r, 60))
		expect(exit).toHaveBeenCalledWith(1)
	})

	it("compares bearer tokens in constant time (MED timing-safe)", async () => {
		// Behavioral regression: rejection must hold for tokens of the same length
		// AND different length; the implementation must not short-circuit on length
		// alone (which would leak length via timing). Both must reject with 401.
		const { timingSafeBearerEquals } = await import("./app.js")
		expect(typeof timingSafeBearerEquals).toBe("function")

		// Exact match.
		expect(
			timingSafeBearerEquals("supersecret-token", "supersecret-token"),
		).toBe(true)

		// Same length, one char off — rejects.
		expect(
			timingSafeBearerEquals("supersecret-token", "supersecret-tokeX"),
		).toBe(false)

		// Different length — rejects without throwing.
		expect(timingSafeBearerEquals("short", "supersecret-token")).toBe(false)
		expect(timingSafeBearerEquals("supersecret-token", "short")).toBe(false)

		// Empty inputs — rejects (never accept empty bearer).
		expect(timingSafeBearerEquals("", "any")).toBe(false)
		expect(timingSafeBearerEquals("any", "")).toBe(false)
		expect(timingSafeBearerEquals("", "")).toBe(false)
	})

	it("fails closed when scoped API key policy JSON is invalid", () => {
		process.env.SQRRL_API_SCOPED_KEYS = "not-json"

		expect(() => createApp()).toThrow(
			"SQRRL_API_SCOPED_KEYS must be valid JSON",
		)
	})

	it("fails closed when scoped API key policies are unconstrained", () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-secret" },
		])

		expect(() => createApp()).toThrow(
			"SQRRL_API_SCOPED_KEYS policy at index 0 must constrain agentIds, scopes, scopeRefs, or grants",
		)
	})

	it("rejects an invalid canonical scope before any route", async () => {
		process.env.SQRRL_API_KEY = "admin-secret"

		const res = await createApp().request(
			"/v1/search?agentId=codex&scope=project&scopeRef=%2Fworkspace%2Fsqrrl",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer admin-secret",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query: "invalid canonical scope" }),
			},
		)

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "scope must be workspace|user",
			},
		})
	})

	it("rejects JSON bodies sent with a non-JSON content type before any route", async () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/sqrrl"],
			},
		])

		const res = await createApp().request(
			"/v1/search?agentId=codex&scope=workspace&scopeRef=%2Fworkspace%2Fsqrrl",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-secret",
					"Content-Type": "text/plain",
				},
				body: JSON.stringify({
					query: "scope bypass",
					agentId: "codex",
					scope: "workspace",
					scopeRef: "/workspace/other",
				}),
			},
		)

		expect(res.status).toBe(415)
	})

	it("rejects request bodies without a JSON content type before any route", async () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/sqrrl"],
			},
		])
		const request = new Request(
			"http://localhost/v1/search?agentId=codex&scope=workspace&scopeRef=%2Fworkspace%2Fsqrrl",
			{
				method: "POST",
				headers: { Authorization: "Bearer scoped-secret" },
				body: new TextEncoder().encode(
					JSON.stringify({
						query: "scope bypass",
						agentId: "codex",
						scope: "workspace",
						scopeRef: "/workspace/other",
					}),
				),
			},
		)

		const res = await createApp().request(request)

		expect(res.status).toBe(415)
	})

	it("rejects scoped API keys outside their allowed scopeRef", async () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/sqrrl"],
			},
		])

		const res = await createApp().request("/v1/wiki/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/other",
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "scopeRef is not allowed for this API key",
			},
		})
	})

	it("rejects conflicting query and body scope before any route", async () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace", "user"],
				scopeRefs: ["/workspace/sqrrl", "tenant-2"],
				capabilities: ["read"],
			},
		])

		const res = await createApp().request(
			"/v1/search?agentId=codex&scope=workspace&scopeRef=%2Fworkspace%2Fsqrrl",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-secret",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query: "conflicting scope",
					agentId: "codex",
					scope: "user",
					scopeRef: "tenant-2",
				}),
			},
		)

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "conflicting scope values are not allowed",
			},
		})
	})

	it("rejects conflicting top-level and nested scoped authority", async () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/sqrrl"],
				capabilities: ["write"],
			},
		])

		const res = await createApp().request("/v1/raw/items", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/sqrrl",
				handle: {
					family: "structured",
					id: "structured:other",
					agentId: "other-agent",
					scope: "user",
					scopeRef: "other-tenant",
					revision: 1,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				patch: { value: "forbidden" },
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "conflicting agentId values are not allowed",
			},
		})
	})

	it("requires explicit scoped fields for scoped API keys", async () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/sqrrl"],
			},
		])

		const res = await createApp().request("/v1/wiki/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "scope is required for this API key",
			},
		})
	})

	it.each([
		["POST", "/v1/read-file"],
		["GET", "/v1/status/detailed"],
		["GET", "/v1/stats"],
		["POST", "/v1/sync"],
		["POST", "/v1/admin/relevance/explain"],
		["POST", "/v1/admin/relevance/benchmark"],
		["GET", "/v1/admin/relevance/report"],
		["GET", "/v1/admin/relevance/sample-rate"],
		["POST", "/v1/admin/benchmarks/ingest"],
		["POST", "/v1/import/conversations"],
		["GET", "/v1/admin/access-trends"],
		["GET", "/v1/admin/access-summaries"],
		["POST", "/v1/chain-trace"],
		["POST", "/v1/novelty-scan"],
		["POST", "/v1/consolidate"],
		["POST", "/v1/self-edit"],
		["GET", "/v1/admin/traces"],
		["GET", "/v1/admin/traces/trace-1"],
		["GET", "/v1/jobs"],
		["GET", "/v1/jobs/job-1"],
		["POST", "/v1/wiki/maintain"],
	])("does not expose unsupported operation %s %s", async (method, path) => {
		const res = await createApp().request(path, { method })
		expect(res.status).toBe(404)
	})

	it("rejects invalid scope values before any route", async () => {
		const res = await createApp().request("/v1/wiki/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "scoped launch note",
				scope: "project",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "scope must be workspace|user",
			},
		})
	})

	it("refuses the fail-open development principal without explicit opt-in", () => {
		delete process.env.SQRRL_ALLOW_DEV_PRINCIPAL
		expect(() => createApp()).toThrow(/SQRRL_ALLOW_DEV_PRINCIPAL/)
	})

	it("still refuses unauthenticated routes in production even with opt-in", () => {
		process.env.NODE_ENV = "production"
		process.env.SQRRL_ALLOW_DEV_PRINCIPAL = "1"
		expect(() => createApp()).toThrow(/production mode/)
	})

	it("rejects duplicate scoped-key tokens at startup", () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{ token: "dup-secret", agentIds: ["a"] },
			{ token: "dup-secret", agentIds: ["b"] },
		])
		expect(() => createApp()).toThrow(
			"SQRRL_API_SCOPED_KEYS must use unique tokens",
		)
	})

	it("rejects an admin token that duplicates a scoped-key token", () => {
		process.env.SQRRL_API_KEY = "admin-dup-secret"
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{ token: "admin-dup-secret", agentIds: ["a"] },
		])
		expect(() => createApp()).toThrow(/duplicates a scoped API key token/)
	})

	it("rejects object-form policies that override the key token", () => {
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify({
			"real-token": { token: "injected-token", agentIds: ["a"] },
		})
		expect(() => createApp()).toThrow(
			"SQRRL_API_SCOPED_KEYS object-form policy must not contain a token field",
		)
	})
})
