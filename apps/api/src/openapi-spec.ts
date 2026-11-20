// REV-07 C2: kept as a private literal; the exported `openApiSpec` (bottom of
// file) runs `withStandardResponses` over it to add the cross-cutting auth
// and middleware responses so they cannot drift out of sync with app.ts.
import { WIKI_SCOPE_VALUES } from "@sqrrl/wiki-engine"
const openApiDocument = {
	openapi: "3.0.3",
	info: {
		title: "SQRRL API",
		version: "2.0.0",
		description:
			"HTTP API for the SQRRL wiki (Layer 2) and raw source items (Layer 1).",
	},
	servers: [{ url: "/", description: "Default" }],
	// Every /v1/* operation requires a bearer credential (see app.ts; the
	// auth middleware is mounted ahead of the v1 router). /health, /ready and
	// /openapi.json opt out per-operation with `security: []`.
	security: [{ bearerAuth: [] }],
	paths: {
		"/health": {
			get: {
				summary: "Health check",
				security: [],
				responses: { "200": { description: "OK" } },
			},
		},
		"/ready": {
			get: {
				summary:
					"Wiki store (transactions + search) and raw item search readiness",
				security: [],
				responses: {
					"200": { description: "All required dependencies are ready" },
					"503": {
						description:
							"The wiki store (transactions or search) or the raw search indexes are not ready",
					},
				},
			},
		},
		"/openapi.json": {
			get: {
				summary: "OpenAPI document",
				security: [],
				responses: { "200": { description: "OpenAPI JSON" } },
			},
		},
		// Browsable wiki. These serve HTML for people, not JSON for clients:
		// the /v1/wiki/* routes remain the programmatic surface. Authentication
		// accepts the same bearer token either as an Authorization header or as
		// the HttpOnly mdbrain_wiki_key cookie, because a browser following a
		// link sends no header.
		"/wiki": {
			get: {
				summary: "Browse a wiki scope (HTML index of every page)",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
						description: "Memory scope the wiki is partitioned by.",
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
						description: "Scope reference within the scope.",
					},
				],
				responses: {
					"200": { description: "HTML index of the scope's pages" },
					"302": { description: "Redirect to the sign-in form" },
					"400": { description: "HTML error page — scope/scopeRef missing" },
				},
			},
		},
		"/wiki/{slug}": {
			get: {
				summary: "Read one wiki page as a browsable HTML document",
				description:
					"Transclusion markers are resolved, unlike GET /v1/wiki/{slug}, which returns the raw body an editor should see.",
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
						description: "Page slug; may contain slashes.",
					},
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
						description: "Memory scope the wiki is partitioned by.",
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
						description: "Scope reference within the scope.",
					},
				],
				responses: {
					"200": { description: "HTML document for the page" },
					"302": { description: "Redirect to the sign-in form" },
					"400": { description: "HTML error page — scope/scopeRef missing" },
					"404": { description: "HTML error page — no such page in scope" },
				},
			},
		},
		"/wiki/_login": {
			get: {
				summary: "Sign-in form for the browsable wiki",
				security: [],
				parameters: [
					{
						name: "next",
						in: "query",
						required: false,
						schema: { type: "string" },
						description:
							"Same-site path to return to after signing in. Absolute and protocol-relative URLs are rejected.",
					},
				],
				responses: { "200": { description: "HTML sign-in form" } },
			},
			post: {
				summary: "Exchange an API key for the browse cookie",
				security: [],
				requestBody: {
					required: true,
					content: {
						"application/x-www-form-urlencoded": {
							schema: {
								type: "object",
								required: ["key"],
								properties: {
									key: { type: "string", description: "API key." },
									next: {
										type: "string",
										description: "Same-site return path.",
									},
								},
							},
						},
					},
				},
				responses: {
					"303": {
						description:
							"Cookie set (HttpOnly, SameSite=Strict, Path=/wiki); redirect to the return path",
					},
					"400": { description: "HTML form re-rendered with an error" },
				},
			},
		},
		"/wiki/_logout": {
			get: {
				summary: "Clear the browse cookie",
				security: [],
				responses: { "200": { description: "HTML confirmation" } },
			},
		},
		"/v1/wiki": {
			post: {
				summary: "Create a wiki page",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								// REV-07 C5/C6 parity fix: matches the runtime contract
								// (routes/v1.ts POST /wiki) — summary, trustTier and
								// frontmatter.type are required at runtime, and
								// kind/scope/trustTier are enum-validated there.
								required: [
									"kind",
									"title",
									"slug",
									"summary",
									"body",
									"scope",
									"scopeRef",
									"trustTier",
									"frontmatter",
								],
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
											"OKF concept ID; may contain slashes (e.g. tables/users). Must not start with a reserved segment (lint, revisions, task-suggestions, task-review, status, identity, decisions).",
									},
									summary: { type: "string" },
									body: { type: "string" },
									frontmatter: {
										type: "object",
										required: ["type"],
										properties: { type: { type: "string" } },
									},
									scope: {
										type: "string",
										enum: [...WIKI_SCOPE_VALUES],
									},
									scopeRef: { type: "string" },
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									taskCard: {
										type: ["object", "null"],
										description:
											'Action item carried by a kind="procedure" page. Task status is separate from page state: a done task is still an active page.',
										properties: {
											owner: { type: "string" },
											status: {
												type: "string",
												enum: [
													"open",
													"in-progress",
													"blocked",
													"done",
													"dropped",
												],
											},
											dueDate: { type: "string", description: "YYYY-MM-DD" },
											completedAt: { type: ["string", "null"] },
											sourceRef: { type: "string" },
										},
									},
									relationships: {
										type: "array",
										description:
											"Directed edges to other wiki pages. Backlinks are recomputed on the targets.",
										items: {
											type: "object",
											required: ["targetPageSlug", "targetTitle", "kind"],
											properties: {
												targetPageSlug: { type: "string" },
												targetTitle: { type: "string" },
												kind: {
													type: "string",
													description:
														"works_at | uses | depends_on | relates_to | ...",
												},
												weight: { type: "number", minimum: 0, maximum: 1 },
												confidence: { type: "number", minimum: 0, maximum: 1 },
												evidenceKind: { type: "string" },
											},
										},
									},
									agentId: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"201": { description: "Wiki page created" },
					"409": { description: "Duplicate slug" },
					"400": { description: "Validation error" },
				},
			},
			get: {
				summary: "List wiki pages",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{ name: "kind", in: "query", schema: { type: "string" } },
					{
						name: "taskStatus",
						in: "query",
						description: 'Filter kind="procedure" pages by taskCard.status',
						schema: {
							type: "string",
							enum: ["open", "in-progress", "blocked", "done", "dropped"],
						},
					},
					{ name: "state", in: "query", schema: { type: "string" } },
					{
						name: "trustTier",
						in: "query",
						schema: {
							type: "string",
							enum: ["restricted", "standard", "admin"],
						},
					},
					{
						name: "skip",
						in: "query",
						schema: { type: "integer", minimum: 0 },
					},
					{ name: "limit", in: "query", schema: { type: "integer" } },
					{ name: "agentId", in: "query", schema: { type: "string" } },
				],
				responses: { "200": { description: "Wiki page list" } },
			},
		},
		"/v1/wiki/{slug}": {
			get: {
				summary: "Get a wiki page by slug",
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "format",
						in: "query",
						schema: {
							type: "string",
							enum: ["json", "markdown", "html"],
						},
					},
					{
						name: "transclude",
						in: "query",
						schema: { type: "boolean" },
						description:
							"Include inline dependents in the response (parity with the SDK and MCP surfaces).",
					},
					{ name: "agentId", in: "query", schema: { type: "string" } },
				],
				responses: {
					"200": { description: "Wiki page" },
					"400": { description: "Validation error" },
					"404": { description: "Wiki page not found" },
				},
			},
			patch: {
				summary: "Update a wiki page by slug (bumps revision)",
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									kind: { type: "string" },
									title: { type: "string" },
									summary: { type: "string" },
									body: { type: "string" },
									frontmatter: { type: "object" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									permissions: { type: "object" },
									taskCard: {
										type: ["object", "null"],
										description:
											'Action item carried by a kind="procedure" page. Task status is separate from page state: a done task is still an active page.',
										properties: {
											owner: { type: "string" },
											status: {
												type: "string",
												enum: [
													"open",
													"in-progress",
													"blocked",
													"done",
													"dropped",
												],
											},
											dueDate: { type: "string", description: "YYYY-MM-DD" },
											completedAt: { type: ["string", "null"] },
											sourceRef: { type: "string" },
										},
									},
									relationships: {
										type: "array",
										description:
											"Directed edges to other wiki pages. Replaces the existing set; backlinks are recomputed on the targets.",
										items: {
											type: "object",
											required: ["targetPageSlug", "targetTitle", "kind"],
											properties: {
												targetPageSlug: { type: "string" },
												targetTitle: { type: "string" },
												kind: { type: "string" },
												weight: { type: "number", minimum: 0, maximum: 1 },
												confidence: { type: "number", minimum: 0, maximum: 1 },
												evidenceKind: { type: "string" },
											},
										},
									},
									expectedRevision: {
										type: "integer",
										description:
											"Optional compare-and-swap precondition: apply the patch only if the page is still at this revision. Mismatch returns 409 REVISION_CONFLICT instead of a last-writer-wins overwrite.",
									},
									agentId: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Wiki page updated" },
					"400": { description: "Validation error" },
					"404": { description: "Wiki page not found" },
					"409": {
						description:
							"Revision conflict (expectedRevision mismatch) or duplicate slug",
					},
				},
			},
			delete: {
				summary:
					"Delete (soft by default; hard=true for permanent) a wiki page by slug",
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{ name: "hard", in: "query", schema: { type: "boolean" } },
					{ name: "agentId", in: "query", schema: { type: "string" } },
				],
				responses: {
					"200": { description: "Wiki page deleted" },
					"404": { description: "Wiki page not found" },
				},
			},
		},
		"/v1/wiki/revisions": {
			get: {
				summary: "List governed revision history for a wiki page",
				parameters: [
					{
						name: "slug",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{ name: "limit", in: "query", schema: { type: "integer" } },
				],
				responses: {
					"200": { description: "Wiki page revisions" },
					"404": { description: "Wiki page not found" },
				},
			},
		},
		"/v1/wiki/revisions/{revision}": {
			get: {
				summary: "Get one governed wiki page revision",
				parameters: [
					{
						name: "revision",
						in: "path",
						required: true,
						schema: { type: "integer", minimum: 1 },
					},
					{
						name: "slug",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": { description: "Wiki page revision" },
					"404": { description: "Wiki page or revision not found" },
				},
			},
		},
		"/v1/wiki/maintenance": {
			post: {
				summary:
					"Run wiki self-maintenance: Dreamer event promotion or git-diff source regeneration",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["source", "scope", "scopeRef"],
								properties: {
									source: { type: "string", enum: ["git-diff", "dreamer"] },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									agentId: { type: "string" },
									extractTasks: {
										type: "boolean",
										description:
											'source=git-diff only. Also extract action items into kind="procedure" pages with a taskCard, link them back to the source, and link owners and topics into person and topic hub pages. Costs a second LLM call per source.',
									},
									noteDate: {
										type: "string",
										description:
											'YYYY-MM-DD the source was written; anchors relative due dates like "next Friday". Defaults to today.',
									},
									events: {
										type: "array",
										description: "Required when source=dreamer",
										items: {
											type: "object",
											required: ["id", "text"],
											properties: {
												id: { type: "string" },
												text: { type: "string" },
												timestamp: { type: "string", format: "date-time" },
												agentId: { type: "string" },
												embedding: {
													type: "array",
													items: { type: "number" },
												},
											},
										},
									},
									changedSources: {
										type: "array",
										description:
											"Required when source=git-diff; needs SQRRL_ENRICHMENT_* to be configured",
										items: {
											type: "object",
											required: ["path", "content"],
											properties: {
												path: { type: "string" },
												content: { type: "string" },
												previousHash: { type: "string" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "MaintenanceResult" },
					"400": { description: "Validation error or LLM not configured" },
					"502": { description: "LLM call failed" },
					"500": { description: "Maintenance failed" },
				},
			},
		},
		"/v1/wiki/relationships": {
			post: {
				summary: "Add and remove wiki page relationships",
				description:
					"remove runs before add, so one call can move an edge. A patch replaces the whole array; this does not.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["slug", "scope", "scopeRef"],
								properties: {
									slug: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									add: {
										type: "array",
										items: {
											type: "object",
											required: ["targetPageSlug", "targetTitle", "kind"],
											properties: {
												targetPageSlug: { type: "string" },
												targetTitle: { type: "string" },
												kind: { type: "string" },
												weight: { type: "number" },
												confidence: { type: "number" },
											},
										},
									},
									remove: {
										type: "array",
										description:
											"Omit kind to remove every edge to that target.",
										items: {
											type: "object",
											required: ["targetPageSlug"],
											properties: {
												targetPageSlug: { type: "string" },
												kind: { type: "string" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Counts and the resulting page" },
					"400": { description: "Validation error" },
					"404": { description: "Page not found" },
				},
			},
		},
		"/v1/wiki/merge": {
			post: {
				summary: "Fold one wiki page into another",
				description:
					"Repoints inbound edges, carries outbound edges and unseen claims across, then supersedes the loser with supersededBy pointing at the winner.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["from", "into", "scope", "scopeRef"],
								properties: {
									from: { type: "string" },
									into: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "MergeResult" },
					"400": { description: "Validation error" },
					"404": { description: "Page not found" },
				},
			},
		},
		"/v1/wiki/tasks/reassign": {
			post: {
				summary: "Move a task to a different owner or source",
				description:
					"Updates the taskCard and moves the matching owned_by / derived_from edge together, so the card and the graph cannot disagree. owner.hubSlug is required rather than derived: creating person pages is ingestion's job.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["slug", "scope", "scopeRef"],
								properties: {
									slug: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									owner: {
										type: "object",
										required: ["name", "hubSlug"],
										properties: {
											name: { type: "string" },
											hubSlug: { type: "string" },
										},
									},
									sourceSlug: { type: "string" },
									sourceTitle: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "ReassignResult" },
					"400": { description: "Validation error" },
					"404": { description: "Task page not found" },
				},
			},
		},
		"/v1/auth/whoami": {
			get: {
				summary: "Describe the principal behind the presented API key",
				description:
					"Lets a console decide whether to offer key management. isMasterKey is true only for SQRRL_API_KEY itself.",
				responses: { "200": { description: "Principal summary" } },
			},
		},
		"/v1/admin/api-keys": {
			get: {
				summary: "List stored scoped API keys (master key only)",
				description:
					"Secrets are never returned: only the display prefix, policy and lifecycle timestamps.",
				parameters: [
					{
						in: "query",
						name: "includeRevoked",
						schema: { type: "string", enum: ["true", "false"] },
					},
				],
				responses: {
					"200": { description: "Key list" },
					"403": { description: "Not the master key" },
				},
			},
			post: {
				summary: "Mint a scoped API key (master key only)",
				description:
					"The plaintext token is returned exactly once, in this response. Only its SHA-256 is stored.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["subjectId", "capabilities", "allowedScopes"],
								properties: {
									subjectId: { type: "string" },
									displayName: { type: "string" },
									capabilities: {
										type: "array",
										items: { type: "string" },
										description:
											"read|write|write-trusted|administer|change-permissions|hard-delete|export|manage-connectors",
									},
									allowedScopes: {
										type: "array",
										items: {
											type: "object",
											required: ["scope", "scopeRef"],
											properties: {
												scope: { type: "string" },
												scopeRef: { type: "string" },
											},
										},
									},
									allowedAgentIds: {
										type: "array",
										items: { type: "string" },
									},
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									expiresAt: {
										type: "string",
										format: "date-time",
										description: "Optional; must be in the future.",
									},
								},
							},
						},
					},
				},
				responses: {
					"201": {
						description: "Created key, including its only plaintext copy",
					},
					"400": { description: "Validation error" },
					"403": { description: "Not the master key" },
					"409": { description: "subjectId already in use" },
				},
			},
		},
		"/v1/admin/api-keys/update": {
			post: {
				summary: "Change a scoped API key's policy (master key only)",
				description:
					"Omitted fields are left untouched. expiresAt: null clears the expiry.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["keyId"],
								properties: {
									keyId: { type: "string" },
									displayName: { type: "string" },
									capabilities: { type: "array", items: { type: "string" } },
									allowedScopes: { type: "array", items: { type: "object" } },
									allowedAgentIds: { type: "array", items: { type: "string" } },
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									expiresAt: { type: "string", nullable: true },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Updated key" },
					"403": { description: "Not the master key" },
					"404": { description: "No active key with that keyId" },
				},
			},
		},
		"/v1/admin/api-keys/revoke": {
			post: {
				summary: "Revoke a scoped API key (master key only)",
				description:
					"Soft: the row is kept as an audit record and its token hash is dropped, so the key stops authenticating immediately.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["keyId"],
								properties: { keyId: { type: "string" } },
							},
						},
					},
				},
				responses: {
					"200": { description: "Revoked key" },
					"403": { description: "Not the master key" },
					"404": { description: "No active key with that keyId" },
				},
			},
		},
		"/v1/admin/settings": {
			get: {
				summary: "Console-editable settings (master key only)",
				description:
					"Language model, vision and transcription settings, each with its effective value and where it comes from (console override, env file, unset). Secrets are never returned, only isSet.",
				responses: {
					"200": { description: "Settings" },
					"403": { description: "Not the master key" },
					"503": { description: "SQRRL_SETTINGS_FILE is not set" },
				},
			},
			put: {
				summary: "Change console settings (master key only)",
				description:
					"values maps a setting key to a new value, or to null or an empty string to clear the console override and fall back to the env file. Language model settings apply to the API at once; jobs pick the rest up on their next run.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["values"],
								properties: {
									values: {
										type: "object",
										additionalProperties: { type: "string", nullable: true },
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Settings after the change" },
					"400": { description: "Unknown setting or invalid value" },
					"403": { description: "Not the master key" },
					"503": { description: "SQRRL_SETTINGS_FILE is not set" },
				},
			},
		},
		"/v1/admin/settings/transcription/test": {
			post: {
				summary: "Try a transcription endpoint (master key only)",
				description:
					"Sends one second of silence to <baseUrl>/audio/transcriptions with the given (or saved) model. The saved API key is only sent to the saved endpoint; for another URL pass apiKey.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									baseUrl: { type: "string" },
									model: { type: "string" },
									apiKey: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "{ok, status, latencyMs, usedKey, error?}" },
					"400": { description: "Validation error" },
					"403": { description: "Not the master key" },
				},
			},
		},
		"/v1/admin/settings/slack/test": {
			post: {
				summary: "Check a Slack user token without importing anything",
				description:
					"Master key only. Uses the token in the body, else the saved one: auth.test (workspace, user, granted scopes) and users.conversations (how many channels, private channels, group DMs and DMs it can read). The token is never returned.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									token: {
										type: "string",
										description: "xoxp- user token (optional)",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{ok, team, user, url, missingScopes, conversations: {total, more, byType}, error?, ms}",
					},
					"400": { description: "No token, or not a user token" },
					"403": { description: "Not the master key" },
				},
			},
		},
		"/v1/admin/settings/slack/manifest": {
			get: {
				summary: "The Slack app manifest",
				description:
					"Master key only. Paste it into api.slack.com/apps -> Create New App -> From a manifest.",
				responses: {
					"200": { description: "The manifest JSON" },
					"403": { description: "Not the master key" },
				},
			},
		},
		"/v1/admin/settings/llm/test": {
			post: {
				summary: "Try a language model endpoint (master key only)",
				description:
					"Sends a one-word prompt to <baseUrl>/chat/completions with the given (or saved) model; returns the reply. The saved API key is only sent to the saved endpoint; for another URL pass apiKey.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									baseUrl: { type: "string" },
									model: { type: "string" },
									apiKey: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "{ok, status, latencyMs, usedKey, reply?, error?}",
					},
					"400": { description: "Validation error" },
					"403": { description: "Not the master key" },
				},
			},
		},
		"/v1/admin/settings/vision/test": {
			post: {
				summary: "Try a vision endpoint (master key only)",
				description:
					"Sends a small orange square to <baseUrl>/chat/completions with the given (or saved) model and asks for its color; returns the reply. The saved API key is only sent to the saved endpoint; for another URL pass apiKey.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									baseUrl: { type: "string" },
									model: { type: "string" },
									apiKey: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "{ok, status, latencyMs, usedKey, reply?, error?}",
					},
					"400": { description: "Validation error" },
					"403": { description: "Not the master key" },
				},
			},
		},
		"/v1/wiki/purge": {
			post: {
				summary:
					"Permanently remove a wiki page, its revisions and its derived tasks",
				description:
					"For content that should never have been stored. Unlike DELETE ?hard=true, which removes the page but writes the whole document into a revision snapshot, this deletes the revisions too. Cascades by default to task pages derived from this one, because their bodies quote it verbatim. Person and topic hubs are never purged: they hold no page content and are shared. Requires the hard-delete capability. Cannot be undone.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["slug", "scope", "scopeRef"],
								properties: {
									slug: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									cascadeTasks: {
										type: "boolean",
										description:
											"Default true. Set false to keep derived tasks, which will retain any text quoted from this page.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "PurgeResult" },
					"400": { description: "Validation error" },
					"403": { description: "hard-delete capability required" },
					"404": { description: "Page not found" },
				},
			},
		},
		"/v1/wiki/restore": {
			post: {
				summary: "Restore a soft-deleted (superseded) wiki page",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["slug", "scope", "scopeRef"],
								properties: {
									slug: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "The restored page" },
					"400": { description: "Validation error" },
					"404": { description: "No superseded page at that slug" },
					"500": { description: "Restore failed" },
				},
			},
		},
		"/v1/wiki/okf-import": {
			post: {
				summary: "Import an OKF bundle into wiki pages",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: [
									"bundleDir",
									"scope",
									"scopeRef",
									"trustTier",
									"okfBundleId",
								],
								properties: {
									bundleDir: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									okfBundleId: { type: "string" },
									agentId: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OKF import result" },
					"400": { description: "Validation error" },
					"500": { description: "OKF import failed" },
				},
			},
		},
		"/v1/wiki/okf-export": {
			post: {
				summary: "Export wiki pages to an OKF bundle",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "outDir"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									outDir: { type: "string" },
									okfBundleId: { type: "string" },
									trustTier: {
										type: "string",
										enum: ["restricted", "standard", "admin"],
									},
									returnContent: { type: "boolean" },
									agentId: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OKF export result" },
					"400": { description: "Validation error" },
					"500": { description: "OKF export failed" },
				},
			},
		},
		"/v1/wiki/search": {
			post: {
				summary: "Hybrid wiki search (vector + text + rank fusion)",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								// REV-07 C11 parity fix: scope and scopeRef are required at
								// runtime (routes/v1.ts POST /wiki/search rejects empty).
								required: ["query", "scope", "scopeRef"],
								properties: {
									query: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									kind: { type: "string" },
									trustTier: { type: "string" },
									state: { type: "string" },
									privacyTier: { type: "string" },
									recipe: {
										type: "string",
										enum: ["fast", "hybrid", "deep"],
									},
									maxResults: { type: "integer" },
									minScore: { type: "number" },
									agentId: { type: "string" },
									graphExpansion: {
										description:
											'Also return pages linked from the hits via relationships ($graphLookup), with source "graph" and score 0, filtered to the same scope. true uses maxDepth 1 (up to two hops); 0 follows direct links only. At most 20 extra pages.',
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
							},
						},
					},
				},
				responses: {
					"200": { description: "Wiki search results" },
					"400": { description: "Validation error" },
					"500": { description: "Wiki search failed" },
					"503": {
						description:
							"Search subsystem unavailable (mongot or search index outage) — retry, do not treat as no-matches",
					},
				},
			},
		},
		"/v1/raw/sync": {
			post: {
				summary:
					"Write a complete window of one source's items, retire what the window no longer contains, and distill what changed",
				description:
					'Connectors that can enumerate a period (a month of calendar events) send it whole. Items are written as by /v1/raw/items; current items of the same source with occurredAt in [window.from, window.to) that are not in the batch get a tombstone version. Changed and retired items are then distilled by kind: source "calendar" events become meetings/ pages linked to people/ hubs and matching transcripts. Without window nothing is retired.',
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "source", "items"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									source: {
										type: "string",
										description: "Every item must carry this source.",
									},
									window: {
										type: "object",
										required: ["from", "to"],
										properties: {
											from: { type: "string", format: "date-time" },
											to: { type: "string", format: "date-time" },
										},
										description:
											"Every item's occurredAt must lie in [from, to).",
									},
									items: {
										type: "array",
										maxItems: 500,
										items: { type: "object" },
										description:
											"Raw items as for /v1/raw/items; may be empty.",
									},
									channel: {
										type: "string",
										description:
											"Retire only items of this channel; every item must carry it (a chat connector syncs one conversation-day per call).",
									},
									excludeReplies: {
										type: "boolean",
										description:
											"Never retire items with metadata.isReply: a reply to an older thread may be absent from a window without being deleted.",
									},
									redistill: {
										type: "boolean",
										description:
											"Distill unchanged items too, e.g. after a distiller change.",
									},
									maxNewPeople: {
										type: "integer",
										description:
											"Meetings with more people than this link existing person pages but create none (default 12).",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{created, updated, unchanged, retired, distilled: {meetings?, undistilled}, items}",
					},
					"400": { description: "Validation error" },
					"500": { description: "Sync failed" },
				},
			},
		},
		"/v1/raw/mail": {
			post: {
				summary:
					"Mail from Mail.app: drop bulk mail, strip quotes, thread, store, and distill changed threads",
				description:
					"Messages as the Mac exporter reads them (headers, plain text, recipients, mailbox). Bulk mail (lists, unsubscribe headers, bulk or auto-submitted precedence, no-reply senders) and calendar invitations are skipped; quoted history is cut; the message id is the identity, so Inbox and Sent copies are one item. Each thread (References root) that gained or changed a message is distilled into one page with tasks, and linked to people. No window retirement: archived mail is not deleted mail.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "messages"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									selfAddresses: {
										type: "array",
										items: { type: "string" },
										description:
											'The mailbox owner\'s addresses; they read as "me".',
									},
									messages: {
										type: "array",
										maxItems: 500,
										items: {
											type: "object",
											required: ["mailbox"],
											properties: {
												mailbox: { type: "string", enum: ["inbox", "sent"] },
												account: { type: "string" },
												messageId: { type: "string" },
												subject: { type: "string" },
												sender: { type: "string" },
												dateReceived: { type: "string", format: "date-time" },
												dateSent: { type: "string", format: "date-time" },
												headers: { type: "string" },
												content: { type: "string" },
												to: { type: "array", items: { type: "object" } },
												cc: { type: "array", items: { type: "object" } },
												attachments: {
													type: "array",
													items: { type: "string" },
												},
											},
										},
									},
									redistill: {
										type: "boolean",
										description:
											"Distill every thread sent, not only changed ones (after failed LLM calls).",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{received, created, updated, unchanged, skipped: {bulk, calendar, no-id, empty}, threads?}",
					},
					"400": { description: "Validation error" },
					"500": { description: "Mail sync failed" },
				},
			},
		},
		"/v1/wiki/status": {
			get: {
				summary:
					"Background work: task review backlog, source activity, scheduled jobs",
				description:
					"Whether more tasks or close suggestions are still on the way: pages and tasks waiting for task review, pending suggestions, when each source last delivered an item, and (when SQRRL_STATUS_URL points at the host status exporter) each scheduled job's last run, result and next run.",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						description:
							"{taskReview: {suggestions, queuedSources, pendingTasks}, sources: [{source, items, lastReceivedAt, lastOccurredAt}], host: {available, reason?, jobs[], services[]}}",
					},
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/identity/suggestions": {
			get: {
				summary: "Same person? suggestions (pending by default)",
				description:
					'Questions about who a reference is: kind link (a page names someone ambiguously, e.g. "Taylor" with two Taylors known; the link points at the first-name hub until decided) or kind merge (two people pages are probably one person). Each has candidates to choose from.',
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "status",
						in: "query",
						schema: {
							type: "string",
							enum: ["pending", "accepted", "dismissed"],
						},
					},
					{ name: "limit", in: "query", schema: { type: "integer" } },
				],
				responses: {
					"200": {
						description:
							"{suggestions: [...], counts: {pending, accepted, dismissed}}",
					},
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/identity/suggestions/{id}/accept": {
			post: {
				summary: "Accept a same-person suggestion",
				description:
					"link: moves that one link to the chosen person. merge: merges the subject page into the chosen person, keeping its addresses and names.",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "chosen"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									chosen: {
										type: "string",
										description: "Slug of the chosen person",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "{suggestion}" },
					"400": { description: "chosen is missing or not a candidate" },
					"404": { description: "No such suggestion" },
					"409": { description: "Already decided, or a page is gone" },
				},
			},
		},
		"/v1/wiki/identity/suggestions/{id}/dismiss": {
			post: {
				summary: "Dismiss a same-person suggestion",
				description: "Changes nothing; the same question is not asked again.",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "{dismissed: true}" },
					"404": { description: "No such suggestion" },
					"409": { description: "Already decided" },
				},
			},
		},
		"/v1/wiki/decisions": {
			post: {
				summary: "Queue an accept or dismiss",
				description:
					"Records the decision and returns at once (202); a worker in the API carries it out as the caller, running the same code as the task-suggestions and identity accept/dismiss routes. A second request for the same suggestion returns the job already queued (existing: true). An unknown or already decided suggestion, or a choice that is not a candidate, fails here with the direct routes' codes.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "kind", "id", "action"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									kind: {
										type: "string",
										enum: ["task-suggestion", "identity-suggestion"],
									},
									id: { type: "string", description: "Suggestion id" },
									action: { type: "string", enum: ["accept", "dismiss"] },
									chosen: {
										type: "string",
										description: "identity accept: the chosen person slug",
									},
									note: { type: "string", description: "task dismiss: why" },
									expectedRevision: { type: "integer" },
								},
							},
						},
					},
				},
				responses: {
					"202": { description: "{job: {id, status, ...}, existing}" },
					"400": { description: "Validation error" },
					"404": { description: "No such suggestion" },
					"409": { description: "Already decided" },
				},
			},
			get: {
				summary: "Status of queued decisions",
				description:
					"The console watches its jobs: queued, running, done, or failed with {code, message, status}.",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "ids",
						in: "query",
						required: true,
						schema: { type: "string" },
						description: "Comma-separated job ids (at most 100)",
					},
				],
				responses: {
					"200": { description: "{jobs: [...]}" },
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/identity/self": {
			get: {
				summary: "Who the owner of the brain is",
				description:
					"The owner's person page, the names they go by and their addresses, or null when not set.",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						description:
							"{self: {personSlug, names, emails, updatedAt} | null}",
					},
					"400": { description: "Validation error" },
				},
			},
			post: {
				summary: "Set who the owner of the brain is",
				description:
					"References to these names or addresses resolve to the owner's page, and answers call them \"you\". Saving also merges people pages that carry one of the addresses, or one of the names as the whole title, into the owner's page, and settles same-person questions about them.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "personSlug", "names"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									personSlug: { type: "string", description: "A people/ page" },
									names: { type: "array", items: { type: "string" } },
									emails: { type: "array", items: { type: "string" } },
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{self, applied: {merged: string[], questionsSettled}}",
					},
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/identity/link": {
			post: {
				summary: "Link a page to the people in it",
				description:
					"Resolves each person through the shared people resolver (email, full name, first name with the page's other people as context, the owner by their saved names) and adds an edge from the page to each hub. A person marked create may get a new people page when no hub matches and the call names at most maxNewPeople (default 6) people. Ambiguous references link the first-name hub and become same-person questions.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "slug", "people"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									slug: { type: "string" },
									title: { type: "string" },
									edgeKind: { type: "string", default: "participant" },
									maxNewPeople: { type: "integer" },
									people: {
										type: "array",
										items: {
											type: "object",
											properties: {
												name: { type: "string" },
												email: { type: "string" },
												create: { type: "boolean" },
												weight: { type: "number" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{slug, linked, created, resolved: Array<{slug, title} | null>}",
					},
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/identity/cleanup": {
			post: {
				summary: "Clean up people pages (dry run unless apply)",
				description:
					"Plans the cleanup of people hubs: teams and automated senders move to orgs/, spellings of one person merge, first-name links resolve where the context is clear, the rest become same-person suggestions. Without apply: true it only returns the plan. Requires the administer capability.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									apply: { type: "boolean" },
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{applied, plan} or {applied: true, stats, result: {applied, errors}}",
					},
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/task-suggestions": {
			get: {
				summary: "Suggested task closures (pending by default)",
				description:
					"Proposals that an open task is done or no longer needed, each with the evidence quotes it rests on. Nothing changes a task until a suggestion is accepted.",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "status",
						in: "query",
						schema: {
							type: "string",
							enum: ["pending", "accepted", "dismissed", "stale"],
						},
					},
					{ name: "taskSlug", in: "query", schema: { type: "string" } },
					{ name: "limit", in: "query", schema: { type: "integer" } },
				],
				responses: {
					"200": {
						description:
							"{suggestions: [{id, taskSlug, taskTitle, proposed, confidence, rationale, evidence[], status}]}",
					},
					"400": { description: "Validation error" },
				},
			},
		},
		"/v1/wiki/task-suggestions/{id}/accept": {
			post: {
				summary: "Accept a suggestion: close the task",
				description:
					"Sets the task to the proposed status (done with completedAt = the evidence date, or dropped) as the caller, adds resolved_by edges to evidence pages, and records the decision. Optional expectedRevision guards against a concurrent edit.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									expectedRevision: { type: "integer" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OK" },
					"400": { description: "Validation error" },
					"404": { description: "Suggestion or task not found" },
					"409": {
						description:
							"Already decided, task no longer open, or revision conflict",
					},
				},
			},
		},
		"/v1/wiki/task-suggestions/{id}/dismiss": {
			post: {
				summary: "Dismiss a suggestion",
				description:
					"Records the decision and remembers its evidence for that task, so the same evidence never suggests it again.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									note: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OK" },
					"400": { description: "Validation error" },
					"404": { description: "Suggestion not found" },
					"409": { description: "Already decided" },
				},
			},
		},
		"/v1/wiki/task-review/run": {
			post: {
				summary: "Process the task-review queue",
				description:
					"Expands source pages distilled since the last run into the open tasks they might close, then reviews up to limit pending tasks (one LLM call each, several in parallel). Defaults: sourceLimit SQRRL_TASK_REVIEW_SOURCES_PER_RUN (50, max 1000), limit SQRRL_TASK_REVIEW_TASKS_PER_RUN (20, max 200).",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									limit: { type: "integer" },
									sourceLimit: { type: "integer" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OK" },
					"400": { description: "Validation error" },
					"503": { description: "LLM or search unavailable" },
				},
			},
		},
		"/v1/wiki/task-review/task": {
			post: {
				summary: "Find evidence for one task now",
				description:
					"Gathers evidence newer than the task (raw items, wiki pages, meetings) and asks the judge; returns the outcome and any suggestion.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									slug: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OK" },
					"400": { description: "Validation error" },
					"503": { description: "LLM or search unavailable" },
				},
			},
		},
		"/v1/wiki/task-review/sweep": {
			post: {
				summary: "Nightly sweep",
				description:
					"Marks open tasks not reviewed for a week (overdue first, up to limit) and processes them.",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									limit: { type: "integer" },
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "OK" },
					"400": { description: "Validation error" },
					"503": { description: "LLM or search unavailable" },
				},
			},
		},
		"/v1/wiki/answer": {
			post: {
				summary:
					"Answer a question from the brain, citing wiki pages and raw items",
				description:
					'Searches the wiki (hybrid, graph-expanded, governed) and raw items, then asks the LLM to answer from those results alone. Citations in the answer are [slug] for wiki pages and [raw:<id>] for raw items, and every one is checked against the evidence. With no relevant evidence the answer is "Not in the brain." and found is false.',
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["query", "scope", "scopeRef"],
								properties: {
									query: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									maxDepth: {
										type: "integer",
										minimum: 0,
										maximum: 2,
										description:
											"Graph expansion depth from the wiki hits (default 1)",
									},
									maxPages: {
										type: "integer",
										minimum: 1,
										maximum: 10,
										description: "Wiki hits to use as evidence (default 6)",
									},
									maxRaw: {
										type: "integer",
										minimum: 0,
										maximum: 10,
										description:
											"Raw items to use as evidence (default 5; 0 skips raw search)",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"{answer, found, citations, pages, raw, rerank, degraded?, droppedCitations?}",
					},
					"400": { description: "Validation error" },
					"500": { description: "Answer failed" },
					"502": { description: "The LLM call failed" },
					"503": {
						description:
							"Wiki search or the LLM is unavailable or not configured — retry, do not treat as not-in-the-brain",
					},
				},
			},
		},
		"/v1/raw/items": {
			post: {
				summary:
					"Write raw source items (Layer 1). Same content is a no-op; changed content adds a version",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["scope", "scopeRef", "items"],
								properties: {
									scope: { type: "string" },
									scopeRef: { type: "string" },
									items: {
										type: "array",
										minItems: 1,
										maxItems: 500,
										items: {
											type: "object",
											required: ["source", "sourceId", "kind", "text"],
											properties: {
												source: { type: "string" },
												sourceId: { type: "string" },
												kind: {
													type: "string",
													enum: ["note", "file", "message", "email", "event"],
												},
												text: { type: "string" },
												title: { type: "string" },
												unit: { type: "string" },
												occurredAt: { type: "string", format: "date-time" },
												validAt: { type: "string", format: "date-time" },
												invalidAt: { type: "string", format: "date-time" },
												thread: { type: "string" },
												channel: { type: "string" },
												author: { type: "string" },
												participants: {
													type: "array",
													items: { type: "string" },
												},
												attachments: {
													type: "array",
													items: {
														type: "object",
														required: ["name", "ref"],
														properties: {
															name: { type: "string" },
															ref: { type: "string" },
															contentType: { type: "string" },
														},
													},
												},
												metadata: { type: "object" },
											},
										},
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description:
							"Per-item receipts (created | updated | unchanged) with counts",
					},
					"400": { description: "Validation error" },
					"500": { description: "Raw write failed" },
				},
			},
		},
		"/v1/raw/search": {
			post: {
				summary:
					"Hybrid search over current raw items, optionally time-bounded and reranked",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["query", "scope", "scopeRef"],
								properties: {
									query: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									source: { type: "string" },
									kind: {
										type: "string",
										enum: ["note", "file", "message", "email", "event"],
									},
									channel: { type: "string" },
									thread: { type: "string" },
									author: { type: "string" },
									from: { type: "string", format: "date-time" },
									to: { type: "string", format: "date-time" },
									includeHistory: { type: "boolean" },
									limit: { type: "integer", minimum: 1, maximum: 50 },
									rerank: {
										type: "boolean",
										description:
											"Voyage rerank-2.5 when VOYAGE_API_KEY is set; the response says off | unavailable | skipped | applied | failed",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Ranked raw items" },
					"400": { description: "Validation error" },
					"500": { description: "Raw search failed" },
					"503": {
						description:
							"Search subsystem unavailable — retry, do not treat as no-matches",
					},
				},
			},
		},
		"/v1/wiki/lint": {
			get: {
				summary:
					"List wiki pages and unresolved contradictions for lint review",
				parameters: [
					{
						name: "scope",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "scopeRef",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					// REV-07 placebo-parameter fix: the route now honors kind and
					// limit (clamped 1..100), matching the SDK and MCP surfaces.
					{ name: "kind", in: "query", schema: { type: "string" } },
					{
						name: "limit",
						in: "query",
						schema: { type: "integer", minimum: 1, maximum: 100 },
					},
					{ name: "agentId", in: "query", schema: { type: "string" } },
				],
				responses: {
					"200": { description: "Wiki lint report" },
					"400": { description: "Validation error" },
					"500": { description: "Wiki lint failed" },
				},
			},
		},
	},
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				description:
					"SQRRL_API_KEY (or a scoped key from SQRRL_API_SCOPED_KEYS) sent as an Authorization: Bearer token.",
			},
		},
		schemas: {
			ApiError: {
				type: "object",
				required: ["error"],
				properties: {
					error: {
						type: "object",
						required: ["code", "message"],
						properties: {
							code: { type: "string" },
							message: { type: "string" },
							retryable: { type: "boolean" },
							outcome: { type: "string" },
							retryAfterMs: { type: "number" },
						},
					},
				},
			},
		},
	},
} as const

type OpenApiResponses = Record<
	string,
	{
		description?: string
		headers?: Record<string, unknown>
		content?: Record<string, { schema?: { $ref?: string } }>
	}
>

type OpenApiOperation = {
	requestBody?: unknown
	responses?: OpenApiResponses
	[key: string]: unknown
}

type OpenApiPathItem = Record<string, OpenApiOperation | unknown>

type OpenApiDocument = {
	paths: Record<string, OpenApiPathItem>
	[key: string]: unknown
}

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options",
] as const

// REV-07 C3/C12: every /v1/* operation can actually emit these two responses
// (app.ts mounts the content-type guard and the rate limiter on /v1/*), so
// every /v1/* operation must document them. Merging them here, once, keeps
// the per-operation literals readable and drift-free.
const RATE_LIMITED_RESPONSE = {
	description:
		"Rate limited (RATE_LIMITED). Honor Retry-After before retrying; safe to retry the same request afterwards.",
	headers: {
		"Retry-After": {
			description:
				"Seconds (or HTTP-date) until the next allowed request; set on every 429.",
			schema: { type: "string" },
		},
	},
	content: {
		"application/json": {
			schema: { $ref: "#/components/schemas/ApiError" },
		},
	},
} as const

const UNSUPPORTED_MEDIA_TYPE_RESPONSE = {
	description:
		"Unsupported media type (UNSUPPORTED_MEDIA_TYPE). Requests with a body must send Content-Type: application/json.",
	content: {
		"application/json": {
			schema: { $ref: "#/components/schemas/ApiError" },
		},
	},
} as const

function operationOf(
	item: OpenApiPathItem,
	method: string,
): OpenApiOperation | undefined {
	const op = item[method]
	return op !== null && typeof op === "object" && "responses" in op
		? (op as OpenApiOperation)
		: undefined
}

/**
 * Deep-copies the base document and stamps the cross-cutting middleware
 * responses onto every /v1/* operation: 429 RATE_LIMITED (rate limiter is
 * mounted on all of /v1) and 415 UNSUPPORTED_MEDIA_TYPE (content-type guard
 * covers non-GET/HEAD requests that carry a body). Each references the
 * shared ApiError envelope schema instead of a bare description.
 */
function withStandardResponses(doc: OpenApiDocument): OpenApiDocument {
	const out = JSON.parse(JSON.stringify(doc)) as OpenApiDocument
	for (const [path, item] of Object.entries(out.paths)) {
		if (item === null || typeof item !== "object") continue
		for (const method of HTTP_METHODS) {
			const op = operationOf(item as OpenApiPathItem, method)
			if (!op) continue
			const responses: OpenApiResponses = op.responses ?? {}
			op.responses = responses
			if (!responses["429"] && path.startsWith("/v1/")) {
				responses["429"] = RATE_LIMITED_RESPONSE
			}
			if (
				!responses["415"] &&
				path.startsWith("/v1/") &&
				method !== "get" &&
				method !== "head" &&
				op.requestBody !== undefined
			) {
				responses["415"] = UNSUPPORTED_MEDIA_TYPE_RESPONSE
			}
		}
	}
	return out
}

export const openApiSpec: OpenApiDocument = withStandardResponses(
	openApiDocument as unknown as OpenApiDocument,
)
