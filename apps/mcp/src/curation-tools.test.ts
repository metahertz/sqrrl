import { beforeEach, describe, expect, it, vi } from "vitest"
import { SqrrlClientError } from "@sqrrl/client"
import {
	type CurationClient,
	CURATION_TOOL_NAMES,
	curationTools,
	handleCurationTool,
} from "./curation-tools.js"
import { handleToolCall, toolList } from "./server.js"

const SCOPE = { scope: "workspace", scopeRef: "default" }

function task(slug: string, card: Record<string, unknown>, revision = 1) {
	return {
		slug,
		title: `Title ${slug}`,
		kind: "procedure",
		revision,
		taskCard: card,
	}
}

/** wikiList by kind/taskStatus over a fixed page set, paged like the API. */
function fakeClient(pages: Array<Record<string, unknown>>) {
	const byKey = (kind: string, status?: string) =>
		pages.filter(
			(p) =>
				p.kind === kind &&
				(!status ||
					(p.taskCard as { status?: string } | undefined)?.status === status),
		)
	const client = {
		wikiList: vi.fn(
			async (input: {
				kind?: string
				taskStatus?: string
				limit?: number
				skip?: number
			}) => {
				const all = byKey(input.kind ?? "", input.taskStatus)
				const skip = input.skip ?? 0
				return {
					pages: all.slice(skip, skip + (input.limit ?? 100)),
					total: all.length,
				}
			},
		),
		wikiGet: vi.fn(async (input: { slug: string }) => {
			const page = pages.find((p) => p.slug === input.slug)
			if (!page) throw new Error(`no wiki page "${input.slug}"`)
			return page
		}),
		wikiSetTaskStatus: vi.fn(async () => ({ ok: true })),
		wikiReassignTask: vi.fn(async () => ({ reassigned: true })),
		wikiEditRelationships: vi.fn(async () => ({ added: 1, removed: 0 })),
		wikiMerge: vi.fn(async () => ({ edgesRepointed: 2 })),
		rawSearch: vi.fn(async () => ({ results: [] })),
	}
	return client as typeof client & CurationClient
}

const payload = (r: { content: Array<{ text: string }> } | undefined) =>
	JSON.parse(r?.content[0]?.text ?? "null")

let pages: Array<Record<string, unknown>>
beforeEach(() => {
	pages = [
		task("tasks/a", { owner: "Dana", status: "open", dueDate: "2026-11-01" }),
		task("tasks/b", { owner: "Kai", status: "blocked", dueDate: "2026-12-01" }),
		task("tasks/c", { owner: "dana", status: "in-progress" }),
		task("tasks/d", { owner: "Dana", status: "done", dueDate: "2026-10-01" }),
		{ slug: "people/dana", title: "Dana", kind: "entity" },
		{ slug: "people/kai-smith", title: "Kai Smith", kind: "entity" },
		{ slug: "topics/oidc", title: "OIDC", kind: "concept" },
	]
})

describe("tool list", () => {
	it("adds the six curation tools after the wiki tools, with unique names", () => {
		const names = toolList.map((t) => t.name)
		expect(names).toEqual(expect.arrayContaining([...CURATION_TOOL_NAMES]))
		expect(new Set(names).size).toBe(names.length)
		expect(curationTools).toHaveLength(6)
		for (const tool of curationTools)
			expect(tool.inputSchema.required, tool.name).toEqual(
				expect.arrayContaining(["scope", "scopeRef"]),
			)
	})

	it("is reachable through the server's dispatcher", async () => {
		const client = fakeClient(pages)
		const out = await handleToolCall(
			"sqrrl_wiki_tasks",
			{ ...SCOPE },
			client as never,
		)
		expect(payload(out as never).matched).toBe(3)
	})

	it("leaves names it does not own to the server", async () => {
		expect(
			await handleCurationTool("sqrrl_wiki_get", {}, fakeClient([])),
		).toBeUndefined()
	})
})

describe("sqrrl_wiki_tasks", () => {
	const run = (args: Record<string, unknown>, client = fakeClient(pages)) =>
		handleCurationTool("sqrrl_wiki_tasks", { ...SCOPE, ...args }, client).then(
			payload,
		)

	it("lists unfinished tasks across statuses, soonest due first, undated last", async () => {
		const out = await run({ asOf: "2026-11-17" })
		expect(out.tasks.map((t: { slug: string }) => t.slug)).toEqual([
			"tasks/a",
			"tasks/b",
			"tasks/c",
		])
		expect(out.tasks[0]).toMatchObject({
			owner: "Dana",
			dueDate: "2026-11-01",
			overdue: true,
		})
		expect(out.tasks[1].overdue).toBe(false)
		expect(out).toMatchObject({ asOf: "2026-11-17", matched: 3, returned: 3 })
	})

	it("filters overdue, owner (case-insensitive), status and dueBefore", async () => {
		expect(
			(await run({ overdue: true, asOf: "2026-11-17" })).tasks.map(
				(t: { slug: string }) => t.slug,
			),
		).toEqual(["tasks/a"])
		expect(
			(await run({ owner: "DANA" })).tasks.map((t: { slug: string }) => t.slug),
		).toEqual(["tasks/a", "tasks/c"])
		expect(
			(await run({ status: "done" })).tasks.map(
				(t: { slug: string }) => t.slug,
			),
		).toEqual(["tasks/d"])
		// A done task is never overdue, however old its date.
		expect(
			(await run({ status: "done", asOf: "2026-11-17" })).tasks[0].overdue,
		).toBe(false)
		expect(
			(await run({ dueBefore: "2026-11-30" })).tasks.map(
				(t: { slug: string }) => t.slug,
			),
		).toEqual(["tasks/a"])
		expect((await run({ status: "all" })).matched).toBe(4)
	})

	it("pages through more tasks than one list call returns, and honors limit", async () => {
		pages = Array.from({ length: 230 }, (_, i) =>
			task(`tasks/t${String(i).padStart(3, "0")}`, {
				owner: "X",
				status: "open",
			}),
		)
		const client = fakeClient(pages)
		const out = await run({ limit: 500 }, client)
		expect(out.matched).toBe(230)
		expect(out.returned).toBe(200)
		expect(client.wikiList.mock.calls.length).toBeGreaterThanOrEqual(3)
	})

	it("rejects a bad status or date", async () => {
		await expect(run({ status: "later" })).rejects.toThrow(/status must be/)
		await expect(run({ asOf: "yesterday" })).rejects.toThrow(
			/asOf must be a date/,
		)
	})
})

describe("sqrrl_wiki_task_set_status", () => {
	it("re-sends the stored card with the new status, guarded by revision", async () => {
		pages[0] = task(
			"tasks/a",
			{ owner: "Dana", status: "open", dueDate: "2026-11-01" },
			7,
		)
		const client = fakeClient(pages)
		const out = payload(
			await handleCurationTool(
				"sqrrl_wiki_task_set_status",
				{ ...SCOPE, slug: "tasks/a", status: "done" },
				client,
			),
		)
		expect(client.wikiSetTaskStatus).toHaveBeenCalledWith({
			slug: "tasks/a",
			...SCOPE,
			status: "done",
			taskCard: { owner: "Dana", status: "open", dueDate: "2026-11-01" },
			expectedRevision: 7,
		})
		expect(out).toMatchObject({
			previousStatus: "open",
			status: "done",
			owner: "Dana",
		})
	})

	it("refuses a page that is not a task, and an unknown status", async () => {
		const client = fakeClient(pages)
		await expect(
			handleCurationTool(
				"sqrrl_wiki_task_set_status",
				{ ...SCOPE, slug: "topics/oidc", status: "done" },
				client,
			),
		).rejects.toThrow(/not a task page/)
		await expect(
			handleCurationTool(
				"sqrrl_wiki_task_set_status",
				{ ...SCOPE, slug: "tasks/a", status: "finished" },
				client,
			),
		).rejects.toThrow(/status must be one of/)
		expect(client.wikiSetTaskStatus).not.toHaveBeenCalled()
	})

	it("surfaces a revision conflict from the API as a structured tool error", async () => {
		const client = fakeClient(pages)
		client.wikiSetTaskStatus.mockRejectedValue(
			new SqrrlClientError(
				409,
				JSON.stringify({
					error: {
						code: "REVISION_CONFLICT",
						message: "moved past revision 1",
					},
				}),
			),
		)
		const out = await handleToolCall(
			"sqrrl_wiki_task_set_status",
			{ ...SCOPE, slug: "tasks/a", status: "done" },
			client as never,
		)
		expect("isError" in out && out.isError).toBe(true)
		expect(payload(out as never).error).toMatchObject({
			code: "REVISION_CONFLICT",
			status: 409,
		})
	})
})

describe("sqrrl_wiki_task_reassign", () => {
	const reassign = (owner: string, client = fakeClient(pages)) =>
		handleCurationTool(
			"sqrrl_wiki_task_reassign",
			{ ...SCOPE, slug: "tasks/a", owner },
			client,
		).then((r) => ({ out: payload(r), client }))

	it("resolves a person by slug, by derived slug, or by title", async () => {
		for (const owner of ["people/kai-smith", "Kai Smith", "kai smith"]) {
			const { client } = await reassign(owner)
			expect(client.wikiReassignTask, owner).toHaveBeenCalledWith({
				slug: "tasks/a",
				...SCOPE,
				owner: { name: "Kai Smith", hubSlug: "people/kai-smith" },
			})
		}
	})

	it("never invents a person page; it lists the closest instead", async () => {
		const client = fakeClient(pages)
		await expect(reassign("Kai Jones", client)).rejects.toThrow(
			/no person page for "Kai Jones".*closest: Kai Smith \(people\/kai-smith\)/,
		)
		expect(client.wikiReassignTask).not.toHaveBeenCalled()
	})
})

describe("sqrrl_wiki_link", () => {
	it("adds links with the target's stored title and removes by target", async () => {
		const client = fakeClient(pages)
		client.wikiEditRelationships.mockResolvedValue({
			added: 1,
			removed: 1,
			page: {
				body: "not returned to the agent",
				relationships: [
					{
						targetPageSlug: "topics/oidc",
						targetTitle: "OIDC",
						kind: "relates_to",
					},
				],
			},
		} as never)
		const out = await handleCurationTool(
			"sqrrl_wiki_link",
			{
				...SCOPE,
				slug: "tasks/a",
				add: [{ target: "topics/oidc", kind: "relates_to" }],
				remove: [{ target: "people/dana" }],
			},
			client,
		)
		expect(client.wikiEditRelationships).toHaveBeenCalledWith({
			slug: "tasks/a",
			...SCOPE,
			add: [
				{
					targetPageSlug: "topics/oidc",
					targetTitle: "OIDC",
					kind: "relates_to",
				},
			],
			remove: [{ targetPageSlug: "people/dana" }],
		})
		expect(payload(out)).toEqual({
			slug: "tasks/a",
			added: 1,
			removed: 1,
			links: [{ target: "topics/oidc", kind: "relates_to" }],
		})
	})

	it("refuses a link to a page that does not exist, and an empty edit", async () => {
		const client = fakeClient(pages)
		await expect(
			handleCurationTool(
				"sqrrl_wiki_link",
				{
					...SCOPE,
					slug: "tasks/a",
					add: [{ target: "topics/nope", kind: "relates_to" }],
				},
				client,
			),
		).rejects.toThrow(/no wiki page/)
		await expect(
			handleCurationTool(
				"sqrrl_wiki_link",
				{ ...SCOPE, slug: "tasks/a" },
				client,
			),
		).rejects.toThrow(/add and\/or remove/)
		expect(client.wikiEditRelationships).not.toHaveBeenCalled()
	})
})

describe("sqrrl_wiki_merge and sqrrl_raw_search", () => {
	it("merges distinct pages only", async () => {
		const client = fakeClient(pages)
		const out = payload(
			await handleCurationTool(
				"sqrrl_wiki_merge",
				{ ...SCOPE, from: "topics/a", into: "topics/b" },
				client,
			),
		)
		expect(client.wikiMerge).toHaveBeenCalledWith({
			from: "topics/a",
			into: "topics/b",
			...SCOPE,
		})
		expect(out).toMatchObject({
			from: "topics/a",
			into: "topics/b",
			edgesRepointed: 2,
		})
		await expect(
			handleCurationTool(
				"sqrrl_wiki_merge",
				{ ...SCOPE, from: "topics/a", into: "topics/a" },
				client,
			),
		).rejects.toThrow(/must differ/)
	})

	it("forwards raw search filters and drops empty ones", async () => {
		const client = fakeClient(pages)
		await handleCurationTool(
			"sqrrl_raw_search",
			{
				...SCOPE,
				query: "token",
				author: "Kai",
				channel: "",
				rerank: true,
				limit: 5,
			},
			client,
		)
		expect(client.rawSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "token",
				...SCOPE,
				author: "Kai",
				channel: undefined,
				rerank: true,
				limit: 5,
			}),
		)
	})
})
