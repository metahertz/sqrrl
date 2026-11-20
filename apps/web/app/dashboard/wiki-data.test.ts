import { describe, expect, it, vi } from "vitest"
import type { WikiPage } from "./shared.js"
import {
	buildBuckets,
	fetchAllPages,
	filterRows,
	isOverdue,
	sourceEdgeLabel,
	tasksByOwner,
} from "./wiki-data.js"

const page = (p: Partial<WikiPage> & { slug: string }): WikiPage => ({
	title: p.slug,
	kind: "source",
	...p,
})

function clientReturning(total: number) {
	const all = Array.from({ length: total }, (_, i) =>
		page({ slug: `p${i}`, kind: "source" }),
	)
	const wikiList = vi.fn(async ({ skip = 0, limit = 100 }) => ({
		pages: all.slice(skip, skip + limit),
		total,
	}))
	return { client: { wikiList } as never, wikiList, all }
}

describe("fetchAllPages", () => {
	it("pages through a scope larger than the server's 100-row clamp", async () => {
		const { client, wikiList } = clientReturning(298)
		const res = await fetchAllPages(client, "workspace", "default")
		expect(res.pages).toHaveLength(298)
		expect(res.total).toBe(298)
		expect(res.truncated).toBe(false)
		expect(wikiList).toHaveBeenCalledTimes(3)
	})

	it("makes a single request when everything fits", async () => {
		const { client, wikiList } = clientReturning(12)
		const res = await fetchAllPages(client, "workspace", "default")
		expect(res.pages).toHaveLength(12)
		expect(wikiList).toHaveBeenCalledTimes(1)
	})

	it("stops on a short page instead of looping when total overstates", async () => {
		// A total that never matches the rows returned would otherwise spin on
		// the same skip forever.
		const wikiList = vi.fn(async ({ skip = 0 }) => ({
			pages: skip === 0 ? [page({ slug: "a" })] : [],
			total: 9999,
		}))
		const res = await fetchAllPages(
			{ wikiList } as never,
			"workspace",
			"default",
		)
		expect(res.pages).toHaveLength(1)
		expect(res.truncated).toBe(true)
		expect(wikiList).toHaveBeenCalledTimes(2)
	})
})

describe("task views", () => {
	const today = "2026-09-07"
	const tasks = [
		page({
			slug: "t1",
			kind: "procedure",
			taskCard: { owner: "Priya", status: "open", dueDate: "2026-09-01" },
		}),
		page({
			slug: "t2",
			kind: "procedure",
			taskCard: { owner: "priya", status: "open", dueDate: "2026-09-20" },
		}),
		page({
			slug: "t3",
			kind: "procedure",
			taskCard: { owner: "Sam", status: "done", dueDate: "2026-09-01" },
		}),
		page({ slug: "t4", kind: "procedure", taskCard: { status: "open" } }),
	]

	it("counts a past due date as overdue only while the task is open", () => {
		expect(isOverdue(tasks[0], today)).toBe(true)
		// Done in the past is not overdue — it is finished.
		expect(isOverdue(tasks[2], today)).toBe(false)
		expect(isOverdue(tasks[1], today)).toBe(false)
	})

	it("groups owners case-insensitively so one person is one bucket", () => {
		const byOwner = tasksByOwner(tasks)
		expect(byOwner.get("priya")).toHaveLength(2)
		expect(byOwner.get("unassigned")).toHaveLength(1)
	})
})

describe("buildBuckets", () => {
	const pages = [
		page({ slug: "n1", kind: "source", relationships: [] }),
		page({
			slug: "t-late",
			kind: "procedure",
			taskCard: { owner: "me", status: "open", dueDate: "2000-01-01" },
			relationships: [{ targetPageSlug: "n1", kind: "derived_from" }],
		}),
		page({
			slug: "t-none",
			kind: "procedure",
			taskCard: { owner: "me", status: "open" },
			relationships: [{ targetPageSlug: "n1", kind: "derived_from" }],
		}),
		page({
			slug: "t-done",
			kind: "procedure",
			taskCard: { owner: "me", status: "done" },
			relationships: [{ targetPageSlug: "n1", kind: "derived_from" }],
		}),
		page({ slug: "topics/lonely", kind: "concept", backlinks: [] }),
		page({ slug: "people/me", kind: "entity", backlinks: [] }),
	]
	const byId = Object.fromEntries(buildBuckets(pages).map((b) => [b.id, b]))

	it("separates open, overdue and undated tasks", () => {
		expect(byId.open.pages.map((p) => p.slug).sort()).toEqual([
			"t-late",
			"t-none",
		])
		expect(byId.overdue.pages.map((p) => p.slug)).toEqual(["t-late"])
		expect(byId.unscheduled.pages.map((p) => p.slug)).toEqual(["t-none"])
		expect(byId.done.pages.map((p) => p.slug)).toEqual(["t-done"])
	})

	it("keeps calendar meetings out of notes, newest first", () => {
		const withMeetings = buildBuckets([
			...pages,
			page({ slug: "meetings/2026-11-03-standup", kind: "source" }),
			page({ slug: "meetings/2026-11-17-standup", kind: "source" }),
		])
		const ids = Object.fromEntries(withMeetings.map((b) => [b.id, b]))
		expect(ids.notes.pages.map((p) => p.slug)).toEqual(["n1"])
		expect(ids.meetings.pages.map((p) => p.slug)).toEqual([
			"meetings/2026-11-17-standup",
			"meetings/2026-11-03-standup",
		])
	})

	it("flags hubs that join nothing", () => {
		expect(byId.topics.note).toContain("joining nothing")
	})

	it("lists pages with no edges in either direction as unlinked", () => {
		// n1 has backlinks from the tasks pointing at it in the real store, but
		// this fixture gives it none, so it counts as unlinked alongside the
		// isolated hubs.
		expect(byId.orphans.pages.map((p) => p.slug).sort()).toEqual([
			"n1",
			"people/me",
			"topics/lonely",
		])
	})
})

describe("sourceEdgeLabel", () => {
	const task = (rels: WikiPage["relationships"], sourceRef?: string) =>
		page({
			slug: "tasks/me-ship-it",
			kind: "procedure",
			relationships: rels,
			taskCard: sourceRef ? { owner: "me", sourceRef } : { owner: "me" },
		})

	it("names the note behind a task from the derived_from edge", () => {
		expect(
			sourceEdgeLabel(
				task([
					{
						targetPageSlug: "sources/apple-notes/95b8b0bc.md",
						targetTitle: "Laura 1x1",
						kind: "derived_from",
					},
				]),
			),
		).toBe("Laura 1x1")
	})

	it("ignores edges that are not the source edge", () => {
		expect(
			sourceEdgeLabel(
				task([
					{ targetPageSlug: "people/taylor", kind: "owned_by" },
					{
						targetPageSlug: "sources/notes/a.md",
						targetTitle: "Sept / Oct",
						kind: "derived_from",
					},
				]),
			),
		).toBe("Sept / Oct")
	})

	it("falls back to the slug's last segment when the edge carries no title", () => {
		expect(
			sourceEdgeLabel(
				task([
					{
						targetPageSlug: "sources/apple-notes/95b8b0bc.md",
						kind: "derived_from",
					},
				]),
			),
		).toBe("95b8b0bc.md")
	})

	it("falls back to taskCard.sourceRef when there is no edge at all", () => {
		expect(sourceEdgeLabel(task([], "sources/meetings/sprint.md"))).toBe(
			"sprint.md",
		)
	})

	it("returns null when nothing names a source", () => {
		expect(sourceEdgeLabel(task([]))).toBeNull()
		expect(sourceEdgeLabel(page({ slug: "sources/a.md" }))).toBeNull()
	})
})

describe("filterRows", () => {
	const t = (slug: string, owner: string, source: string, title = slug) =>
		page({
			slug,
			title,
			kind: "procedure",
			taskCard: { owner },
			relationships: [
				{
					targetPageSlug: `sources/${source}.md`,
					targetTitle: source,
					kind: "derived_from",
				},
			],
		})

	const rows = [
		t("tasks/a", "me", "Laura 1x1", "Book the room"),
		t("tasks/b", "Taylor", "Laura 1x1", "Send the deck"),
		t("tasks/c", "me", "Sept / Oct", "Chase the invoice"),
		page({ slug: "sources/laura-1x1.md", title: "Laura 1x1" }),
	]

	it("returns everything when no filter is set", () => {
		expect(filterRows(rows, {})).toHaveLength(4)
	})

	it("filters by source", () => {
		expect(
			filterRows(rows, { source: "Laura 1x1" }).map((p) => p.slug),
		).toEqual(["tasks/a", "tasks/b"])
	})

	it("does not match a note page that merely shares the source's title", () => {
		// The note itself has no derived_from edge, so it must not answer to a
		// filter on its own name.
		expect(
			filterRows(rows, { source: "Laura 1x1" }).some((p) =>
				p.slug.startsWith("sources/"),
			),
		).toBe(false)
	})

	it("composes source with owner", () => {
		expect(
			filterRows(rows, { source: "Laura 1x1", owner: "Taylor" }).map(
				(p) => p.slug,
			),
		).toEqual(["tasks/b"])
	})

	it("returns nothing when the combination holds nothing", () => {
		expect(filterRows(rows, { source: "Sept / Oct", owner: "Taylor" })).toEqual(
			[],
		)
	})

	it("matches free text against the source name as well as the title", () => {
		expect(filterRows(rows, { needle: "laura" }).map((p) => p.slug)).toEqual([
			"tasks/a",
			"tasks/b",
			"sources/laura-1x1.md",
		])
		expect(filterRows(rows, { needle: "invoice" }).map((p) => p.slug)).toEqual([
			"tasks/c",
		])
	})

	it("ignores whitespace-only free text", () => {
		expect(filterRows(rows, { needle: "   " })).toHaveLength(4)
	})
})
