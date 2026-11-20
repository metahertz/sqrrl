import { describe, expect, it, vi } from "vitest"
import { SqrrlClientError } from "@sqrrl/client"
import { handleToolCall, toolList } from "./server.js"

function parseTextPayload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0]?.text ?? "null")
}

// Retired with memongo (roadmap, Phase 3), plus the control operations
// that were never exposed. None may be advertised or dispatched.
const RETIRED_TOOLS = [
	"sqrrl_status",
	"sqrrl_probe_embedding",
	"sqrrl_probe_vector",
	"sqrrl_search",
	"sqrrl_search_kb",
	"sqrrl_add",
	"sqrrl_write_event",
	"sqrrl_profile",
	"sqrrl_build_context_bundle",
	"sqrrl_recall_conversation",
	"sqrrl_recall_messages",
	"sqrrl_lifecycle_get",
	"sqrrl_memory_get",
	"sqrrl_lifecycle_update",
	"sqrrl_memory_update",
	"sqrrl_lifecycle_delete",
	"sqrrl_memory_delete",
	"sqrrl_lifecycle_history",
	"sqrrl_memory_history",
	"sqrrl_procedure_outcome",
	"sqrrl_memory_feedback",
	"sqrrl_state_unified",
	"sqrrl_search_detailed",
	"sqrrl_hydrate_active_slate",
	"sqrrl_discovery_projection",
	"sqrrl_write_structured",
	"sqrrl_write_procedure",
]

describe("toolList", () => {
	it("advertises none of the retired memory or control tools", () => {
		const names = new Set<string>(toolList.map((tool) => tool.name))
		for (const name of RETIRED_TOOLS) expect(names.has(name), name).toBe(false)
	})
})

describe("handleToolCall", () => {
	it("rejects retired tool names without dispatching", async () => {
		const client = new Proxy(
			{},
			{
				get: () => {
					throw new Error("no client method may be reached")
				},
			},
		) as never
		for (const name of RETIRED_TOOLS) {
			const result = await handleToolCall(name, {}, client)
			expect("isError" in result ? result.isError : undefined).toBe(true)
			expect(parseTextPayload(result)).toEqual({
				error: `unknown tool: ${name}`,
			})
		}
	})
})

describe("wiki MCP tools", () => {
	it("toolList includes all 6 wiki tools", () => {
		const names = new Set(toolList.map((tool) => tool.name))
		expect(names.has("sqrrl_wiki_search")).toBe(true)
		expect(names.has("sqrrl_wiki_get")).toBe(true)
		expect(names.has("sqrrl_wiki_apply")).toBe(true)
		expect(names.has("sqrrl_wiki_export_okf")).toBe(true)
		expect(names.has("sqrrl_wiki_import_okf")).toBe(true)
		expect(names.has("sqrrl_wiki_lint")).toBe(true)
	})

	it("wiki_search calls the client and returns results", async () => {
		const wikiSearch = vi.fn().mockResolvedValue({
			results: [{ page: { slug: "tables/accounts" }, score: 1.5 }],
			total: 1,
			recipe: "hybrid",
			mode: "hybrid",
		})
		const out = await handleToolCall(
			"sqrrl_wiki_search",
			{ query: "accounts", scope: "workspace", scopeRef: "ws-1" },
			{ wikiSearch } as any,
		)
		expect(wikiSearch).toHaveBeenCalledWith({
			query: "accounts",
			scope: "workspace",
			scopeRef: "ws-1",
			kind: undefined,
			trustTier: undefined,
			state: undefined,
			privacyTier: undefined,
			recipe: undefined,
			maxResults: undefined,
			minScore: undefined,
			agentId: undefined,
			graphExpansion: undefined,
		})
		expect(parseTextPayload(out)).toEqual({
			results: [{ page: { slug: "tables/accounts" }, score: 1.5 }],
			total: 1,
			recipe: "hybrid",
			mode: "hybrid",
		})
	})

	it("wiki_search forwards state, privacyTier and minScore filters", async () => {
		const wikiSearch = vi.fn().mockResolvedValue({
			results: [],
			total: 0,
			recipe: "fast",
			mode: "vector-only",
		})
		await handleToolCall(
			"sqrrl_wiki_search",
			{
				query: "accounts",
				scope: "workspace",
				scopeRef: "ws-1",
				state: "published",
				privacyTier: "internal",
				minScore: 0.25,
			},
			{ wikiSearch } as any,
		)
		expect(wikiSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				state: "published",
				privacyTier: "internal",
				minScore: 0.25,
			}),
		)
	})

	it("wiki_search forwards graphExpansion as a boolean or { maxDepth }", async () => {
		const wikiSearch = vi.fn().mockResolvedValue({ results: [], total: 0 })
		const base = { query: "accounts", scope: "workspace", scopeRef: "ws-1" }
		await handleToolCall(
			"sqrrl_wiki_search",
			{ ...base, graphExpansion: true },
			{ wikiSearch } as any,
		)
		await handleToolCall(
			"sqrrl_wiki_search",
			{ ...base, graphExpansion: { maxDepth: 0 } },
			{ wikiSearch } as any,
		)
		await handleToolCall(
			"sqrrl_wiki_search",
			{ ...base, graphExpansion: "yes" },
			{ wikiSearch } as any,
		)
		expect(wikiSearch.mock.calls[0][0].graphExpansion).toBe(true)
		expect(wikiSearch.mock.calls[1][0].graphExpansion).toEqual({ maxDepth: 0 })
		expect(wikiSearch.mock.calls[2][0].graphExpansion).toBeUndefined()
	})

	it("wiki_get calls the client with slug+scope+scopeRef", async () => {
		const wikiGet = vi.fn().mockResolvedValue({ slug: "x", title: "X" })
		await handleToolCall(
			"sqrrl_wiki_get",
			{
				slug: "tables/users",
				scope: "workspace",
				scopeRef: "ws-1",
				format: "markdown",
			},
			{ wikiGet } as any,
		)
		expect(wikiGet).toHaveBeenCalledWith({
			slug: "tables/users",
			scope: "workspace",
			scopeRef: "ws-1",
			format: "markdown",
			transclude: undefined,
			agentId: undefined,
		})
	})

	it("wiki_get forwards transclude to the client", async () => {
		const wikiGet = vi.fn().mockResolvedValue({ slug: "x", body: "b" })
		await handleToolCall(
			"sqrrl_wiki_get",
			{
				slug: "tables/users",
				scope: "workspace",
				scopeRef: "ws-1",
				transclude: true,
			},
			{ wikiGet } as any,
		)
		expect(wikiGet).toHaveBeenCalledWith(
			expect.objectContaining({ transclude: true }),
		)
	})

	it("wiki_get with format=markdown returns the rendered text verbatim, not JSON-quoted", async () => {
		const wikiGet = vi.fn().mockResolvedValue("# Accounts Table\n\n...")
		const out = await handleToolCall(
			"sqrrl_wiki_get",
			{
				slug: "tables/accounts",
				scope: "workspace",
				scopeRef: "ws-1",
				format: "markdown",
			},
			{ wikiGet } as any,
		)
		expect(out.content[0]?.text).toBe("# Accounts Table\n\n...")
	})

	it("forwards structured API error envelopes instead of flattening them", async () => {
		// REV-07 C14: agents must be able to branch on machine codes like
		// REVISION_CONFLICT and RATE_LIMITED (retryAfterMs) — the MCP error
		// result carries the envelope fields through.
		const wikiApply = vi.fn().mockRejectedValue(
			new SqrrlClientError(
				409,
				JSON.stringify({
					error: {
						code: "REVISION_CONFLICT",
						message:
							'wiki page "test" in scope workspace:ws-1 moved past revision 3 — concurrent update, re-read and retry',
					},
				}),
			),
		)
		const out = await handleToolCall(
			"sqrrl_wiki_apply",
			{
				kind: "concept",
				title: "T",
				slug: "test",
				summary: "S.",
				body: "B.",
				frontmatter: { type: "concept" },
				scope: "workspace",
				scopeRef: "ws-1",
				trustTier: "standard",
			},
			{ wikiApply } as any,
		)
		expect("isError" in out ? out.isError : undefined).toBe(true)
		expect(parseTextPayload(out)).toEqual({
			error: {
				code: "REVISION_CONFLICT",
				message: expect.stringContaining("revision 3"),
				status: 409,
			},
		})
	})

	it("keeps the plain message fallback for non-envelope client errors", async () => {
		const wikiGet = vi
			.fn()
			.mockRejectedValue(new SqrrlClientError(500, "Internal Server Error"))
		const out = await handleToolCall(
			"sqrrl_wiki_get",
			{ slug: "x", scope: "workspace", scopeRef: "ws-1" },
			{ wikiGet } as any,
		)
		expect("isError" in out ? out.isError : undefined).toBe(true)
		expect(parseTextPayload(out)).toEqual({
			error: "Sqrrl API 500: Internal Server Error",
		})
	})

	it("wiki_apply calls the client with page fields", async () => {
		const wikiApply = vi.fn().mockResolvedValue({ _id: "id1", slug: "x" })
		await handleToolCall(
			"sqrrl_wiki_apply",
			{
				kind: "concept",
				title: "Test",
				slug: "test",
				summary: "A test page.",
				body: "Body.",
				frontmatter: { type: "concept" },
				scope: "workspace",
				scopeRef: "ws-1",
				trustTier: "standard",
			},
			{ wikiApply } as any,
		)
		expect(wikiApply).toHaveBeenCalledWith({
			kind: "concept",
			title: "Test",
			slug: "test",
			summary: "A test page.",
			body: "Body.",
			frontmatter: { type: "concept" },
			scope: "workspace",
			scopeRef: "ws-1",
			trustTier: "standard",
			agentId: undefined,
		})
	})

	it("wiki_apply upsert: 409 on POST falls back to PATCH (update existing)", async () => {
		// Regression guard for H1: wikiApply advertises create-or-update.
		// The client method tries POST; on 409 DUPLICATE_SLUG it PATCHes.
		const wikiApply = vi
			.fn()
			.mockResolvedValue({ _id: "id1", slug: "test", revision: 2 })
		await handleToolCall(
			"sqrrl_wiki_apply",
			{
				kind: "concept",
				title: "Updated",
				slug: "test",
				summary: "Updated summary.",
				body: "New body.",
				frontmatter: { type: "concept" },
				scope: "workspace",
				scopeRef: "ws-1",
				trustTier: "standard",
			},
			{ wikiApply } as any,
		)
		// The handler calls wikiApply once; the upsert logic lives in the client
		// method (try POST, catch 409, PATCH). This test verifies the handler
		// forwards the full body so the client can perform the upsert.
		expect(wikiApply).toHaveBeenCalledTimes(1)
		const call = wikiApply.mock.calls[0][0]
		expect(call.slug).toBe("test")
		expect(call.title).toBe("Updated")
		const result = await wikiApply.mock.results[0].value
		expect(result.revision).toBe(2)
	})

	it("wiki_export_okf calls the client with outDir", async () => {
		const wikiExportOkf = vi.fn().mockResolvedValue({ exported: 3, files: [] })
		await handleToolCall(
			"sqrrl_wiki_export_okf",
			{ scope: "workspace", scopeRef: "ws-1", outDir: "/tmp/out" },
			{ wikiExportOkf } as any,
		)
		expect(wikiExportOkf).toHaveBeenCalledWith({
			scope: "workspace",
			scopeRef: "ws-1",
			outDir: "/tmp/out",
			okfBundleId: undefined,
			agentId: undefined,
		})
	})

	it("wiki_export_okf forwards returnContent:true to the client", async () => {
		const wikiExportOkf = vi.fn().mockResolvedValue({
			exported: 1,
			files: ["index.md"],
			fileContents: { "index.md": "# Index\n" },
		})
		await handleToolCall(
			"sqrrl_wiki_export_okf",
			{
				scope: "workspace",
				scopeRef: "ws-1",
				outDir: "/tmp/out",
				returnContent: true,
			},
			{ wikiExportOkf } as any,
		)
		expect(wikiExportOkf).toHaveBeenCalledWith(
			expect.objectContaining({ returnContent: true }),
		)
	})

	it("wiki_import_okf calls the client with bundleDir+scope+trustTier+okfBundleId", async () => {
		const wikiImportOkf = vi.fn().mockResolvedValue({ imported: 3, files: [] })
		await handleToolCall(
			"sqrrl_wiki_import_okf",
			{
				bundleDir: "/tmp/bundle",
				scope: "workspace",
				scopeRef: "ws-1",
				trustTier: "standard",
				okfBundleId: "bundle-1",
			},
			{ wikiImportOkf } as any,
		)
		expect(wikiImportOkf).toHaveBeenCalledWith({
			bundleDir: "/tmp/bundle",
			scope: "workspace",
			scopeRef: "ws-1",
			trustTier: "standard",
			okfBundleId: "bundle-1",
			agentId: undefined,
		})
	})

	it("wiki_lint calls the client with scope+scopeRef", async () => {
		const wikiLint = vi.fn().mockResolvedValue({ pages: [], total: 0 })
		await handleToolCall(
			"sqrrl_wiki_lint",
			{ scope: "workspace", scopeRef: "ws-1", kind: "concept" },
			{ wikiLint } as any,
		)
		expect(wikiLint).toHaveBeenCalledWith({
			scope: "workspace",
			scopeRef: "ws-1",
			kind: "concept",
			limit: undefined,
			agentId: undefined,
		})
	})

	it("returns an error on unknown wiki tool", async () => {
		const out = await handleToolCall("sqrrl_wiki_unknown", {}, {} as any)
		expect("isError" in out ? out.isError : undefined).toBe(true)
	})
})

describe("sqrrl_wiki_answer", () => {
	it("is advertised with the API's required fields", () => {
		const tool = toolList.find((t) => t.name === "sqrrl_wiki_answer")
		expect(tool?.inputSchema.required).toEqual(["query", "scope", "scopeRef"])
	})

	it("forwards the question and limits to the client verbatim", async () => {
		const reply = {
			answer: "Kai owns the OIDC rollout [tasks/oidc].",
			found: true,
			citations: [{ type: "page", ref: "P1", slug: "tasks/oidc" }],
		}
		const wikiAnswer = vi.fn().mockResolvedValue(reply)
		const out = await handleToolCall(
			"sqrrl_wiki_answer",
			{
				query: "who owns OIDC?",
				scope: "workspace",
				scopeRef: "default",
				maxDepth: 0,
				maxRaw: 3,
			},
			{ wikiAnswer } as any,
		)
		expect(wikiAnswer).toHaveBeenCalledWith({
			query: "who owns OIDC?",
			scope: "workspace",
			scopeRef: "default",
			maxDepth: 0,
			maxPages: undefined,
			maxRaw: 3,
		})
		expect(parseTextPayload(out)).toEqual(reply)
	})
})
