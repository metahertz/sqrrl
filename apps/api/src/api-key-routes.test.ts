import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The routes only need the key store and the wiki handle; everything else the
// v1 router imports is mocked away so this stays a focused authorization test.
const store = vi.hoisted(() => ({
	createApiKey: vi.fn(),
	listApiKeys: vi.fn(),
	revokeApiKey: vi.fn(),
	updateApiKey: vi.fn(),
	findApiKeyByToken: vi.fn(),
	touchApiKeyLastUsed: vi.fn(),
}))

vi.mock("@sqrrl/wiki-engine", async () => {
	const actual =
		await vi.importActual<typeof import("@sqrrl/wiki-engine")>(
			"@sqrrl/wiki-engine",
		)
	return { ...actual, ...store }
})

vi.mock("./wiki-store-runtime.js", () => ({
	getWikiStoreHandle: vi.fn(async () => ({ db: {}, prefix: "t_" })),
	withWikiTransaction: vi.fn(),
	checkWikiStoreReadiness: vi.fn(async () => ({
		transactional: true,
		search: true,
	})),
	closeWikiStore: vi.fn(),
}))

const MASTER = "master-token"
const SCOPED = "scoped-token"

let createApp: typeof import("./app.js").createApp

beforeEach(async () => {
	vi.resetModules()
	process.env.SQRRL_API_KEY = MASTER
	// A deliberately over-privileged scoped key: admin tier, every capability
	// including administer. If key management were gated on a capability
	// rather than on the master token, this key would pass.
	process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
		{
			token: SCOPED,
			subjectId: "scoped-admin",
			trustTier: "admin",
			capabilities: [
				"read",
				"write",
				"write-trusted",
				"administer",
				"change-permissions",
				"hard-delete",
				"export",
				"manage-connectors",
			],
			scopes: ["*"],
			scopeRefs: ["*"],
			agentIds: ["*"],
		},
	])
	;({ createApp } = await import("./app.js"))
	store.listApiKeys.mockResolvedValue([])
	store.createApiKey.mockResolvedValue({
		keyId: "k1",
		prefix: "mdb_sk_abc123",
		token: "mdb_sk_abc123secret",
		subjectId: "reader",
		capabilities: ["read"],
		allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
		allowedAgentIds: ["*"],
		trustTier: "restricted",
		createdAt: new Date().toISOString(),
		createdBy: "api-key:admin",
	})
})

afterEach(() => {
	process.env.SQRRL_API_KEY = undefined
	process.env.SQRRL_API_SCOPED_KEYS = undefined
	vi.clearAllMocks()
})

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe("scoped api key management", () => {
	it("lets the master key list keys", async () => {
		const res = await createApp().request("/v1/admin/api-keys", {
			headers: auth(MASTER),
		})
		expect(res.status).toBe(200)
	})

	it("refuses a fully-privileged scoped key: no self-escalation", async () => {
		const app = createApp()
		for (const [path, init] of [
			["/v1/admin/api-keys", { headers: auth(SCOPED) }],
			[
				"/v1/admin/api-keys",
				{
					method: "POST",
					headers: { ...auth(SCOPED), "Content-Type": "application/json" },
					body: JSON.stringify({
						subjectId: "x",
						capabilities: ["read"],
						allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
					}),
				},
			],
			[
				"/v1/admin/api-keys/revoke",
				{
					method: "POST",
					headers: { ...auth(SCOPED), "Content-Type": "application/json" },
					body: JSON.stringify({ keyId: "k1" }),
				},
			],
			[
				"/v1/admin/api-keys/update",
				{
					method: "POST",
					headers: { ...auth(SCOPED), "Content-Type": "application/json" },
					body: JSON.stringify({ keyId: "k1", capabilities: ["hard-delete"] }),
				},
			],
		] as Array<[string, RequestInit]>) {
			const res = await app.request(path, init)
			expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(403)
		}
		expect(store.createApiKey).not.toHaveBeenCalled()
		expect(store.revokeApiKey).not.toHaveBeenCalled()
		expect(store.updateApiKey).not.toHaveBeenCalled()
	})

	it("answers whoami for a scope-restricted key without a scope", async () => {
		// A key whose grants name specific scopes must normally send one. If
		// whoami inherited that rule, the call a console makes to discover its
		// own permissions would be refused for not already knowing them.
		process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "narrow-token",
				subjectId: "narrow",
				capabilities: ["read"],
				scopes: ["workspace"],
				scopeRefs: ["default"],
			},
		])
		vi.resetModules()
		const { createApp: freshApp } = await import("./app.js")
		const res = await freshApp().request("/v1/auth/whoami", {
			headers: auth("narrow-token"),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			subjectId: "narrow",
			isMasterKey: false,
		})
	})

	it("reports master status through whoami", async () => {
		const app = createApp()
		const asMaster = await app.request("/v1/auth/whoami", {
			headers: auth(MASTER),
		})
		expect(await asMaster.json()).toMatchObject({ isMasterKey: true })
		const asScoped = await app.request("/v1/auth/whoami", {
			headers: auth(SCOPED),
		})
		expect(await asScoped.json()).toMatchObject({
			isMasterKey: false,
			subjectId: "scoped-admin",
		})
	})

	it("returns the plaintext token exactly once, on creation", async () => {
		const res = await createApp().request("/v1/admin/api-keys", {
			method: "POST",
			headers: { ...auth(MASTER), "Content-Type": "application/json" },
			body: JSON.stringify({
				subjectId: "reader",
				capabilities: ["read"],
				allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
			}),
		})
		expect(res.status).toBe(201)
		expect(await res.json()).toMatchObject({ token: "mdb_sk_abc123secret" })
		// The listing route must never carry it.
		store.listApiKeys.mockResolvedValue([
			{ keyId: "k1", prefix: "mdb_sk_abc123", subjectId: "reader" },
		])
		const list = await createApp().request("/v1/admin/api-keys", {
			headers: auth(MASTER),
		})
		expect(JSON.stringify(await list.json())).not.toContain("secret")
	})

	it("rejects an unknown capability rather than storing it", async () => {
		const res = await createApp().request("/v1/admin/api-keys", {
			method: "POST",
			headers: { ...auth(MASTER), "Content-Type": "application/json" },
			body: JSON.stringify({
				subjectId: "reader",
				capabilities: ["read", "root"],
				allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
			}),
		})
		expect(res.status).toBe(400)
		expect(store.createApiKey).not.toHaveBeenCalled()
	})

	it("rejects an expiry already in the past", async () => {
		const res = await createApp().request("/v1/admin/api-keys", {
			method: "POST",
			headers: { ...auth(MASTER), "Content-Type": "application/json" },
			body: JSON.stringify({
				subjectId: "reader",
				capabilities: ["read"],
				allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
				expiresAt: "2020-01-01T00:00:00.000Z",
			}),
		})
		expect(res.status).toBe(400)
		expect(store.createApiKey).not.toHaveBeenCalled()
	})

	it("refuses to empty a key's capabilities through update", async () => {
		const res = await createApp().request("/v1/admin/api-keys/update", {
			method: "POST",
			headers: { ...auth(MASTER), "Content-Type": "application/json" },
			body: JSON.stringify({ keyId: "k1", capabilities: [] }),
		})
		expect(res.status).toBe(400)
		expect(store.updateApiKey).not.toHaveBeenCalled()
	})
})
