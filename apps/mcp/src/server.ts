// Old MDBRAIN_* settings still work (packages/lib/src/legacy-env.ts).
import "@sqrrl/lib/legacy-env"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { SqrrlClient, SqrrlClientError } from "@sqrrl/client"
import { pathToFileURL } from "node:url"
import { curationTools, handleCurationTool, SCOPES } from "./curation-tools.js"
import { handleIdentityTool, identityTools } from "./identity-tools.js"
import {
	handleSuggestionTool,
	suggestionTools,
} from "./task-suggestion-tools.js"

const sqrrl = new SqrrlClient({
	baseUrl: process.env.SQRRL_API_URL,
	apiKey: process.env.SQRRL_API_KEY,
})

type SqrrlMcpClient = typeof sqrrl

function jsonResult(payload: unknown, isError = false) {
	const structuredContent =
		payload !== null && typeof payload === "object"
			? Array.isArray(payload)
				? { items: payload }
				: (payload as Record<string, unknown>)
			: { value: payload }
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		structuredContent,
		...(isError ? { isError: true } : {}),
	}
}

const wikiTools = [
	{
		name: "sqrrl_wiki_search",
		description:
			"Hybrid search over the SQRRL wiki (vector + full-text + RRF fusion). Returns ranked wiki pages with scoped retrieval + governance filters.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query." },
				scope: {
					type: "string",
					enum: SCOPES,
				},
				scopeRef: {
					type: "string",
					description: "Concrete namespace for the scope.",
				},
				kind: {
					type: "string",
					enum: [
						"entity",
						"concept",
						"synthesis",
						"source",
						"report",
						"procedure",
					],
				},
				trustTier: {
					type: "string",
					enum: ["restricted", "standard", "admin"],
				},
				// Parity with the HTTP route: these filters are honored by
				// POST /v1/wiki/search and forwarded by the SDK; the tool schema
				// must expose them too.
				state: {
					type: "string",
					description: "Page state filter (e.g. draft, published, superseded).",
				},
				privacyTier: { type: "string" },
				recipe: { type: "string", enum: ["fast", "hybrid", "deep"] },
				maxResults: { type: "number" },
				minScore: {
					type: "number",
					description: "Minimum ranking score; lower-scoring hits are dropped.",
				},
				agentId: { type: "string" },
				graphExpansion: {
					description:
						'Also return pages linked from the hits by wiki relationships (GraphRAG): they come back with source "graph" and score 0. true follows links up to two hops; { maxDepth: 0 } direct links only, up to 2 for three hops. At most 20 extra pages, same scope only.',
					oneOf: [
						{ type: "boolean" },
						{
							type: "object",
							properties: {
								maxDepth: { type: "integer", minimum: 0, maximum: 2 },
							},
							additionalProperties: false,
						},
					],
				},
			},
			required: ["query", "scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_wiki_answer",
		description:
			'Ask the brain a question and get a short answer that cites its sources: [slug] for wiki pages, [raw:<id>] for raw source text. It searches the wiki (following links) and raw items, and answers from those results only. found:false with "Not in the brain." means nothing relevant is stored; say so rather than guessing. It reads the top search results only, so for complete lists (all overdue tasks, everything someone owns) use sqrrl_wiki_tasks instead. Takes up to a couple of minutes (local LLM).',
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "The question." },
				scope: {
					type: "string",
					enum: SCOPES,
				},
				scopeRef: {
					type: "string",
					description: "Concrete namespace for the scope.",
				},
				maxDepth: {
					type: "integer",
					minimum: 0,
					maximum: 2,
					description: "Link-following depth from the wiki hits (default 1).",
				},
				maxPages: {
					type: "integer",
					minimum: 1,
					maximum: 10,
					description: "Wiki hits used as evidence (default 6).",
				},
				maxRaw: {
					type: "integer",
					minimum: 0,
					maximum: 10,
					description: "Raw items used as evidence (default 5).",
				},
			},
			required: ["query", "scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_wiki_get",
		description:
			"Get a wiki page by slug (OKF concept ID, may contain slashes). Returns JSON by default, or markdown/HTML via format.",
		inputSchema: {
			type: "object",
			properties: {
				slug: {
					type: "string",
					description: "Page slug (OKF concept ID, e.g. tables/users).",
				},
				scope: { type: "string" },
				scopeRef: { type: "string" },
				format: { type: "string", enum: ["json", "markdown", "html"] },
				transclude: {
					type: "boolean",
					description: "Include inline dependents in the response.",
				},
				agentId: { type: "string" },
			},
			required: ["slug", "scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_wiki_apply",
		description:
			"Create or update a wiki page. When the slug+scope+scopeRef matches an existing page, it updates (bumps revision); otherwise it creates a new page.",
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: [
						"entity",
						"concept",
						"synthesis",
						"source",
						"report",
						"procedure",
					],
				},
				title: { type: "string" },
				slug: {
					type: "string",
					description:
						"URL-safe ID = OKF concept ID (may contain slashes, e.g. tables/users).",
				},
				summary: {
					type: "string",
					description: "One-paragraph dense summary.",
				},
				body: { type: "string", description: "Full markdown body." },
				frontmatter: {
					type: "object",
					properties: {
						type: {
							type: "string",
							description:
								"OKF required field (free-form, e.g. table, concept, person).",
						},
						title: { type: "string" },
						description: { type: "string" },
						resource: { type: "string" },
						tags: { type: "array", items: { type: "string" } },
					},
					required: ["type"],
				},
				scope: {
					type: "string",
					enum: SCOPES,
				},
				scopeRef: { type: "string" },
				trustTier: {
					type: "string",
					enum: ["restricted", "standard", "admin"],
				},
				agentId: { type: "string" },
			},
			required: [
				"kind",
				"title",
				"slug",
				"summary",
				"body",
				"frontmatter",
				"scope",
				"scopeRef",
				"trustTier",
			],
		},
	},
	{
		name: "sqrrl_wiki_export_okf",
		description:
			"Export wiki pages to an OKF (Open Knowledge Format) bundle on disk. Portable, vendor-neutral interchange with Google Knowledge Catalog + OKF consumers.",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string" },
				scopeRef: { type: "string" },
				outDir: {
					type: "string",
					description: "Directory to write the bundle.",
				},
				okfBundleId: { type: "string" },
				trustTier: {
					type: "string",
					description:
						"Caller's trust tier (restricted|standard|admin) — export is governance-filtered exactly like a governed read, never an unfiltered dump.",
				},
				agentId: { type: "string" },
				returnContent: {
					type: "boolean",
					description:
						"When true, includes each exported file's content in the response, for callers without filesystem access to the API server.",
				},
			},
			required: ["scope", "scopeRef", "outDir"],
		},
	},
	{
		name: "sqrrl_wiki_import_okf",
		description:
			"Import an OKF (Open Knowledge Format) bundle directory into the wiki. Portable, vendor-neutral interchange with Google Knowledge Catalog + OKF consumers.",
		inputSchema: {
			type: "object",
			properties: {
				bundleDir: {
					type: "string",
					description: "Directory containing the OKF bundle to import.",
				},
				scope: {
					type: "string",
					enum: SCOPES,
				},
				scopeRef: { type: "string" },
				trustTier: {
					type: "string",
					enum: ["restricted", "standard", "admin"],
				},
				okfBundleId: { type: "string" },
				agentId: { type: "string" },
			},
			required: ["bundleDir", "scope", "scopeRef", "trustTier", "okfBundleId"],
		},
	},
	{
		name: "sqrrl_wiki_lint",
		description:
			"List wiki pages (optionally by kind) for lint review — spot stale/superseded entries needing attention. Contradiction surfacing lands with the T12 contradiction detector.",
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string" },
				scopeRef: { type: "string" },
				kind: {
					type: "string",
					enum: [
						"entity",
						"concept",
						"synthesis",
						"source",
						"report",
						"procedure",
					],
				},
				limit: { type: "number" },
				agentId: { type: "string" },
			},
			required: ["scope", "scopeRef"],
		},
	},
] as const

export const toolList = [
	...wikiTools,
	...curationTools,
	...suggestionTools,
	...identityTools,
]

const server = new Server(
	{
		name: "sqrrl",
		version: "2.0.0",
	},
	{
		capabilities: { tools: {} },
	},
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [...toolList],
}))

export async function handleToolCall(
	name: string,
	args: Record<string, unknown>,
	client: SqrrlMcpClient = sqrrl,
) {
	try {
		const sqrrl = client
		if (name === "sqrrl_wiki_search") {
			const out = await sqrrl.wikiSearch({
				query: typeof args.query === "string" ? args.query : "",
				scope: typeof args.scope === "string" ? args.scope : undefined,
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : undefined,
				kind: typeof args.kind === "string" ? args.kind : undefined,
				trustTier:
					typeof args.trustTier === "string" ? args.trustTier : undefined,
				state: typeof args.state === "string" ? args.state : undefined,
				privacyTier:
					typeof args.privacyTier === "string" ? args.privacyTier : undefined,
				recipe:
					args.recipe === "fast" ||
					args.recipe === "hybrid" ||
					args.recipe === "deep"
						? args.recipe
						: undefined,
				maxResults:
					typeof args.maxResults === "number" ? args.maxResults : undefined,
				minScore: typeof args.minScore === "number" ? args.minScore : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				// Forwarded as given; the API validates it and answers 400.
				graphExpansion:
					typeof args.graphExpansion === "boolean" ||
					(typeof args.graphExpansion === "object" &&
						args.graphExpansion !== null)
						? (args.graphExpansion as boolean | { maxDepth?: number })
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "sqrrl_wiki_answer") {
			const int = (v: unknown) => (typeof v === "number" ? v : undefined)
			const out = await sqrrl.wikiAnswer({
				query: typeof args.query === "string" ? args.query : "",
				scope: typeof args.scope === "string" ? args.scope : "",
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : "",
				// Forwarded as given; the API validates the ranges and answers 400.
				maxDepth: int(args.maxDepth),
				maxPages: int(args.maxPages),
				maxRaw: int(args.maxRaw),
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "sqrrl_wiki_get") {
			const format =
				args.format === "markdown" ||
				args.format === "html" ||
				args.format === "json"
					? args.format
					: undefined
			const out = await sqrrl.wikiGet({
				slug: typeof args.slug === "string" ? args.slug : "",
				scope: typeof args.scope === "string" ? args.scope : "",
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : "",
				format,
				transclude:
					typeof args.transclude === "boolean" ? args.transclude : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			if (format === "markdown" || format === "html") {
				// The SDK resolves these formats to the raw rendered string;
				// return it verbatim instead of JSON-quoting it.
				return {
					content: [
						{
							type: "text",
							text: typeof out === "string" ? out : JSON.stringify(out),
						},
					],
				}
			}
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "sqrrl_wiki_apply") {
			const out = await sqrrl.wikiApply({
				kind: typeof args.kind === "string" ? args.kind : "",
				title: typeof args.title === "string" ? args.title : "",
				slug: typeof args.slug === "string" ? args.slug : "",
				summary: typeof args.summary === "string" ? args.summary : "",
				body: typeof args.body === "string" ? args.body : "",
				frontmatter: (args.frontmatter ?? {}) as {
					type: string
					title?: string
					description?: string
					resource?: string
					tags?: string[]
					entityTypes?: string[]
					privacyTier?: string
				},
				scope: typeof args.scope === "string" ? args.scope : "",
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : "",
				trustTier: typeof args.trustTier === "string" ? args.trustTier : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "sqrrl_wiki_export_okf") {
			const out = await sqrrl.wikiExportOkf({
				scope: typeof args.scope === "string" ? args.scope : "",
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : "",
				outDir: typeof args.outDir === "string" ? args.outDir : "",
				okfBundleId:
					typeof args.okfBundleId === "string" ? args.okfBundleId : undefined,
				trustTier:
					typeof args.trustTier === "string" ? args.trustTier : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
				returnContent:
					typeof args.returnContent === "boolean"
						? args.returnContent
						: undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "sqrrl_wiki_import_okf") {
			const trustTier = args.trustTier
			if (
				trustTier !== "restricted" &&
				trustTier !== "standard" &&
				trustTier !== "admin"
			) {
				throw new Error("trustTier must be restricted|standard|admin")
			}
			const out = await sqrrl.wikiImportOkf({
				bundleDir: typeof args.bundleDir === "string" ? args.bundleDir : "",
				scope: typeof args.scope === "string" ? args.scope : "",
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : "",
				trustTier,
				okfBundleId:
					typeof args.okfBundleId === "string" ? args.okfBundleId : "",
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		if (name === "sqrrl_wiki_lint") {
			const out = await sqrrl.wikiLint({
				scope: typeof args.scope === "string" ? args.scope : "",
				scopeRef: typeof args.scopeRef === "string" ? args.scopeRef : "",
				kind: typeof args.kind === "string" ? args.kind : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
				agentId: typeof args.agentId === "string" ? args.agentId : undefined,
			})
			return { content: [{ type: "text", text: JSON.stringify(out) }] }
		}
		const curated = await handleCurationTool(name, args, sqrrl)
		if (curated) return curated
		const decided = await handleSuggestionTool(name, args, sqrrl)
		if (decided) return decided
		const identified = await handleIdentityTool(name, args, sqrrl)
		if (identified) return identified
		throw new Error(`unknown tool: ${name}`)
	} catch (err) {
		// REV-07 C14 passthrough: when the HTTP API answered with a structured
		// error envelope (RATE_LIMITED, REVISION_CONFLICT, SEARCH_UNAVAILABLE,
		// ...), forward its machine-readable fields instead of flattening
		// everything to a bare message string — agents need to branch on
		// codes like REVISION_CONFLICT (re-read, retry) vs RATE_LIMITED
		// (honor retryAfterMs).
		if (err instanceof SqrrlClientError && err.envelope) {
			return jsonResult(
				{
					error: {
						...err.envelope,
						status: err.status,
					},
				},
				true,
			)
		}
		const message = err instanceof Error ? err.message : String(err)
		return jsonResult({ error: message }, true)
	}
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	return handleToolCall(
		request.params.name,
		(request.params.arguments ?? {}) as Record<string, unknown>,
	)
})

async function main(): Promise<void> {
	const transport = new StdioServerTransport()
	await server.connect(transport)
}

const entrypointHref = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined

if (import.meta.url === entrypointHref) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
