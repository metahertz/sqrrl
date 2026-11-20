import { afterEach, describe, expect, it, vi } from "vitest"
import { SqrrlClient } from "./index.js"

describe("SqrrlClient public contract", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("does not expose the retired memory (memongo) surface", () => {
		const client = new SqrrlClient()
		for (const method of [
			"status",
			"probeEmbedding",
			"probeVector",
			"add",
			"search",
			"searchDetailed",
			"writeEvent",
			"writeStructured",
			"recallConversation",
			"buildContextBundle",
			"profile",
			"state",
		]) {
			expect(client, method).not.toHaveProperty(method)
		}
	})

	it("bounds requests with the default deadline", async () => {
		vi.useFakeTimers()
		const fetchMock = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					)
				}),
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const request = client.wikiSearch({
			query: "deadline",
			scope: "workspace",
			scopeRef: "default",
		})
		const rejection = expect(request).rejects.toMatchObject({
			code: "DEADLINE_EXCEEDED",
		})
		await vi.advanceTimersByTimeAsync(10_000)

		await rejection
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("cancels a call from the caller signal", async () => {
		const fetchMock = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					)
				}),
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()
		const controller = new AbortController()

		const request = client.wikiSearch(
			{ query: "cancel", scope: "workspace", scopeRef: "default" },
			{ signal: controller.signal },
		)
		const rejection = expect(request).rejects.toMatchObject({
			code: "REQUEST_ABORTED",
		})
		controller.abort()

		await rejection
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("retries a safe read after a transient response", async () => {
		vi.useFakeTimers()
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ results: [] }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const request = client.wikiSearch({
			query: "retry",
			scope: "workspace",
			scopeRef: "default",
		})
		await vi.advanceTimersByTimeAsync(200)

		await expect(request).resolves.toEqual({ results: [] })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("does not retry a mutation without an idempotency contract", async () => {
		vi.useFakeTimers()
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("busy", { status: 503 }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const request = client.wikiMerge({
			from: "people/a",
			into: "people/b",
			scope: "workspace",
			scopeRef: "default",
		})
		const rejection = expect(request).rejects.toMatchObject({ status: 503 })
		await vi.advanceTimersByTimeAsync(1_000)

		await rejection
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("retries a safe read after a transport failure", async () => {
		vi.useFakeTimers()
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("connection reset"))
			.mockResolvedValueOnce(Response.json({ results: [] }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const request = client.wikiSearch({
			query: "transport retry",
			scope: "workspace",
			scopeRef: "default",
		})
		const resolution = expect(request).resolves.toEqual({ results: [] })
		await vi.advanceTimersByTimeAsync(200)

		await resolution
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("retries a safe read when the response body transport fails", async () => {
		vi.useFakeTimers()
		const brokenBody = new ReadableStream({
			start(controller) {
				controller.error(new TypeError("body connection reset"))
			},
		})
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(brokenBody, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(Response.json({ results: [] }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const request = client.wikiSearch({
			query: "body retry",
			scope: "workspace",
			scopeRef: "default",
		})
		const resolution = expect(request).resolves.toEqual({ results: [] })
		await vi.advanceTimersByTimeAsync(200)

		await resolution
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("honors Retry-After when it fits a per-call deadline", async () => {
		vi.useFakeTimers()
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response("rate limited", {
					status: 429,
					headers: { "Retry-After": "1" },
				}),
			)
			.mockResolvedValueOnce(Response.json({ results: [] }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient({ defaultDeadlineMs: 50 })

		const request = client.wikiSearch(
			{ query: "retry after", scope: "workspace", scopeRef: "default" },
			{ timeoutMs: 1_500 },
		)
		const resolution = expect(request).resolves.toEqual({ results: [] })
		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)

		await resolution
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("does not wait for Retry-After beyond the call deadline", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("rate limited", {
				status: 429,
				headers: { "Retry-After": "2" },
			}),
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await expect(
			client.wikiSearch(
				{ query: "too late", scope: "workspace", scopeRef: "default" },
				{ timeoutMs: 500 },
			),
		).rejects.toMatchObject({ status: 429 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("shares one deadline across wiki apply create and update attempts", async () => {
		vi.useFakeTimers()
		let patchSignal: AbortSignal | null = null
		const fetchMock = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) => {
				if (!patchSignal) {
					patchSignal = init?.signal ?? null
					return new Promise<Response>((resolve) => {
						setTimeout(
							() => resolve(new Response("duplicate", { status: 409 })),
							800,
						)
					})
				}
				patchSignal = init?.signal ?? null
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					)
				})
			},
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const request = client.wikiApply(
			{
				kind: "note",
				title: "Deadline",
				slug: "deadline",
				summary: "Deadline",
				body: "Deadline",
				frontmatter: { type: "note" },
				scope: "workspace",
				scopeRef: "test",
				trustTier: "standard",
			},
			{ timeoutMs: 1_000 },
		)
		const rejection = expect(request).rejects.toMatchObject({
			code: "DEADLINE_EXCEEDED",
		})
		await vi.advanceTimersByTimeAsync(800)
		await vi.advanceTimersByTimeAsync(200)
		const abortedAtDeadline = patchSignal?.aborted
		await vi.advanceTimersByTimeAsync(800)

		await rejection
		expect(abortedAtDeadline).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("does not start a wiki update after its deadline is exhausted", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("duplicate", { status: 409 }))
			.mockResolvedValueOnce(Response.json({ ok: true }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await expect(
			client.wikiApply(
				{
					kind: "note",
					title: "Expired",
					slug: "expired",
					summary: "Expired",
					body: "Expired",
					frontmatter: { type: "note" },
					scope: "workspace",
					scopeRef: "test",
					trustTier: "standard",
				},
				{ timeoutMs: 0 },
			),
		).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" })
		expect(fetchMock).toHaveBeenCalledTimes(0)
	})

	it("wikiApply update fallback sends the observed revision as a CAS precondition", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(
					{
						error: {
							code: "DUPLICATE_SLUG",
							message: 'wiki page slug "cas" already exists',
						},
					},
					{ status: 409 },
				),
			)
			.mockResolvedValueOnce(Response.json({ slug: "cas", revision: 3 }))
			.mockResolvedValueOnce(Response.json({ slug: "cas", revision: 4 }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const result = await client.wikiApply({
			kind: "note",
			title: "CAS",
			slug: "cas",
			summary: "CAS",
			body: "CAS",
			frontmatter: { type: "note" },
			scope: "workspace",
			scopeRef: "test",
			trustTier: "standard",
		})

		expect(result).toMatchObject({ revision: 4 })
		expect(fetchMock).toHaveBeenCalledTimes(3)
		// Call 0 is the create attempt (409 DUPLICATE_SLUG); the fallback then
		// GETs the observed state and PATCHes with it as the precondition.
		const getUrl = fetchMock.mock.calls[1]?.[0]
		const patchUrl = fetchMock.mock.calls[2]?.[0]
		const patchInit = fetchMock.mock.calls[2]?.[1]
		expect(String(getUrl)).toContain("/v1/wiki/cas?scope=workspace")
		expect(String(patchUrl)).toContain("/v1/wiki/cas")
		expect(patchInit?.method).toBe("PATCH")
		expect(JSON.parse(String(patchInit?.body))).toMatchObject({
			expectedRevision: 3,
			title: "CAS",
		})
	})

	it("keeps slug separators in the path so a slashed slug is not 404ed", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ slug: "x" }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await client.wikiGet({
			slug: "sources/notes/a.md",
			scope: "workspace",
			scopeRef: "brain",
		})
		// %2F here would be looked up literally: the server splits the path on
		// "/wiki/" and does not decode what it finds.
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/v1/wiki/sources/notes/a.md?",
		)
		expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("%2F")
	})

	it("still escapes path-unsafe characters inside a slug segment", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ slug: "x" }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await client.wikiGet({
			slug: "topics/a b",
			scope: "workspace",
			scopeRef: "brain",
		})
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/v1/wiki/topics/a%20b?",
		)
	})

	it("wikiSetTaskStatus re-sends the whole card so owner and due date survive", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ slug: "tasks/t", revision: 8 }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await client.wikiSetTaskStatus({
			slug: "tasks/fix-mic",
			scope: "workspace",
			scopeRef: "brain",
			status: "done",
			taskCard: {
				owner: "lauren",
				status: "open",
				dueDate: "2026-09-18",
				sourceRef: "sources/notes/a.md",
			},
			expectedRevision: 8,
		})

		const init = fetchMock.mock.calls[0]?.[1]
		expect(init?.method).toBe("PATCH")
		const body = JSON.parse(String(init?.body)) as {
			taskCard: Record<string, unknown>
			expectedRevision: number
		}
		// updateWikiPage replaces taskCard wholesale; dropping any of these
		// would silently erase them from the page.
		expect(body.taskCard).toMatchObject({
			owner: "lauren",
			status: "done",
			dueDate: "2026-09-18",
			sourceRef: "sources/notes/a.md",
		})
		expect(body.expectedRevision).toBe(8)
	})

	it("wikiSetTaskStatus stamps completedAt on done and clears it on reopen", async () => {
		// A fresh Response per call: a body can only be read once, so a single
		// shared instance fails the second request with "Body is unusable".
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				Response.json({ slug: "tasks/t", revision: 2 }),
			)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()
		const card = { owner: "priya", status: "open" }

		await client.wikiSetTaskStatus({
			slug: "t",
			scope: "workspace",
			scopeRef: "brain",
			status: "done",
			taskCard: card,
		})
		const done = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			taskCard: { completedAt: string | null }
		}
		expect(typeof done.taskCard.completedAt).toBe("string")

		await client.wikiSetTaskStatus({
			slug: "t",
			scope: "workspace",
			scopeRef: "brain",
			status: "open",
			taskCard: {
				...card,
				status: "done",
				completedAt: done.taskCard.completedAt,
			},
		})
		const reopened = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
			taskCard: { completedAt: string | null; status: string }
		}
		expect(reopened.taskCard.completedAt).toBeNull()
		expect(reopened.taskCard.status).toBe("open")
	})

	it("wikiSetTaskStatus omits the CAS precondition when no revision is known", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ slug: "t" }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await client.wikiSetTaskStatus({
			slug: "t",
			scope: "workspace",
			scopeRef: "brain",
			status: "done",
			taskCard: { owner: "x" },
		})
		const body = JSON.parse(
			String(fetchMock.mock.calls[0]?.[1]?.body),
		) as Record<string, unknown>
		expect(body).not.toHaveProperty("expectedRevision")
	})

	it("wikiApply surfaces REVISION_CONFLICT from the update fallback instead of overwriting", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(
					{
						error: {
							code: "DUPLICATE_SLUG",
							message: 'wiki page slug "cas" already exists',
						},
					},
					{ status: 409 },
				),
			)
			.mockResolvedValueOnce(Response.json({ slug: "cas", revision: 3 }))
			.mockResolvedValueOnce(
				Response.json(
					{
						error: {
							code: "REVISION_CONFLICT",
							message:
								'wiki page "cas" moved past revision 3 — concurrent update',
						},
					},
					{ status: 409 },
				),
			)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await expect(
			client.wikiApply({
				kind: "note",
				title: "Stale",
				slug: "cas",
				summary: "Stale",
				body: "Stale",
				frontmatter: { type: "note" },
				scope: "workspace",
				scopeRef: "test",
				trustTier: "standard",
			}),
		).rejects.toMatchObject({
			status: 409,
			envelope: { code: "REVISION_CONFLICT" },
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it("wikiApply treats only DUPLICATE_SLUG as the update trigger", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			Response.json(
				{
					error: {
						code: "REVISION_CONFLICT",
						message: "stale precondition",
					},
				},
				{ status: 409 },
			),
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await expect(
			client.wikiApply({
				kind: "note",
				title: "X",
				slug: "x",
				summary: "X",
				body: "X",
				frontmatter: { type: "note" },
				scope: "workspace",
				scopeRef: "test",
				trustTier: "standard",
			}),
		).rejects.toMatchObject({ status: 409 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("wikiApply falls back to a plain update when the GET hits a 404 (page vanished mid-upsert)", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json(
					{
						error: {
							code: "DUPLICATE_SLUG",
							message: 'wiki page slug "ghost" already exists',
						},
					},
					{ status: 409 },
				),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ error: { code: "WIKI_NOT_FOUND", message: "no page" } },
					{ status: 404 },
				),
			)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await expect(
			client.wikiApply({
				kind: "note",
				title: "Ghost",
				slug: "ghost",
				summary: "Ghost",
				body: "Ghost",
				frontmatter: { type: "note" },
				scope: "workspace",
				scopeRef: "test",
				trustTier: "standard",
			}),
		).rejects.toMatchObject({ status: 404 })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("wikiGet URL-encodes path-unsafe slugs and forwards transclude", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ slug: "tables/a b" }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await client.wikiGet({
			slug: "tables/a b?c",
			scope: "workspace",
			scopeRef: "ws-1",
			transclude: true,
		})

		const url = String(fetchMock.mock.calls[0]?.[0])
		// Segments are escaped; the separator is not. This previously asserted
		// encodeURIComponent over the whole slug, i.e. "tables%2Fa%20b%3Fc",
		// which the server can never match: it recovers the slug by splitting
		// the path on "/wiki/" and does not percent-decode the remainder, so
		// every slashed slug answered 404.
		expect(url).toContain("/v1/wiki/tables/a%20b%3Fc?")
		expect(url).not.toContain("%2F")
		expect(url).toContain("transclude=true")
		expect(url).toContain("scope=workspace")
	})

	it("wikiGet with format=markdown resolves to the raw rendered string", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response("# Accounts Table\n\n- id: uuid", {
				status: 200,
				headers: { "Content-Type": "text/markdown" },
			}),
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const out = await client.wikiGet({
			slug: "tables/accounts",
			scope: "workspace",
			scopeRef: "ws-1",
			format: "markdown",
		})

		expect(out).toBe("# Accounts Table\n\n- id: uuid")
	})

	it("wikiDelete URL-encodes path-unsafe slugs", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			Response.json({
				ok: true,
				slug: "x",
				scope: "s",
				scopeRef: "r",
				hard: false,
			}),
		)
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		await client.wikiDelete({
			slug: "tables/a b",
			scope: "workspace",
			scopeRef: "ws-1",
		})

		const url = String(fetchMock.mock.calls[0]?.[0])
		expect(url).toContain("/v1/wiki/tables/a%20b?")
		expect(url).not.toContain("%2F")
	})
})

describe("wiki graph maintenance", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function stubOk(body: unknown) {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		)
		vi.stubGlobal("fetch", fetchMock)
		return fetchMock
	}

	const scope = { scope: "workspace", scopeRef: "default" }

	it("sends removals and additions in one relationships call", async () => {
		const fetchMock = stubOk({ removed: 1, added: 1, page: {} })
		const client = new SqrrlClient({ baseUrl: "http://x", apiKey: "k" })
		const res = await client.wikiEditRelationships({
			slug: "tasks/a",
			...scope,
			add: [
				{ targetPageSlug: "topics/b", targetTitle: "B", kind: "relates_to" },
			],
			remove: [{ targetPageSlug: "topics/c", kind: "relates_to" }],
		})
		expect(res).toEqual({ removed: 1, added: 1, page: {} })
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(String(url)).toContain("/v1/wiki/relationships")
		const sent = JSON.parse(String(init.body))
		// Both halves travel together so one call can move an edge.
		expect(sent.add).toHaveLength(1)
		expect(sent.remove).toHaveLength(1)
	})

	it("omitting kind on a removal removes every edge to that target", async () => {
		const fetchMock = stubOk({ removed: 2, added: 0, page: {} })
		const client = new SqrrlClient({ baseUrl: "http://x", apiKey: "k" })
		await client.wikiEditRelationships({
			slug: "tasks/a",
			...scope,
			remove: [{ targetPageSlug: "topics/b" }],
		})
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body)).remove[0].kind).toBeUndefined()
	})

	it("posts a merge with both slugs", async () => {
		const fetchMock = stubOk({
			edgesRepointed: 3,
			inboundPagesTouched: 2,
			outboundEdgesMoved: 1,
			claimsMoved: 0,
			errors: [],
		})
		const client = new SqrrlClient({ baseUrl: "http://x", apiKey: "k" })
		const res = await client.wikiMerge({
			from: "topics/a",
			into: "topics/b",
			...scope,
		})
		expect(res.edgesRepointed).toBe(3)
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(String(url)).toContain("/v1/wiki/merge")
		expect(JSON.parse(String(init.body))).toMatchObject({
			from: "topics/a",
			into: "topics/b",
		})
	})

	it("carries the owner hub slug rather than only a name", async () => {
		const fetchMock = stubOk({
			ownerChanged: true,
			sourceChanged: false,
			edgesAdded: 1,
			edgesRemoved: 1,
		})
		const client = new SqrrlClient({ baseUrl: "http://x", apiKey: "k" })
		await client.wikiReassignTask({
			slug: "tasks/a",
			...scope,
			owner: { name: "Dana", hubSlug: "people/dana" },
		})
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		// Without the hub slug the server would have to guess, and guessing
		// creates a second page for someone who already has one.
		expect(JSON.parse(String(init.body)).owner).toEqual({
			name: "Dana",
			hubSlug: "people/dana",
		})
	})
	it("posts raw writes and searches to the Layer 1 routes, retrying safely", async () => {
		vi.useFakeTimers()
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ created: 1 }))
			.mockResolvedValueOnce(Response.json({ results: [] }))
		vi.stubGlobal("fetch", fetchMock)
		const client = new SqrrlClient()

		const write = client.rawWrite({
			scope: "workspace",
			scopeRef: "default",
			items: [
				{ source: "slack", sourceId: "C1/1.2", kind: "message", text: "hi" },
			],
		})
		await vi.advanceTimersByTimeAsync(200)
		await expect(write).resolves.toEqual({ created: 1 })
		await client.rawSearch({
			query: "hi",
			scope: "workspace",
			scopeRef: "default",
			channel: "C1",
			rerank: true,
		})

		const calls = fetchMock.mock.calls.map(([url, init]) => [
			new URL(String(url)).pathname,
			JSON.parse(String(init?.body)),
		])
		// A raw write is content-idempotent, so a transient failure is retried.
		expect(calls[0]).toEqual(calls[1])
		expect(calls[1]).toEqual([
			"/v1/raw/items",
			{
				scope: "workspace",
				scopeRef: "default",
				items: [
					{ source: "slack", sourceId: "C1/1.2", kind: "message", text: "hi" },
				],
			},
		])
		expect(calls[2]).toEqual([
			"/v1/raw/search",
			{
				query: "hi",
				scope: "workspace",
				scopeRef: "default",
				channel: "C1",
				rerank: true,
			},
		])
	})
})
