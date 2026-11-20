// Same-person suggestions and the people cleanup: who may do what, and how
// decisions and errors come back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sl = vi.hoisted(() => ({
	listIdentitySuggestions: vi.fn(),
	countIdentitySuggestions: vi.fn(),
	acceptIdentitySuggestion: vi.fn(),
	dismissIdentitySuggestion: vi.fn(),
	loadCleanupInput: vi.fn(),
	planPeopleCleanup: vi.fn(),
	applyPeopleCleanup: vi.fn(),
	getSelfIdentity: vi.fn(),
	saveSelfIdentity: vi.fn(),
	linkPeopleToPage: vi.fn(),
}))
const store = vi.hoisted(() => ({ getWikiStoreHandle: vi.fn() }))

vi.mock("@sqrrl/source-layer", async (orig) => ({
	...(await orig<typeof import("@sqrrl/source-layer")>()),
	...sl,
}))
vi.mock("./wiki-store-runtime.js", async (orig) => ({
	...(await orig<typeof import("./wiki-store-runtime.js")>()),
	...store,
}))

import { IdentityDecisionError } from "@sqrrl/source-layer"

const MASTER = "master-token"
const WRITER = "writer-token"
const READER = "reader-token"
const HANDLE = { db: {}, prefix: "t_" }
const SCOPE = { scope: "workspace", scopeRef: "default" }

let createApp: typeof import("./app.js").createApp

const key = (token: string, subjectId: string, capabilities: string[]) => ({
	token,
	subjectId,
	trustTier: "standard",
	capabilities,
	scopes: ["workspace"],
	scopeRefs: ["default"],
	agentIds: ["*"],
})

beforeEach(async () => {
	vi.resetModules()
	process.env.SQRRL_API_KEY = MASTER
	process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
		key(READER, "reader", ["read"]),
		key(WRITER, "writer", ["read", "write"]),
	])
	;({ createApp } = await import("./app.js"))
	store.getWikiStoreHandle.mockResolvedValue(HANDLE)
	sl.listIdentitySuggestions.mockResolvedValue([{ id: "s1" }])
	sl.countIdentitySuggestions.mockResolvedValue({
		pending: 1,
		accepted: 0,
		dismissed: 0,
	})
	sl.loadCleanupInput.mockResolvedValue({ hubs: [], links: new Map() })
	sl.planPeopleCleanup.mockReturnValue({ stats: { hubs: 0 } })
	sl.applyPeopleCleanup.mockResolvedValue({ applied: {}, errors: [] })
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

describe("identity suggestions", () => {
	it("lists for readers", async () => {
		const res = await req(
			"GET",
			"/v1/wiki/identity/suggestions?scope=workspace&scopeRef=default",
			undefined,
			READER,
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			suggestions: [{ id: "s1" }],
			counts: { pending: 1 },
		})
	})

	it("needs write to decide, and a chosen person to accept", async () => {
		const path = "/v1/wiki/identity/suggestions/s1/accept"
		expect(
			(await req("POST", path, { ...SCOPE, chosen: "people/a" }, READER))
				.status,
		).toBe(403)
		expect((await req("POST", path, SCOPE, WRITER)).status).toBe(400)
		sl.acceptIdentitySuggestion.mockResolvedValue({
			id: "s1",
			status: "accepted",
		})
		const ok = await req("POST", path, { ...SCOPE, chosen: "people/a" }, WRITER)
		expect(ok.status).toBe(200)
		expect(sl.acceptIdentitySuggestion).toHaveBeenCalledWith(HANDLE, {
			...SCOPE,
			id: "s1",
			chosen: "people/a",
			editor: { subjectId: "writer" },
		})
	})

	it("maps decision errors to status codes", async () => {
		sl.dismissIdentitySuggestion.mockRejectedValue(
			new IdentityDecisionError("NOT_PENDING", "already accepted"),
		)
		const res = await req(
			"POST",
			"/v1/wiki/identity/suggestions/s1/dismiss",
			SCOPE,
			WRITER,
		)
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({
			error: { code: "IDENTITY_NOT_PENDING" },
		})
	})
})

describe("people cleanup", () => {
	it("is a dry run unless apply, and needs administer", async () => {
		const path = "/v1/wiki/identity/cleanup"
		expect((await req("POST", path, SCOPE, WRITER)).status).toBe(403)
		const dry = await req("POST", path, SCOPE)
		expect(await dry.json()).toMatchObject({
			applied: false,
			plan: { stats: { hubs: 0 } },
		})
		expect(sl.applyPeopleCleanup).not.toHaveBeenCalled()
		const run = await req("POST", path, { ...SCOPE, apply: true })
		expect(await run.json()).toMatchObject({ applied: true })
		expect(sl.applyPeopleCleanup).toHaveBeenCalledOnce()
	})
})

describe("self identity", () => {
	const path = "/v1/wiki/identity/self"
	const SELF = {
		...SCOPE,
		personSlug: "people/matt-hollis",
		names: ["Matt", "Matt Hollis"],
		emails: ["matt@home.example"],
	}

	it("reads for readers, writes for writers", async () => {
		sl.getSelfIdentity.mockResolvedValue(null)
		const got = await req(
			"GET",
			`${path}?scope=workspace&scopeRef=default`,
			undefined,
			READER,
		)
		expect(await got.json()).toMatchObject({ self: null })
		expect((await req("POST", path, SELF, READER)).status).toBe(403)
		sl.saveSelfIdentity.mockResolvedValue({
			self: SELF,
			applied: { merged: ["people/matt"], questionsSettled: 6 },
		})
		const saved = await req("POST", path, SELF, WRITER)
		expect(saved.status).toBe(200)
		expect(await saved.json()).toMatchObject({
			applied: { questionsSettled: 6 },
		})
		expect(sl.saveSelfIdentity).toHaveBeenCalledWith(HANDLE, {
			...SELF,
			editor: { subjectId: "writer" },
		})
	})

	it("rejects input it cannot use", async () => {
		const res = await req("POST", path, { ...SELF, emails: ["nope"] }, WRITER)
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({
			error: { message: "not an email address: nope" },
		})
		expect(sl.saveSelfIdentity).not.toHaveBeenCalled()
	})
})

describe("link people", () => {
	const path = "/v1/wiki/identity/link"
	const BODY = {
		...SCOPE,
		slug: "sources/slack/eng/2026-11-16",
		title: "#eng 2026-11-16",
		people: [{ name: "Ana Example", email: "ana@x.test", create: true }],
	}

	it("needs write, and passes the people to the resolver", async () => {
		expect((await req("POST", path, BODY, READER)).status).toBe(403)
		sl.linkPeopleToPage.mockResolvedValue({
			linked: 1,
			created: 0,
			resolved: [{ slug: "people/ana-example", title: "Ana Example" }],
		})
		const res = await req("POST", path, BODY, WRITER)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ linked: 1, slug: BODY.slug })
		expect(sl.linkPeopleToPage).toHaveBeenCalledWith(HANDLE, {
			...SCOPE,
			slug: BODY.slug,
			title: BODY.title,
			people: BODY.people,
		})
	})

	it("rejects input it cannot use", async () => {
		for (const bad of [
			{ ...BODY, slug: "" },
			{ ...BODY, people: [{}] },
			{ ...BODY, edgeKind: "Not Valid!" },
		])
			expect((await req("POST", path, bad, WRITER)).status).toBe(400)
		expect(sl.linkPeopleToPage).not.toHaveBeenCalled()
	})
})
