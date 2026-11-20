// Browsable wiki (/wiki/*) integration tests.
//
// The engine is mocked (same pattern as wiki-routes.test.ts) because what is
// under test here is the HTTP surface, not rendering: who may read a page,
// where an unauthenticated browser is sent, and whether the browse cookie
// stays confined to the browse prefix. Rendering has its own tests in
// wiki-renderer.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const prevEnv = { ...process.env }

const wikiMocks = vi.hoisted(() => ({
	getWikiPage: vi.fn(),
	listWikiPages: vi.fn(),
	resolveTransclusions: vi.fn(),
	renderWikiPageDocument: vi.fn(),
	renderWikiIndexDocument: vi.fn(),
}))

const wikiStoreMocks = vi.hoisted(() => ({
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
}))

vi.mock("@sqrrl/wiki-engine", () => ({
	...wikiMocks,
	WIKI_SCOPE_VALUES: ["workspace", "user"],
}))
vi.mock("./wiki-store-runtime.js", () => ({ ...wikiStoreMocks }))

import { createApp } from "./app.js"

const PAGE = {
	slug: "people/lauren",
	title: "Lauren",
	kind: "entity",
	body: "raw {{page:x}} body",
	scope: "workspace",
	scopeRef: "brain",
}

const KEY = "mdb_test_master_key_value"

describe("browsable wiki", () => {
	beforeEach(() => {
		process.env = { ...prevEnv }
		delete process.env.SQRRL_API_KEY
		delete process.env.SQRRL_API_SCOPED_KEYS
		process.env.SQRRL_ALLOW_DEV_PRINCIPAL = "1"
		for (const k of Object.keys(wikiMocks)) {
			;(wikiMocks as Record<string, ReturnType<typeof vi.fn>>)[k].mockReset()
		}
		wikiStoreMocks.getWikiStoreHandle.mockReset()
		wikiStoreMocks.getWikiStoreHandle.mockResolvedValue({
			db: {},
			prefix: "t_",
		})
		wikiMocks.getWikiPage.mockResolvedValue(PAGE)
		wikiMocks.listWikiPages.mockResolvedValue({ pages: [PAGE], total: 1 })
		wikiMocks.resolveTransclusions.mockResolvedValue("resolved body")
		wikiMocks.renderWikiPageDocument.mockReturnValue(
			"<!doctype html><p>page</p>",
		)
		wikiMocks.renderWikiIndexDocument.mockReturnValue(
			"<!doctype html><p>index</p>",
		)
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	describe("page view", () => {
		it("serves a full HTML document", async () => {
			const res = await createApp().request(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
			)
			expect(res.status).toBe(200)
			expect(res.headers.get("content-type")).toContain("text/html")
			expect(await res.text()).toContain("<!doctype html>")
		})

		it("resolves transclusions for readers, unlike the JSON route", async () => {
			await createApp().request(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
			)
			expect(wikiMocks.resolveTransclusions).toHaveBeenCalled()
			const view = wikiMocks.renderWikiPageDocument.mock.calls[0]?.[0] as {
				body: string
			}
			expect(view.body).toBe("resolved body")
		})

		it("passes the slug through with slashes intact", async () => {
			await createApp().request(
				"/wiki/sources/notes/a.md?scope=workspace&scopeRef=brain",
			)
			expect(wikiMocks.getWikiPage).toHaveBeenCalledWith(
				expect.anything(),
				"sources/notes/a.md",
				"workspace",
				"brain",
				expect.anything(),
			)
		})

		it("explains a missing scope in HTML instead of a JSON 400", async () => {
			const res = await createApp().request("/wiki/people/lauren")
			expect(res.status).toBe(400)
			const body = await res.text()
			expect(body).toContain("<!doctype html>")
			expect(body).toContain("Missing scope")
		})

		it("returns a readable 404 for an unknown page", async () => {
			wikiMocks.getWikiPage.mockResolvedValue(null)
			const res = await createApp().request(
				"/wiki/nope?scope=workspace&scopeRef=brain",
			)
			expect(res.status).toBe(404)
			expect(await res.text()).toContain("Page not found")
		})
	})

	describe("scope index", () => {
		it("lists the scope's pages", async () => {
			const res = await createApp().request(
				"/wiki/?scope=workspace&scopeRef=brain",
			)
			expect(res.status).toBe(200)
			expect(wikiMocks.renderWikiIndexDocument).toHaveBeenCalled()
		})

		it("asks for a scope when none is given", async () => {
			const res = await createApp().request("/wiki/")
			expect(res.status).toBe(400)
			expect(await res.text()).toContain("Pick a scope")
		})

		it("requests only active pages", async () => {
			await createApp().request("/wiki/?scope=workspace&scopeRef=brain")
			expect(wikiMocks.listWikiPages).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ state: "active", scope: "workspace" }),
			)
		})
	})

	describe("authentication", () => {
		beforeEach(() => {
			process.env.SQRRL_API_KEY = KEY
			delete process.env.SQRRL_ALLOW_DEV_PRINCIPAL
		})

		it("redirects an unauthenticated browser to the login form", async () => {
			const res = await createApp().request(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
			)
			expect(res.status).toBe(302)
			const location = res.headers.get("location") ?? ""
			expect(location.startsWith("/wiki/_login?next=")).toBe(true)
			expect(decodeURIComponent(location)).toContain(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
			)
		})

		it("still answers /v1 with a JSON 401, not a redirect", async () => {
			const res = await createApp().request(
				"/v1/wiki?scope=workspace&scopeRef=brain",
			)
			expect(res.status).toBe(401)
		})

		it("serves the login form without a credential", async () => {
			const res = await createApp().request("/wiki/_login")
			expect(res.status).toBe(200)
			expect(await res.text()).toContain('<form method="post"')
		})

		it("sets an HttpOnly cookie confined to /wiki on login", async () => {
			const res = await createApp().request("/wiki/_login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ key: KEY, next: "/wiki/" }).toString(),
			})
			expect(res.status).toBe(303)
			const cookie = res.headers.get("set-cookie") ?? ""
			expect(cookie).toContain("mdbrain_wiki_key=")
			expect(cookie).toContain("HttpOnly")
			expect(cookie).toContain("Path=/wiki")
			expect(cookie).toContain("SameSite=Strict")
		})

		it("accepts the cookie for browsing", async () => {
			const res = await createApp().request(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
				{ headers: { Cookie: `mdbrain_wiki_key=${KEY}` } },
			)
			expect(res.status).toBe(200)
		})

		it("does NOT accept the cookie as credentials for /v1", async () => {
			const res = await createApp().request(
				"/v1/wiki?scope=workspace&scopeRef=brain",
				{ headers: { Cookie: `mdbrain_wiki_key=${KEY}` } },
			)
			expect(res.status).toBe(401)
		})

		it("rejects a wrong key in the cookie", async () => {
			const res = await createApp().request(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
				{ headers: { Cookie: "mdbrain_wiki_key=not-the-key" } },
			)
			expect(res.status).toBe(302)
		})

		it("refuses an off-site post-login redirect", async () => {
			const res = await createApp().request("/wiki/_login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					key: KEY,
					next: "//evil.example.com/",
				}).toString(),
			})
			expect(res.headers.get("location")).toBe("/wiki/")
		})

		it("keeps the Authorization header working for API clients", async () => {
			const res = await createApp().request(
				"/wiki/people/lauren?scope=workspace&scopeRef=brain",
				{ headers: { Authorization: `Bearer ${KEY}` } },
			)
			expect(res.status).toBe(200)
		})
	})
})
