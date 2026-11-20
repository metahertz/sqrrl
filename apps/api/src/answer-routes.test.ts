// POST /v1/wiki/answer: retrieval wiring, citation checking, the empty and
// outage paths, and that a read-only scoped key may ask within its scope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const source = vi.hoisted(() => ({
	ensureRawItemsSchema: vi.fn(),
	searchRawItems: vi.fn(),
}))
const engine = vi.hoisted(() => ({ searchWikiPages: vi.fn() }))
const store = vi.hoisted(() => ({
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
}))
const llm = vi.hoisted(() => ({
	complete: vi.fn(),
	createAnswerCompletion: vi.fn(),
}))

vi.mock("@sqrrl/source-layer", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sqrrl/source-layer")>()),
	...source,
}))
vi.mock("@sqrrl/wiki-engine", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sqrrl/wiki-engine")>()),
	...engine,
}))
vi.mock("./wiki-store-runtime.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wiki-store-runtime.js")>()),
	...store,
}))
vi.mock("./lib/llm-generate.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/llm-generate.js")>()),
	createAnswerCompletion: llm.createAnswerCompletion,
}))

import { RawSearchUnavailableError } from "@sqrrl/source-layer"
import { WikiSearchUnavailableError } from "@sqrrl/wiki-engine"
import { LlmCallError, LlmNotConfiguredError } from "./lib/llm-generate.js"

const MASTER = "master-token"
const READER = "reader-token"
const HANDLE = { db: {}, prefix: "t_" }
const SCOPE = { scope: "workspace", scopeRef: "default" }

function page(slug: string) {
	return {
		slug,
		title: slug,
		kind: "source",
		summary: `summary ${slug}`,
		body: `body ${slug}`,
	}
}
const WIKI_HITS = {
	results: [
		{ page: page("sources/standup"), score: 0.03, source: "hybrid" },
		{ page: page("people/kai"), score: 0, source: "graph" },
	],
	total: 2,
	recipe: "hybrid",
	mode: "hybrid",
}
const RAW_HITS = [
	{
		item: {
			id: "r1",
			source: "apple-notes",
			sourceId: "n1",
			kind: "note",
			text: "Kai to ship OIDC by Friday",
			participants: [],
			attachments: [],
			metadata: {},
		},
		score: 0.5,
		reranked: false,
	},
]

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
	source.ensureRawItemsSchema.mockResolvedValue(undefined)
	engine.searchWikiPages.mockResolvedValue(WIKI_HITS)
	source.searchRawItems.mockResolvedValue(RAW_HITS)
	llm.createAnswerCompletion.mockReturnValue(llm.complete)
	llm.complete.mockResolvedValue({
		found: true,
		answer: "Kai ships OIDC by Friday [P1][R1].",
	})
})

afterEach(() => {
	delete process.env.SQRRL_API_KEY
	delete process.env.SQRRL_API_SCOPED_KEYS
	vi.clearAllMocks()
})

interface AnswerBody {
	answer: string
	found: boolean
	citations: unknown[]
	pages: unknown[]
	raw: unknown[]
	droppedCitations?: string[]
	error: { code: string }
}

async function read(res: Response): Promise<AnswerBody> {
	return (await res.json()) as AnswerBody
}

function ask(body: unknown, token = MASTER) {
	return createApp().request("/v1/wiki/answer", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	})
}

describe("POST /v1/wiki/answer", () => {
	it("answers from wiki and raw evidence with resolved citations", async () => {
		const res = await ask({ query: "when does OIDC ship?", ...SCOPE })
		expect(res.status).toBe(200)
		const out = await read(res)
		expect(out).toMatchObject({
			...SCOPE,
			found: true,
			answer: "Kai ships OIDC by Friday [sources/standup][raw:r1].",
			rerank: "unavailable",
		})
		expect(out.citations).toEqual([
			expect.objectContaining({ type: "page", slug: "sources/standup" }),
			expect.objectContaining({
				type: "raw",
				id: "r1",
				quote: "Kai to ship OIDC by Friday",
			}),
		])
		expect(out.pages).toEqual([
			expect.objectContaining({ slug: "sources/standup", cited: true }),
			expect.objectContaining({
				slug: "people/kai",
				source: "graph",
				cited: false,
			}),
		])
		expect(out.raw).toEqual([
			expect.objectContaining({ id: "r1", cited: true }),
		])

		const [system, prompt] = llm.complete.mock.calls[0]
		expect(system).toContain("Use ONLY the evidence provided")
		expect(prompt).toContain("[P1]")
		expect(prompt).toContain("[R1]")
		expect(prompt).toContain("Question: when does OIDC ship?")
	})

	it("searches the wiki governed, graph-expanded, at the requested depth", async () => {
		await ask({ query: "q", ...SCOPE, maxDepth: 2, maxPages: 3, maxRaw: 4 })
		expect(engine.searchWikiPages).toHaveBeenCalledWith(
			HANDLE,
			expect.objectContaining({
				query: "q",
				...SCOPE,
				maxResults: 3,
				graphExpansion: { maxDepth: 2 },
				governance: expect.objectContaining(SCOPE),
			}),
		)
		expect(source.searchRawItems).toHaveBeenCalledWith(
			HANDLE,
			expect.objectContaining({ query: "q", ...SCOPE, limit: 4 }),
		)
	})

	it("skips raw search when maxRaw is 0", async () => {
		await ask({ query: "q", ...SCOPE, maxRaw: 0 })
		expect(source.searchRawItems).not.toHaveBeenCalled()
	})

	it("says not in the brain, without calling the LLM, when nothing matches", async () => {
		engine.searchWikiPages.mockResolvedValue({ ...WIKI_HITS, results: [] })
		source.searchRawItems.mockResolvedValue([])
		const res = await ask({ query: "the moon", ...SCOPE })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			answer: "Not in the brain.",
			found: false,
			citations: [],
			pages: [],
			raw: [],
		})
		expect(llm.complete).not.toHaveBeenCalled()
	})

	it("says not in the brain when the model finds nothing or cites nothing real", async () => {
		for (const reply of [
			{ found: false, answer: "" },
			{ found: true, answer: "Probably Tuesday [P8]." },
		]) {
			llm.complete.mockResolvedValueOnce(reply)
			const out = await read(await ask({ query: "q", ...SCOPE }))
			expect(out).toMatchObject({ answer: "Not in the brain.", found: false })
		}
	})

	it("keeps an answer whose citations come only in the cited list", async () => {
		llm.complete.mockResolvedValue({
			found: true,
			answer: "Kai ships OIDC by Friday.",
			cited: ["P1"],
		})
		const out = await read(await ask({ query: "q", ...SCOPE }))
		expect(out).toMatchObject({
			found: true,
			answer: "Kai ships OIDC by Friday. [sources/standup]",
		})
	})

	it("reports a citation the model invented", async () => {
		llm.complete.mockResolvedValue({
			found: true,
			answer: "Kai [P1], also Lee [P5].",
		})
		const out = await read(await ask({ query: "q", ...SCOPE }))
		expect(out.answer).toBe("Kai [sources/standup], also Lee.")
		expect(out.droppedCitations).toEqual(["P5"])
	})

	it("is 503 when wiki search is down, and degrades when only raw is", async () => {
		engine.searchWikiPages.mockRejectedValueOnce(
			new WikiSearchUnavailableError("down"),
		)
		const down = await ask({ query: "q", ...SCOPE })
		expect(down.status).toBe(503)
		expect((await read(down)).error.code).toBe("SEARCH_UNAVAILABLE")

		source.searchRawItems.mockRejectedValueOnce(
			new RawSearchUnavailableError("down"),
		)
		llm.complete.mockResolvedValueOnce({ found: true, answer: "Kai [P1]." })
		const degraded = await ask({ query: "q", ...SCOPE })
		expect(degraded.status).toBe(200)
		expect(await degraded.json()).toMatchObject({
			found: true,
			degraded: ["raw"],
			raw: [],
		})
	})

	it("is 503 without an LLM, before searching", async () => {
		llm.createAnswerCompletion.mockImplementation(() => {
			throw new LlmNotConfiguredError("no llm")
		})
		const res = await ask({ query: "q", ...SCOPE })
		expect(res.status).toBe(503)
		expect((await read(res)).error.code).toBe("LLM_NOT_CONFIGURED")
		expect(engine.searchWikiPages).not.toHaveBeenCalled()
	})

	it("is 502 when the LLM call fails", async () => {
		llm.complete.mockRejectedValue(new LlmCallError("timeout"))
		const res = await ask({ query: "q", ...SCOPE })
		expect(res.status).toBe(502)
		expect((await read(res)).error.code).toBe("LLM_CALL_FAILED")
	})

	it("validates the request", async () => {
		for (const body of [
			{ ...SCOPE },
			{ query: "q", scope: "planet", scopeRef: "x" },
			{ query: "q", scope: "workspace" },
			{ query: "q", ...SCOPE, maxDepth: 3 },
			{ query: "q", ...SCOPE, maxPages: 0 },
			{ query: "q", ...SCOPE, maxRaw: 1.5 },
		]) {
			const res = await ask(body)
			expect(res.status, JSON.stringify(body)).toBe(400)
		}
		expect(engine.searchWikiPages).not.toHaveBeenCalled()
	})

	it("lets a read-only key ask in its scope, and nowhere else", async () => {
		const ok = await ask({ query: "q", ...SCOPE }, READER)
		expect(ok.status).toBe(200)
		const other = await ask(
			{ query: "q", scope: "workspace", scopeRef: "secret" },
			READER,
		)
		expect(other.status).toBe(403)
	})
})
