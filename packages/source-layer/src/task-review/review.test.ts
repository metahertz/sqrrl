import { beforeEach, describe, expect, it, vi } from "vitest"

// The engine's page and search reads, raw search, and the stores, faked so
// the review logic can be driven end to end without a database.
type Page = Record<string, unknown> & {
	slug: string
	title: string
	kind: string
}
const engine = vi.hoisted(() => ({
	pages: new Map<string, Page>(),
	search: vi.fn(),
}))
const raw = vi.hoisted(() => ({ searchRawItems: vi.fn() }))
const store = vi.hoisted(() => ({
	ensureTaskReviewSchema: vi.fn(),
	getReviewState: vi.fn(),
	recordSuggestion: vi.fn(),
	markSuggestionsStale: vi.fn(),
	takeSourceQueue: vi.fn(),
	clearSourceQueueEntry: vi.fn(),
	markTasksForReview: vi.fn(),
	takePendingReviews: vi.fn(),
	finishReview: vi.fn(),
	tasksDueForSweep: vi.fn(),
}))

vi.mock("@sqrrl/wiki-engine", () => ({
	getWikiPage: async (_h: unknown, slug: string) => engine.pages.get(slug),
	searchWikiPages: engine.search,
}))
vi.mock("../raw-items.js", () => raw)
vi.mock("./store.js", () => store)

import { gatherEvidence, tasksForSourcePage } from "./candidates.js"
import { processQueue, reviewTask, sweep } from "./review.js"

const S = { scope: "workspace", scopeRef: "default" }
const handle = {} as never
const T0 = "2026-11-10T09:00:00.000Z"

function task(slug: string, extra: Partial<Page> = {}): Page {
	return {
		slug,
		title: `Task ${slug}`,
		kind: "procedure",
		createdAt: T0,
		updatedAt: T0,
		taskCard: { owner: "me", status: "open" },
		relationships: [],
		...extra,
	}
}

beforeEach(() => {
	engine.pages.clear()
	for (const f of [engine.search, raw.searchRawItems, ...Object.values(store)])
		f.mockReset()
	engine.search.mockResolvedValue({ results: [] })
	raw.searchRawItems.mockResolvedValue([])
	store.getReviewState.mockResolvedValue(null)
	store.recordSuggestion.mockImplementation(async (_h, p) => ({
		id: "s1",
		...p,
		status: "pending",
	}))
})

describe("tasksForSourcePage", () => {
	it("prefers same-source tasks, then people's tasks, and skips tasks from the same run", async () => {
		engine.pages.set("sources/slack/eng/2026-11-17", {
			slug: "sources/slack/eng/2026-11-17",
			title: "Exporter fixed",
			kind: "source",
			summary: "the exporter scrape works now",
			updatedAt: "2026-11-17T10:00:00.000Z",
			backlinks: [
				{ sourcePageSlug: "tasks/old-from-here" },
				{ sourcePageSlug: "tasks/new-from-here" },
			],
			relationships: [{ kind: "participant", targetPageSlug: "people/kai" }],
		})
		engine.pages.set("tasks/old-from-here", task("tasks/old-from-here"))
		// Extracted by the same distill run: not evidence for itself.
		engine.pages.set(
			"tasks/new-from-here",
			task("tasks/new-from-here", { createdAt: "2026-11-17T10:02:00.000Z" }),
		)
		engine.pages.set(
			"tasks/kai-exporter",
			task("tasks/kai-exporter", {
				relationships: [{ kind: "owned_by", targetPageSlug: "people/kai" }],
			}),
		)
		engine.pages.set("tasks/other", task("tasks/other"))
		engine.pages.set(
			"tasks/done-one",
			task("tasks/done-one", { taskCard: { status: "done" } }),
		)
		engine.search.mockResolvedValue({
			results: ["tasks/other", "tasks/done-one", "tasks/kai-exporter"].map(
				(s) => ({ page: engine.pages.get(s) }),
			),
		})
		const out = await tasksForSourcePage(handle, {
			...S,
			slug: "sources/slack/eng/2026-11-17",
		})
		expect(out).toEqual([
			"tasks/old-from-here",
			"tasks/kai-exporter",
			"tasks/other",
		])
		expect(engine.search.mock.calls[0][1]).toMatchObject({ kind: "procedure" })
	})

	it("after a dismissal, only considers evidence newer than it", async () => {
		const t = task("tasks/me-send-deck") as never
		await gatherEvidence(handle, t, {
			...S,
			notBefore: new Date("2026-11-17T12:00:00Z"),
		})
		expect(raw.searchRawItems.mock.calls[0][1].from).toEqual(
			new Date("2026-11-17T12:00:00Z"),
		)
	})

	it("ignores task pages as sources", async () => {
		engine.pages.set("tasks/a", task("tasks/a"))
		expect(await tasksForSourcePage(handle, { ...S, slug: "tasks/a" })).toEqual(
			[],
		)
	})
})

describe("gatherEvidence", () => {
	it("takes raw text newer than the task first, then newer non-task pages, minus dismissed", async () => {
		raw.searchRawItems.mockResolvedValue([
			{
				item: {
					id: "r1",
					source: "email",
					title: "Re: deck",
					text: "Sent it.",
					occurredAt: new Date("2026-11-17T09:00:00Z"),
					author: "me",
				},
			},
			{
				item: {
					id: "r2",
					source: "slack",
					text: "dismissed one",
					occurredAt: new Date("2026-11-17T09:00:00Z"),
				},
			},
		])
		engine.pages.set("meetings/m", {
			slug: "meetings/m",
			title: "Sync",
			kind: "source",
			updatedAt: "2026-11-16T00:00:00.000Z",
			summary: "Meeting on 2026-11-16",
			frontmatter: {
				type: "meeting",
				status: "deprecated",
				meeting: { start: "2026-11-16T10:00:00Z" },
			},
		})
		engine.search.mockResolvedValue({
			results: [
				{ page: task("tasks/x") },
				{
					page: {
						slug: "sources/old",
						title: "old",
						kind: "source",
						updatedAt: "2026-11-01T00:00:00.000Z",
						summary: "before the task",
					},
				},
			],
		})
		const t = task("tasks/me-send-deck") as never
		const out = await gatherEvidence(handle, t, {
			...S,
			hints: ["meetings/m"],
			dismissed: ["raw:r2"],
		})
		expect(out.map((e) => e.key)).toEqual(["raw:r1", "page:meetings/m"])
		expect(out[1].text).toContain("REMOVED from the calendar (cancelled)")
		expect(raw.searchRawItems.mock.calls[0][1].from).toEqual(
			new Date(Date.parse(T0) + 10 * 60_000),
		)
	})
})

describe("reviewTask", () => {
	const judge = vi.fn()
	beforeEach(() => {
		judge.mockReset()
		engine.pages.set(
			"tasks/me-send-deck",
			task("tasks/me-send-deck", { title: "Send the deck to Adyen" }),
		)
		raw.searchRawItems.mockResolvedValue([
			{
				item: {
					id: "r1",
					source: "email",
					title: "Re: deck",
					text: "Sent the deck to Adyen this morning.",
					occurredAt: new Date("2026-11-17T09:00:00Z"),
				},
			},
		])
	})

	it("records a grounded verdict as a suggestion", async () => {
		judge.mockResolvedValue({
			verdict: "done",
			confidence: 0.92,
			evidence: ["E1"],
			quote: "Sent the deck to Adyen this morning",
			rationale: "sent",
		})
		const out = await reviewTask(
			handle,
			{ judge },
			{ ...S, slug: "tasks/me-send-deck" },
		)
		expect(out.result).toBe("suggested")
		expect(store.recordSuggestion).toHaveBeenCalledWith(
			handle,
			expect.objectContaining({
				taskSlug: "tasks/me-send-deck",
				proposed: "done",
				confidence: 0.92,
			}),
		)
		expect(judge.mock.calls[0][1]).toContain("Task: Send the deck to Adyen")
	})

	it("makes no suggestion from an ungrounded or negative verdict, or without evidence", async () => {
		judge.mockResolvedValue({
			verdict: "done",
			confidence: 0.95,
			evidence: ["E1"],
			quote: "made up",
		})
		expect(
			(
				await reviewTask(
					handle,
					{ judge },
					{ ...S, slug: "tasks/me-send-deck" },
				)
			).result,
		).toBe("no-verdict")
		raw.searchRawItems.mockResolvedValue([])
		judge.mockClear()
		expect(
			(
				await reviewTask(
					handle,
					{ judge },
					{ ...S, slug: "tasks/me-send-deck" },
				)
			).result,
		).toBe("no-evidence")
		expect(judge).not.toHaveBeenCalled()
		expect(store.recordSuggestion).not.toHaveBeenCalled()
	})

	it("marks suggestions stale for a task that is no longer open", async () => {
		engine.pages.set(
			"tasks/me-send-deck",
			task("tasks/me-send-deck", { taskCard: { status: "done" } }),
		)
		expect(
			(
				await reviewTask(
					handle,
					{ judge },
					{ ...S, slug: "tasks/me-send-deck" },
				)
			).result,
		).toBe("not-open")
		expect(store.markSuggestionsStale).toHaveBeenCalled()
	})
})

describe("processQueue and sweep", () => {
	it("expands queued pages into marked tasks, reviews pending ones, and backs off on errors", async () => {
		engine.pages.set("sources/p", {
			slug: "sources/p",
			title: "p",
			kind: "source",
			updatedAt: "2026-11-17T00:00:00.000Z",
			backlinks: [{ sourcePageSlug: "tasks/a" }],
		})
		engine.pages.set("tasks/a", task("tasks/a"))
		const at = new Date()
		store.takeSourceQueue.mockResolvedValue([
			{ _id: "q1", sourceSlug: "sources/p", enqueuedAt: at },
		])
		store.takePendingReviews.mockResolvedValue([
			{ _id: "r1", taskSlug: "tasks/a" },
			{ _id: "r2", taskSlug: "tasks/gone", attempts: 2 },
		])
		const judge = vi.fn().mockRejectedValue(new Error("llm down"))
		raw.searchRawItems.mockResolvedValue([
			{
				item: {
					id: "x",
					source: "slack",
					text: "done",
					occurredAt: new Date("2026-11-17T00:00:00Z"),
				},
			},
		])
		const out = await processQueue(handle, { judge }, { ...S, limit: 5 })
		expect(store.markTasksForReview).toHaveBeenCalledWith(handle, {
			...S,
			limit: 5,
			taskSlugs: ["tasks/a"],
			reason: "evidence",
			hint: "sources/p",
		})
		expect(store.clearSourceQueueEntry).toHaveBeenCalledWith(handle, "q1", at)
		expect(out).toMatchObject({
			sourcesExpanded: 1,
			tasksMarked: 1,
			reviewed: 1,
		})
		expect(out.errors).toEqual(["tasks/a: llm down"])
		expect(store.finishReview).toHaveBeenCalledWith(handle, "r1", "llm down", 0)
		expect(store.finishReview).toHaveBeenCalledWith(handle, "r2")
	})

	it("takes sourceLimit pages and reviews tasks side by side", async () => {
		store.takeSourceQueue.mockResolvedValue([])
		const slugs = ["tasks/a", "tasks/b", "tasks/c", "tasks/d", "tasks/e"]
		store.takePendingReviews.mockResolvedValue(
			slugs.map((taskSlug, i) => ({ _id: `r${i}`, taskSlug })),
		)
		let inFlight = 0
		let peak = 0
		const finish = store.finishReview.getMockImplementation()
		store.finishReview.mockImplementation(async (...args: unknown[]) => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await new Promise((r) => setTimeout(r, 5))
			inFlight--
			return finish?.(...(args as []))
		})
		const out = await processQueue(
			handle,
			{ judge: vi.fn() },
			{ ...S, limit: 5, sourceLimit: 200, concurrency: 3 },
		)
		expect(store.takeSourceQueue).toHaveBeenCalledWith(handle, {
			...S,
			limit: 200,
		})
		expect(out.reviewed).toBe(5)
		expect(store.finishReview).toHaveBeenCalledTimes(5)
		expect(peak).toBe(3)
	})

	it("sweep marks stale open tasks and then processes them", async () => {
		store.tasksDueForSweep.mockResolvedValue(["tasks/a", "tasks/b"])
		store.takeSourceQueue.mockResolvedValue([])
		store.takePendingReviews.mockResolvedValue([])
		const out = await sweep(
			handle,
			{ judge: vi.fn(), now: () => new Date("2026-11-18T03:00:00Z") },
			{ ...S, limit: 2 },
		)
		expect(out.swept).toBe(2)
		expect(store.tasksDueForSweep).toHaveBeenCalledWith(
			handle,
			expect.objectContaining({ limit: 2, staleDays: 7, today: "2026-11-18" }),
		)
		expect(store.markTasksForReview).toHaveBeenCalledWith(
			handle,
			expect.objectContaining({
				taskSlugs: ["tasks/a", "tasks/b"],
				reason: "sweep",
			}),
		)
	})
})
