/** A stored scoped API key. The secret is absent: only the creation response
 *  ever carries it. */
export type SqrrlApiKey = {
	keyId: string
	prefix: string
	subjectId: string
	displayName?: string
	capabilities: string[]
	allowedScopes: Array<{ scope: string; scopeRef: string }>
	allowedAgentIds: string[]
	trustTier: string
	createdAt: string
	createdBy: string
	expiresAt?: string
	revokedAt?: string
	revokedBy?: string
	lastUsedAt?: string
}

/** Creation result. `token` is the only copy that will ever exist — the server
 *  keeps a SHA-256 and cannot reproduce it. */
export type SqrrlApiKeyWithSecret = SqrrlApiKey & { token: string }

/** A console-editable setting. Secrets come back with value null; isSet
 *  says whether one is stored. */
/** One scheduled job on the host, from the status exporter. */
/** A "same person?" question (GET /v1/wiki/identity/suggestions). */
export type SqrrlIdentitySuggestion = {
	id: string
	scope: string
	scopeRef: string
	/** link: one page's link to a first-name hub; merge: two people pages. */
	kind: "link" | "merge"
	subjectSlug: string
	subjectTitle: string
	fromSlug?: string
	fromTitle?: string
	edgeKind?: string
	candidates: Array<{ slug: string; title: string; reason: string }>
	status: "pending" | "accepted" | "dismissed"
	chosen?: string
	createdAt: string
	updatedAt: string
}

/** Who the owner of the brain is (GET /v1/wiki/identity/self). */
export type SqrrlSelfIdentity = {
	personSlug: string
	names: string[]
	emails: string[]
	updatedAt?: string
	updatedBy?: string
}

/** A queued accept/dismiss (POST/GET /v1/wiki/decisions). */
export type SqrrlDecisionJob = {
	id: string
	kind: "task-suggestion" | "identity-suggestion"
	suggestionId: string
	action: "accept" | "dismiss"
	chosen?: string
	status: "queued" | "running" | "done" | "failed"
	error?: { code: string; message: string; status: number }
	createdAt: string
	finishedAt?: string
}

export type SqrrlStatusJob = {
	id: string
	label: string
	about?: string
	installed?: boolean
	enabled: boolean
	running: boolean
	schedule?: string
	lastStartedAt?: string | null
	lastFinishedAt?: string | null
	nextRunAt?: string | null
	result: "success" | "failed" | null
	exitCode?: number
	summary?: string
	problem?: string
	detail?: Record<string, unknown>
}

export type SqrrlStatusService = {
	id: string
	label: string
	active: boolean
	since?: string | null
	queue?: { queued?: number; running?: number; workers?: number }
}

/** GET /v1/wiki/status: what background work is still to come. */
export type SqrrlStatus = {
	scope: string
	scopeRef: string
	generatedAt: string
	taskReview: {
		suggestions: Record<"pending" | "accepted" | "dismissed" | "stale", number>
		/** Distilled pages waiting to be expanded into tasks to review. */
		queuedSources: number
		/** Tasks waiting to be judged against new evidence. */
		pendingTasks: number
		/** What one scheduled run takes on (older servers omit it). */
		perRun?: { sources: number; tasks: number }
	}
	sources: Array<{
		source: string
		items: number
		lastReceivedAt?: string
		lastOccurredAt?: string
	}>
	host: {
		available: boolean
		reason?: string
		generatedAt?: string
		jobs?: SqrrlStatusJob[]
		services?: SqrrlStatusService[]
	}
}

export type SqrrlSetting = {
	key: string
	group: string
	label: string
	kind: "url" | "model" | "seconds" | "secret"
	help: string
	value: string | null
	isSet: boolean
	/** console: set here; file: the env file default; unset: neither. */
	source: "console" | "file" | "unset"
	/** What applies once the console value is cleared (null for secrets). */
	fileValue: string | null
	fileLabel?: string
}

/** Result of an endpoint test from Settings. */
/** What POST /v1/admin/settings/slack/test found. */
export type SqrrlSlackCheck = {
	ok: boolean
	error?: string
	team?: string
	user?: string
	url?: string
	missingScopes?: string[]
	conversations?: {
		total: number
		more: boolean
		byType: Record<string, number>
	}
	ms: number
}

export type SqrrlEndpointTest = {
	ok: boolean
	status: number
	latencyMs: number
	usedKey: "typed" | "saved" | "none"
	/** Vision and language model: the model's reply to the test. */
	reply?: string
	error?: string
}

export type SqrrlTranscriptionTest = SqrrlEndpointTest

export type SqrrlWhoami = {
	subjectId: string
	displayName?: string
	trustTier: string
	capabilities: string[]
	allowedScopes: Array<{ scope: string; scopeRef: string }>
	allowedAgentIds: string[]
	/** True only for SQRRL_API_KEY itself. Key management requires it. */
	isMasterKey: boolean
}
import type {
	SqrrlWikiMaintenanceResult,
	SqrrlWikiMergeResult,
	SqrrlWikiPurgeResult,
	SqrrlWikiReassignResult,
	SqrrlWikiRelationshipEditResult,
} from "./types.js"
import {
	apiDelete,
	apiGet,
	apiGetText,
	apiPatch,
	apiPost,
	apiPut,
	SqrrlClientError,
	resolveDeadlineMs,
} from "./transport.js"
import type { SqrrlClientOptions, SqrrlRequestOptions } from "./transport.js"

export { SqrrlClientError }
export type { SqrrlClientOptions, SqrrlRequestOptions }

/** HTTP client for the supported Sqrrl API surface. */
/** Builds the path portion for /v1/wiki/<slug>.
 *
 *  Slugs are path-shaped ("sources/notes/a.md", "tasks/lauren-fix-mic"), and
 *  the server parses one back out by splitting the request path on "/wiki/"
 *  without decoding it. encodeURIComponent over the whole slug turns those
 *  separators into %2F, which then never matches a stored slug — every page
 *  whose slug contains a slash answered 404. Encode each segment instead and
 *  leave the separators alone.
 *
 *  Note the server does not percent-decode what it parses, so a segment
 *  containing a space or "#" still will not round-trip. Generated slugs are
 *  ASCII-safe apart from the separators, so this covers real pages; fixing
 *  the rest means decoding server-side, which would change how an existing
 *  slug containing a literal "%" is read. */
function wikiSlugPath(slug: string): string {
	return String(slug)
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")
}

export class SqrrlClient {
	constructor(private readonly _opts: SqrrlClientOptions = {}) {}

	// ---------------------------------------------------------------------------
	// Wiki (T6 MCP tools)
	// ---------------------------------------------------------------------------

	async wikiSearch(
		input: {
			query: string
			scope?: string
			scopeRef?: string
			kind?: string
			trustTier?: string
			state?: string
			privacyTier?: string
			recipe?: "fast" | "hybrid" | "deep"
			maxResults?: number
			minScore?: number
			agentId?: string
			/** Add pages linked from the hits; maxDepth 0..2, default 1. */
			graphExpansion?: boolean | { maxDepth?: number }
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/wiki/search",
			{
				query: input.query,
				scope: input.scope,
				scopeRef: input.scopeRef,
				kind: input.kind,
				trustTier: input.trustTier,
				state: input.state,
				privacyTier: input.privacyTier,
				recipe: input.recipe,
				maxResults: input.maxResults,
				minScore: input.minScore,
				agentId: input.agentId,
				graphExpansion: input.graphExpansion,
			},
			undefined,
			"safe",
			requestOptions,
		)
	}

	/** Writes a complete window of one source's raw items, retires items of
	 *  that source in the window that the batch no longer contains, and
	 *  distills what changed (calendar events become meetings/ pages). Safe
	 *  to retry: unchanged items are no-ops and retiring is idempotent. */
	async rawSync(
		input: {
			scope: string
			scopeRef: string
			source: string
			items: Array<Record<string, unknown>>
			window?: { from: string; to: string }
			/** Retire only within this channel; every item must carry it. */
			channel?: string
			/** Never retire items whose metadata.isReply is true. */
			excludeReplies?: boolean
			redistill?: boolean
			maxNewPeople?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/raw/sync",
			{ ...input },
			undefined,
			"safe",
			{ timeoutMs: 300_000, ...requestOptions },
		)
	}

	/** Sends Mail.app messages: bulk mail is dropped, threads are stored and
	 *  the changed ones distilled. Slow (an LLM call pair per changed thread),
	 *  so the deadline is long; safe to retry, as unchanged mail is a no-op. */
	async rawMail(
		input: {
			scope: string
			scopeRef: string
			selfAddresses?: string[]
			messages: Array<Record<string, unknown>>
			redistill?: boolean
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/raw/mail",
			{ ...input },
			undefined,
			"safe",
			{
				timeoutMs: 3_600_000,
				...requestOptions,
			},
		)
	}

	/** Suggested task closures (pending by default), each with the evidence
	 *  quotes it rests on. Nothing changes until one is accepted. */
	async taskSuggestions(
		input: {
			scope: string
			scopeRef: string
			status?: "pending" | "accepted" | "dismissed" | "stale"
			taskSlug?: string
			limit?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		suggestions: Array<Record<string, unknown>>
		counts?: {
			suggestions: Record<
				"pending" | "accepted" | "dismissed" | "stale",
				number
			>
			queuedSources: number
			pendingTasks: number
		}
	}> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		if (input.status) qs.set("status", input.status)
		if (input.taskSlug) qs.set("taskSlug", input.taskSlug)
		if (input.limit) qs.set("limit", String(input.limit))
		return apiGet(this._opts, `/v1/wiki/task-suggestions?${qs}`, requestOptions)
	}

	/** "Same person?" questions: ambiguous names and probable duplicates. */
	async identitySuggestions(
		input: {
			scope: string
			scopeRef: string
			status?: "pending" | "accepted" | "dismissed"
			limit?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		suggestions: SqrrlIdentitySuggestion[]
		counts?: Record<"pending" | "accepted" | "dismissed", number>
	}> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		if (input.status) qs.set("status", input.status)
		if (input.limit) qs.set("limit", String(input.limit))
		return apiGet(
			this._opts,
			`/v1/wiki/identity/suggestions?${qs}`,
			requestOptions,
		)
	}

	/** Answers a same-person question: chosen is a candidate's slug, or
	 *  omit it to dismiss. Not retried. */
	async decideIdentitySuggestion(
		input: { id: string; scope: string; scopeRef: string; chosen?: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const { id, chosen, ...body } = input
		return apiPost(
			this._opts,
			`/v1/wiki/identity/suggestions/${encodeURIComponent(id)}/${chosen ? "accept" : "dismiss"}`,
			chosen ? { ...body, chosen } : body,
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Plans (or with apply: true, runs) the people cleanup. Needs the
	 *  administer capability. */
	async peopleCleanup(
		input: { scope: string; scopeRef: string; apply?: boolean },
		requestOptions?: SqrrlRequestOptions,
	): Promise<Record<string, unknown>> {
		return apiPost(
			this._opts,
			"/v1/wiki/identity/cleanup",
			input,
			undefined,
			"never",
			requestOptions,
		) as Promise<Record<string, unknown>>
	}

	/** Who the owner of the brain is, or null when not set. */
	async selfIdentity(
		input: { scope: string; scopeRef: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ self: SqrrlSelfIdentity | null }> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		return apiGet(this._opts, `/v1/wiki/identity/self?${qs}`, requestOptions)
	}

	/** Sets who the owner is; also merges people pages that carry their
	 *  addresses or names and settles questions about them. Not retried. */
	async setSelfIdentity(
		input: {
			scope: string
			scopeRef: string
			personSlug: string
			names: string[]
			emails: string[]
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		self: SqrrlSelfIdentity
		applied: { merged: string[]; questionsSettled: number }
	}> {
		return apiPost(
			this._opts,
			"/v1/wiki/identity/self",
			input,
			undefined,
			"never",
			requestOptions,
		) as never
	}

	/** Links a page to the people in it through the shared people resolver
	 *  (POST /v1/wiki/identity/link). Re-running adds no duplicate edges. */
	async linkPeople(
		input: {
			scope: string
			scopeRef: string
			slug: string
			title?: string
			edgeKind?: string
			maxNewPeople?: number
			people: Array<{
				name?: string
				email?: string
				create?: boolean
				weight?: number
			}>
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		slug: string
		linked: number
		created: number
		resolved: Array<{ slug: string; title: string } | null>
	}> {
		return apiPost(
			this._opts,
			"/v1/wiki/identity/link",
			input,
			undefined,
			"never",
			requestOptions,
		) as never
	}

	/** Queues an accept or dismiss; returns at once with the job. A second
	 *  call for the same suggestion returns the job already queued. */
	async queueDecision(
		input: {
			scope: string
			scopeRef: string
			kind: "task-suggestion" | "identity-suggestion"
			id: string
			action: "accept" | "dismiss"
			chosen?: string
			note?: string
			expectedRevision?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ job: SqrrlDecisionJob; existing: boolean }> {
		return apiPost(
			this._opts,
			"/v1/wiki/decisions",
			input,
			undefined,
			"never",
			requestOptions,
		) as never
	}

	/** Status of queued decisions, by job id. */
	async decisionJobs(
		input: { scope: string; scopeRef: string; ids: string[] },
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ jobs: SqrrlDecisionJob[] }> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
			ids: input.ids.join(","),
		})
		return apiGet(this._opts, `/v1/wiki/decisions?${qs}`, requestOptions)
	}

	/** Background work: task review backlog, when each source last
	 *  delivered, and the host's scheduled jobs. */
	async backgroundStatus(
		input: { scope: string; scopeRef: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlStatus> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		return apiGet(this._opts, `/v1/wiki/status?${qs}`, requestOptions)
	}

	/** Closes the task as suggested (done or dropped). Not retried. */
	async acceptTaskSuggestion(
		input: {
			id: string
			scope: string
			scopeRef: string
			expectedRevision?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const { id, ...body } = input
		return apiPost(
			this._opts,
			`/v1/wiki/task-suggestions/${encodeURIComponent(id)}/accept`,
			body,
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Dismisses a suggestion; its evidence will not raise the task again. */
	async dismissTaskSuggestion(
		input: { id: string; scope: string; scopeRef: string; note?: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const { id, ...body } = input
		return apiPost(
			this._opts,
			`/v1/wiki/task-suggestions/${encodeURIComponent(id)}/dismiss`,
			body,
			undefined,
			"never",
			requestOptions,
		)
	}

	/** "Find evidence": reviews one task now (an LLM call, so a long
	 *  deadline). Returns the outcome and any suggestion. */
	async reviewTask(
		input: { slug: string; scope: string; scopeRef: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		outcome: {
			slug: string
			result: string
			suggestion?: Record<string, unknown>
		}
	}> {
		return apiPost(
			this._opts,
			"/v1/wiki/task-review/task",
			{ ...input },
			undefined,
			"never",
			{
				timeoutMs: 180_000,
				...requestOptions,
			},
		)
	}

	/** Processes the review queue (or, with sweep, the nightly pass). */
	async runTaskReview(
		input: { scope: string; scopeRef: string; limit?: number; sweep?: boolean },
		requestOptions?: SqrrlRequestOptions,
	): Promise<Record<string, unknown>> {
		const { sweep, ...body } = input
		return apiPost(
			this._opts,
			sweep ? "/v1/wiki/task-review/sweep" : "/v1/wiki/task-review/run",
			body,
			undefined,
			"never",
			{
				timeoutMs: 3_600_000,
				...requestOptions,
			},
		)
	}

	/** Answers a question from the wiki and raw items, citing [slug] and
	 *  [raw:<id>]. found is false, with the answer "Not in the brain.", when
	 *  nothing relevant is stored.
	 *
	 *  Waits on an LLM, so the deadline defaults to 150 s rather than the
	 *  client's usual 10 s. Not retried: a timed-out answer is usually a busy
	 *  model, and asking again at once only adds to its queue. */
	async wikiAnswer(
		input: {
			query: string
			scope: string
			scopeRef: string
			/** Graph expansion depth from the wiki hits, 0..2, default 1. */
			maxDepth?: number
			/** Wiki hits used as evidence, 1..10, default 6. */
			maxPages?: number
			/** Raw items used as evidence, 0..10, default 5. */
			maxRaw?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/wiki/answer",
			{ ...input },
			undefined,
			"never",
			{ timeoutMs: 150_000, ...requestOptions },
		)
	}

	// ---------------------------------------------------------------------------
	// Raw source items (Layer 1, @sqrrl/source-layer)
	// ---------------------------------------------------------------------------

	/** Writes up to 500 raw items under one scope. Safe to retry: identical
	 *  content is a no-op, so a retry after a lost response reports
	 *  "unchanged" rather than writing twice. */
	async rawWrite(
		input: {
			scope: string
			scopeRef: string
			items: Array<{
				source: string
				sourceId: string
				kind: "note" | "file" | "message" | "email" | "event"
				text: string
				title?: string
				unit?: string
				occurredAt?: string
				validAt?: string
				invalidAt?: string
				thread?: string
				channel?: string
				author?: string
				participants?: string[]
				attachments?: Array<{ name: string; ref: string; contentType?: string }>
				metadata?: Record<string, unknown>
			}>
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/raw/items",
			{ scope: input.scope, scopeRef: input.scopeRef, items: input.items },
			undefined,
			"safe",
			requestOptions,
		)
	}

	async rawSearch(
		input: {
			query: string
			scope: string
			scopeRef: string
			source?: string
			kind?: "note" | "file" | "message" | "email" | "event"
			channel?: string
			thread?: string
			author?: string
			from?: string
			to?: string
			includeHistory?: boolean
			limit?: number
			rerank?: boolean
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/raw/search",
			{ ...input },
			undefined,
			"safe",
			requestOptions,
		)
	}

	async wikiGet(
		input: {
			slug: string
			scope: string
			scopeRef: string
			format?: "json" | "markdown" | "html"
			transclude?: boolean
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		if (input.format) qs.set("format", input.format)
		if (input.transclude !== undefined) {
			qs.set("transclude", String(input.transclude))
		}
		if (input.agentId) qs.set("agentId", input.agentId)
		// Slugs are OKF concept IDs that may contain path-unsafe characters;
		// wikiSlugPath encodes each segment and keeps "/" as a separator.
		const path = `/v1/wiki/${wikiSlugPath(input.slug)}?${qs}`
		if (input.format === "markdown" || input.format === "html") {
			// The server deliberately returns a non-JSON body for these
			// formats; resolve to the raw string instead of parsing.
			return apiGetText(this._opts, path, requestOptions)
		}
		return apiGet(this._opts, path, requestOptions)
	}

	async wikiApply(
		input: {
			// Create or update a wiki page. When slug+scope+scopeRef match an
			// existing page, it updates; otherwise it creates.
			kind: string
			title: string
			slug: string
			summary: string
			body: string
			frontmatter: {
				type: string
				title?: string
				description?: string
				resource?: string
				tags?: string[]
				entityTypes?: string[]
				privacyTier?: string
			}
			scope: string
			scopeRef: string
			trustTier: string
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const deadlineAt =
			Date.now() + resolveDeadlineMs(this._opts, requestOptions)
		// Upsert: try POST (create); on 409 DUPLICATE_SLUG, fall back to PATCH
		// (update existing page, bumps revision). REV-07 race-safety fix: the
		// fallback re-reads the current page and sends expectedRevision so a
		// concurrent writer between the GET and the PATCH surfaces as
		// 409 REVISION_CONFLICT instead of silently overwriting. If the page
		// disappears mid-fallback (concurrent delete), the GET's 404 is
		// rethrown — the caller should decide whether to re-create.
		const body = {
			kind: input.kind,
			title: input.title,
			slug: input.slug,
			summary: input.summary,
			body: input.body,
			frontmatter: input.frontmatter,
			scope: input.scope,
			scopeRef: input.scopeRef,
			trustTier: input.trustTier,
			agentId: input.agentId,
		}
		try {
			return await apiPost(
				this._opts,
				"/v1/wiki",
				body,
				undefined,
				"never",
				requestOptions,
			)
		} catch (err) {
			// Only DUPLICATE_SLUG means "the page exists; update it instead".
			// A bare 409 (no envelope code) may be an older server or a
			// different conflict; treat it as DUPLICATE_SLUG for compatibility.
			if (
				!(err instanceof SqrrlClientError && err.status === 409) ||
				(err.envelope !== undefined && err.envelope.code !== "DUPLICATE_SLUG")
			) {
				throw err
			}
			const remainingOptions: SqrrlRequestOptions = {
				...requestOptions,
				timeoutMs: Math.max(0, deadlineAt - Date.now()),
			}
			// A GET failure here (e.g. the page vanished between POST and GET
			// via a concurrent delete) propagates: the caller must learn the
			// upsert target disappeared rather than get a blind overwrite.
			const existing = (await apiGet(
				this._opts,
				`/v1/wiki/${wikiSlugPath(input.slug)}?${new URLSearchParams({
					scope: input.scope,
					scopeRef: input.scopeRef,
					...(input.agentId ? { agentId: input.agentId } : {}),
				})}`,
				remainingOptions,
			)) as { revision?: unknown }
			const expectedRevision =
				existing && typeof existing.revision === "number"
					? existing.revision
					: undefined
			return apiPatch(
				this._opts,
				`/v1/wiki/${wikiSlugPath(input.slug)}`,
				{ ...body, expectedRevision },
				remainingOptions,
			)
		}
	}

	async wikiExportOkf(
		input: {
			scope: string
			scopeRef: string
			outDir: string
			okfBundleId?: string
			trustTier?: string
			agentId?: string
			returnContent?: boolean
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/wiki/okf-export",
			{
				scope: input.scope,
				scopeRef: input.scopeRef,
				outDir: input.outDir,
				okfBundleId: input.okfBundleId,
				trustTier: input.trustTier,
				agentId: input.agentId,
				returnContent: input.returnContent,
			},
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Lists wiki pages with pagination and server-side filters.
	 *
	 *  wikiLint is the older listing call and takes no skip, so it can only
	 *  ever return the first page of results — fine for a lint sample, wrong
	 *  for anything that needs the whole scope. The engine clamps limit to
	 *  100, so a caller wanting everything pages through using `total`. */
	async wikiList(
		input: {
			scope: string
			scopeRef: string
			kind?: string
			taskStatus?: string
			/** "all" includes superseded pages; the default excludes them. */
			state?: string
			limit?: number
			skip?: number
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ pages: unknown[]; total: number }> {
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		if (input.kind) qs.set("kind", input.kind)
		if (input.taskStatus) qs.set("taskStatus", input.taskStatus)
		if (input.state) qs.set("state", input.state)
		if (input.agentId) qs.set("agentId", input.agentId)
		qs.set("limit", String(input.limit ?? 100))
		if (input.skip) qs.set("skip", String(input.skip))
		return apiGet<{ pages: unknown[]; total: number }>(
			this._opts,
			`/v1/wiki?${qs}`,
			requestOptions,
		)
	}

	async wikiLint(
		input: {
			scope: string
			scopeRef: string
			kind?: string
			limit?: number
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		// Lists pages for lint review. Surfaces pages needing attention for
		// manual review. T12 contradiction detector will populate contradictions[]
		// for a fuller lint; for now this lists pages (optionally by kind) so a
		// human can spot stale/superseded entries. The list route accepts a state
		// filter — we don't force one here so callers see the full picture.
		const qs = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		if (input.kind) qs.set("kind", input.kind)
		if (input.agentId) qs.set("agentId", input.agentId)
		const limit = input.limit ?? 100
		qs.set("limit", String(limit))
		return apiGet(this._opts, `/v1/wiki/lint?${qs}`, requestOptions)
	}

	/** Adds and removes relationships on one wiki page.
	 *
	 *  Patching a page replaces its relationships array wholesale, so moving a
	 *  single edge means reading, editing and writing the whole set with a race
	 *  in the middle. This applies removals before additions, so one call can
	 *  move an edge from one target to another.
	 *
	 *  Idempotent: adding an edge that exists is a no-op, and removing one that
	 *  does not is too, so a retry cannot double-apply. */
	async wikiEditRelationships(
		input: {
			slug: string
			scope: string
			scopeRef: string
			add?: Array<{
				targetPageSlug: string
				targetTitle: string
				kind: string
				weight?: number
				confidence?: number
			}>
			/** Omit kind to remove every edge to that target. */
			remove?: Array<{ targetPageSlug: string; kind?: string }>
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlWikiRelationshipEditResult> {
		return apiPost<SqrrlWikiRelationshipEditResult>(
			this._opts,
			"/v1/wiki/relationships",
			{
				slug: input.slug,
				scope: input.scope,
				scopeRef: input.scopeRef,
				add: input.add,
				remove: input.remove,
			},
			undefined,
			"safe",
			requestOptions,
		)
	}

	/** Folds one wiki page into another.
	 *
	 *  Inbound edges are repointed, outbound edges and unseen claims are carried
	 *  across, and the loser is superseded with supersededBy naming the winner.
	 *
	 *  Not retried: merging a page that is already superseded is an error, so a
	 *  retry after a response that was merely slow to arrive would report a
	 *  failure for work that actually succeeded. Undo is wikiRestore on the
	 *  loser, though the edges it repointed are not restored with it. */
	async wikiMerge(
		input: { from: string; into: string; scope: string; scopeRef: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlWikiMergeResult> {
		return apiPost<SqrrlWikiMergeResult>(
			this._opts,
			"/v1/wiki/merge",
			{
				from: input.from,
				into: input.into,
				scope: input.scope,
				scopeRef: input.scopeRef,
			},
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Moves a task to a different owner and/or source page.
	 *
	 *  Updates the taskCard and moves the matching owned_by or derived_from edge
	 *  together, so a listing and a graph traversal cannot disagree about who
	 *  owns something.
	 *
	 *  owner.hubSlug is required rather than derived from the name: creating
	 *  person pages is ingestion's job, and inventing one here would produce a
	 *  second page for someone who already has one. */
	async wikiReassignTask(
		input: {
			slug: string
			scope: string
			scopeRef: string
			owner?: { name: string; hubSlug: string }
			sourceSlug?: string
			sourceTitle?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlWikiReassignResult> {
		return apiPost<SqrrlWikiReassignResult>(
			this._opts,
			"/v1/wiki/tasks/reassign",
			{
				slug: input.slug,
				scope: input.scope,
				scopeRef: input.scopeRef,
				owner: input.owner,
				sourceSlug: input.sourceSlug,
				sourceTitle: input.sourceTitle,
			},
			undefined,
			"safe",
			requestOptions,
		)
	}

	/** Sets a task page's status — the "mark it done" write.
	 *
	 *  Goes through PATCH /v1/wiki/<slug> rather than a bespoke endpoint,
	 *  because taskCard is an ordinary patchable field. updateWikiPage
	 *  REPLACES taskCard wholesale rather than merging it, so the caller
	 *  passes the card it is looking at and this re-sends it whole with the
	 *  new status; sending only { status } would silently drop the owner, due
	 *  date and sourceRef.
	 *
	 *  completedAt is set when moving to "done" and cleared otherwise, so a
	 *  reopened task does not keep a completion date.
	 *
	 *  expectedRevision is a compare-and-swap: pass the revision the card was
	 *  read at and a concurrent edit surfaces as 409 REVISION_CONFLICT rather
	 *  than a blind overwrite.
	 *
	 *  Survives re-ingestion: syncTasksForSource keeps any held status that is
	 *  not "dropped" (see carriedTaskState), so a task marked done here stays
	 *  done the next time its source note is processed. */
	async wikiSetTaskStatus(
		input: {
			slug: string
			scope: string
			scopeRef: string
			status: "open" | "in-progress" | "blocked" | "done" | "dropped"
			/** The card as currently stored; re-sent whole with the new status. */
			taskCard: {
				owner: string
				status?: string
				dueDate?: string
				completedAt?: string | null
				sourceRef?: string
			}
			expectedRevision?: number
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const { status: _prevStatus, ...card } = input.taskCard
		void _prevStatus
		return apiPatch(
			this._opts,
			`/v1/wiki/${wikiSlugPath(input.slug)}`,
			{
				scope: input.scope,
				scopeRef: input.scopeRef,
				taskCard: {
					...card,
					status: input.status,
					completedAt:
						input.status === "done" ? new Date().toISOString() : null,
				},
				...(input.expectedRevision !== undefined
					? { expectedRevision: input.expectedRevision }
					: {}),
				...(input.agentId ? { agentId: input.agentId } : {}),
			},
			requestOptions,
		)
	}

	/** Runs git-diff wiki maintenance over changed source text: LLM title,
	 *  summary, body and claims per source, plus task extraction. The same call
	 *  ingest.py and the Apple Notes sync make; exposed here so connectors use
	 *  one ingestion path instead of each re-implementing it.
	 *
	 *  Slow by nature (two LLM calls per source), so callers should pass a
	 *  generous timeoutMs. Not retried: a timeout after the server has started
	 *  writing is safe to re-run (pages are path-keyed) but that is the
	 *  caller's decision. */
	async wikiMaintenance(
		input: {
			scope: string
			scopeRef: string
			changedSources: Array<{ path: string; content: string }>
			trustTier?: string
			extractTasks?: boolean
			/** YYYY-MM-DD anchor for relative due dates in extracted tasks. */
			noteDate?: string
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlWikiMaintenanceResult> {
		return apiPost<SqrrlWikiMaintenanceResult>(
			this._opts,
			"/v1/wiki/maintenance",
			{
				source: "git-diff",
				scope: input.scope,
				scopeRef: input.scopeRef,
				trustTier: input.trustTier ?? "standard",
				changedSources: input.changedSources,
				...(input.extractTasks !== undefined
					? { extractTasks: input.extractTasks }
					: {}),
				...(input.noteDate ? { noteDate: input.noteDate } : {}),
				...(input.agentId ? { agentId: input.agentId } : {}),
			},
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Merges keys into a page's frontmatter.
	 *
	 *  PATCH replaces frontmatter wholesale and requires frontmatter.type, so
	 *  this reads the page, merges, and writes back with the revision it read
	 *  as a compare-and-swap. A concurrent edit surfaces as 409
	 *  REVISION_CONFLICT rather than being overwritten. */
	async wikiMergeFrontmatter(
		input: {
			slug: string
			scope: string
			scopeRef: string
			frontmatter: Record<string, unknown>
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		const current = (await this.wikiGet(
			{
				slug: input.slug,
				scope: input.scope,
				scopeRef: input.scopeRef,
				...(input.agentId ? { agentId: input.agentId } : {}),
			},
			requestOptions,
		)) as { revision?: number; frontmatter?: Record<string, unknown> }
		const existing = current.frontmatter ?? {}
		return apiPatch(
			this._opts,
			`/v1/wiki/${wikiSlugPath(input.slug)}`,
			{
				scope: input.scope,
				scopeRef: input.scopeRef,
				frontmatter: {
					...existing,
					...input.frontmatter,
					type: String(input.frontmatter.type ?? existing.type ?? "source"),
				},
				...(typeof current.revision === "number"
					? { expectedRevision: current.revision }
					: {}),
			},
			requestOptions,
		)
	}

	/** Permanently removes a page, its revision history and, by default, the
	 *  tasks derived from it.
	 *
	 *  For content that should never have been stored. wikiDelete supersedes
	 *  and keeps everything; a hard delete removes the page but preserves the
	 *  whole document in a revision snapshot. Only this removes the material.
	 *
	 *  Cascades to derived tasks by default because their bodies are verbatim
	 *  quotes from the page. Person and topic hubs are never touched: they hold
	 *  no page content and are shared with other pages.
	 *
	 *  Requires the hard-delete capability. Not retried, and there is no undo. */
	async wikiPurge(
		input: {
			slug: string
			scope: string
			scopeRef: string
			/** Default true. False keeps tasks, and any text they quote. */
			cascadeTasks?: boolean
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlWikiPurgeResult> {
		return apiPost<SqrrlWikiPurgeResult>(
			this._opts,
			"/v1/wiki/purge",
			{
				slug: input.slug,
				scope: input.scope,
				scopeRef: input.scopeRef,
				cascadeTasks: input.cascadeTasks,
			},
			undefined,
			"never",
			requestOptions,
		)
	}

	async wikiDelete(
		input: {
			slug: string
			scope: string
			scopeRef: string
			hard?: boolean
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		ok: boolean
		slug: string
		scope: string
		scopeRef: string
		hard: boolean
	}> {
		const params = new URLSearchParams({
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		if (input.hard) params.set("hard", "true")
		if (input.agentId) params.set("agentId", input.agentId)
		return apiDelete(
			this._opts,
			`/v1/wiki/${wikiSlugPath(input.slug)}?${params}`,
			requestOptions,
		)
	}

	/** Edits a page's fields (title, summary, body, aliases, frontmatter,
	 *  taskCard, ...). With expectedRevision the edit applies only if the page
	 *  is still at that revision, else 409 REVISION_CONFLICT, so an editor
	 *  never overwrites a change it has not seen. Not retried. */
	async wikiPatch(
		input: {
			slug: string
			scope: string
			scopeRef: string
			patch: Record<string, unknown>
			expectedRevision?: number
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<Record<string, unknown>> {
		return apiPatch(
			this._opts,
			`/v1/wiki/${wikiSlugPath(input.slug)}`,
			{
				...input.patch,
				scope: input.scope,
				scopeRef: input.scopeRef,
				...(typeof input.expectedRevision === "number"
					? { expectedRevision: input.expectedRevision }
					: {}),
			},
			requestOptions,
		)
	}

	/** A page's revision history, newest first, without snapshots. */
	async wikiRevisions(
		input: { slug: string; scope: string; scopeRef: string; limit?: number },
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		revisions: Array<{
			revision: number
			editKind: string
			editor?: { subjectId?: string; displayName?: string }
			createdAt: string
		}>
	}> {
		const params = new URLSearchParams({
			slug: input.slug,
			scope: input.scope,
			scopeRef: input.scopeRef,
			limit: String(input.limit ?? 50),
		})
		return apiGet(this._opts, `/v1/wiki/revisions?${params}`, requestOptions)
	}

	/** One revision with the page's full state as of that revision. */
	async wikiRevision(
		input: { slug: string; scope: string; scopeRef: string; revision: number },
		requestOptions?: SqrrlRequestOptions,
	): Promise<{
		revision: number
		editKind: string
		createdAt: string
		snapshot: Record<string, unknown>
	}> {
		const params = new URLSearchParams({
			slug: input.slug,
			scope: input.scope,
			scopeRef: input.scopeRef,
		})
		return apiGet(
			this._opts,
			`/v1/wiki/revisions/${input.revision}?${params}`,
			requestOptions,
		)
	}

	/** Brings back a soft-deleted page. */
	async wikiRestore(
		input: { slug: string; scope: string; scopeRef: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/wiki/restore",
			{ ...input },
			undefined,
			"never",
			requestOptions,
		)
	}

	async wikiImportOkf(
		input: {
			bundleDir: string
			scope: string
			scopeRef: string
			trustTier: "restricted" | "standard" | "admin"
			okfBundleId: string
			agentId?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<unknown> {
		return apiPost(
			this._opts,
			"/v1/wiki/okf-import",
			{
				bundleDir: input.bundleDir,
				scope: input.scope,
				scopeRef: input.scopeRef,
				trustTier: input.trustTier,
				okfBundleId: input.okfBundleId,
				agentId: input.agentId,
			},
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Describes the principal behind the configured key.
	 *
	 *  Chiefly so a console can tell whether to offer key management at all,
	 *  rather than discovering it from a 403 on the management call. */
	async whoami(requestOptions?: SqrrlRequestOptions): Promise<SqrrlWhoami> {
		return apiGet<SqrrlWhoami>(this._opts, "/v1/auth/whoami", requestOptions)
	}

	/** Lists stored scoped API keys. Master key only.
	 *
	 *  Secrets are never returned — only the display prefix and the policy. */
	async listApiKeys(
		input: { includeRevoked?: boolean } = {},
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ keys: SqrrlApiKey[] }> {
		const qs = input.includeRevoked ? "?includeRevoked=true" : ""
		return apiGet<{ keys: SqrrlApiKey[] }>(
			this._opts,
			`/v1/admin/api-keys${qs}`,
			requestOptions,
		)
	}

	/** Mints a scoped API key. Master key only.
	 *
	 *  The returned `token` is the only copy: the server stores a SHA-256 and
	 *  cannot show it again. Capture it from this response or reissue.
	 *
	 *  Not retried. A replay would mint a second key rather than return the
	 *  first, leaving a live credential nobody recorded. */
	async createApiKey(
		input: {
			subjectId: string
			displayName?: string
			capabilities: string[]
			allowedScopes: Array<{ scope: string; scopeRef: string }>
			allowedAgentIds?: string[]
			trustTier?: "restricted" | "standard" | "admin"
			/** ISO date-time. Must be in the future; omit for no expiry. */
			expiresAt?: string
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlApiKeyWithSecret> {
		return apiPost<SqrrlApiKeyWithSecret>(
			this._opts,
			"/v1/admin/api-keys",
			{
				subjectId: input.subjectId,
				displayName: input.displayName,
				capabilities: input.capabilities,
				allowedScopes: input.allowedScopes,
				allowedAgentIds: input.allowedAgentIds,
				trustTier: input.trustTier,
				expiresAt: input.expiresAt,
			},
			undefined,
			"never",
			requestOptions,
		)
	}

	/** Changes a key's policy in place. Master key only.
	 *
	 *  Omitted fields are left alone. Pass `expiresAt: null` to clear an expiry
	 *  and make the key perpetual. Safe to retry: the same patch applied twice
	 *  leaves the same policy. */
	async updateApiKey(
		input: {
			keyId: string
			displayName?: string
			capabilities?: string[]
			allowedScopes?: Array<{ scope: string; scopeRef: string }>
			allowedAgentIds?: string[]
			trustTier?: "restricted" | "standard" | "admin"
			expiresAt?: string | null
		},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlApiKey> {
		return apiPost<SqrrlApiKey>(
			this._opts,
			"/v1/admin/api-keys/update",
			{
				keyId: input.keyId,
				displayName: input.displayName,
				capabilities: input.capabilities,
				allowedScopes: input.allowedScopes,
				allowedAgentIds: input.allowedAgentIds,
				trustTier: input.trustTier,
				expiresAt: input.expiresAt,
			},
			undefined,
			"safe",
			requestOptions,
		)
	}

	/** Withdraws a key. Master key only.
	 *
	 *  Soft: the row survives as the record that this key existed and when it
	 *  was withdrawn, and its token hash is dropped so it cannot authenticate.
	 *  Safe to retry — a second revoke of the same key reports 404, which is
	 *  the correct answer to "is it still active". */
	async revokeApiKey(
		input: { keyId: string },
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlApiKey> {
		return apiPost<SqrrlApiKey>(
			this._opts,
			"/v1/admin/api-keys/revoke",
			{ keyId: input.keyId },
			undefined,
			"safe",
			requestOptions,
		)
	}

	/** Console-editable settings, secrets masked. Master key only. */
	async settings(
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ settings: SqrrlSetting[] }> {
		return apiGet(this._opts, "/v1/admin/settings", requestOptions)
	}

	/** Sets console overrides; null or "" clears one back to the env file
	 *  value. Language model settings apply to the API at once; jobs pick
	 *  the rest up on their next run. Master key only. */
	async updateSettings(
		values: Record<string, string | null>,
		requestOptions?: SqrrlRequestOptions,
	): Promise<{ settings: SqrrlSetting[] }> {
		return apiPut(this._opts, "/v1/admin/settings", { values }, requestOptions)
	}

	/** Sends one second of silence to a transcription endpoint. Omitted
	 *  fields use the saved values; the saved key is only ever sent to the
	 *  saved endpoint. Master key only. */
	async testTranscription(
		input: { baseUrl?: string; model?: string; apiKey?: string } = {},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlTranscriptionTest> {
		return apiPost(
			this._opts,
			"/v1/admin/settings/transcription/test",
			input,
			undefined,
			"never",
			{ timeoutMs: 120_000, ...requestOptions },
		)
	}

	/** Sends a small orange square to a vision endpoint and asks its color.
	 *  Omitted fields use the saved values; the saved key is only ever sent
	 *  to the saved endpoint. Master key only. */
	async testVision(
		input: { baseUrl?: string; model?: string; apiKey?: string } = {},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlEndpointTest> {
		return apiPost(
			this._opts,
			"/v1/admin/settings/vision/test",
			input,
			undefined,
			"never",
			{ timeoutMs: 120_000, ...requestOptions },
		)
	}

	/** Sends a one-word prompt to a language model endpoint. Omitted fields
	 *  use the saved values; the saved key is only ever sent to the saved
	 *  endpoint. Master key only. */
	async testLlm(
		input: { baseUrl?: string; model?: string; apiKey?: string } = {},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlEndpointTest> {
		return apiPost(
			this._opts,
			"/v1/admin/settings/llm/test",
			input,
			undefined,
			"never",
			{ timeoutMs: 120_000, ...requestOptions },
		)
	}

	/** Checks a Slack user token (typed, or the saved one) without
	 *  importing anything. Master key only. */
	async testSlack(
		input: { token?: string } = {},
		requestOptions?: SqrrlRequestOptions,
	): Promise<SqrrlSlackCheck> {
		return apiPost(
			this._opts,
			"/v1/admin/settings/slack/test",
			input,
			undefined,
			"never",
			{ timeoutMs: 60_000, ...requestOptions },
		)
	}

	/** The Slack app manifest to paste into api.slack.com. Master key only. */
	async slackManifest(
		requestOptions?: SqrrlRequestOptions,
	): Promise<Record<string, unknown>> {
		return apiGet(
			this._opts,
			"/v1/admin/settings/slack/manifest",
			requestOptions,
		)
	}
}
