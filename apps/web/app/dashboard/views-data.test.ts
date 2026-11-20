import { describe, expect, it } from "vitest"
import type { WikiPage } from "./shared.js"
import {
	dueSoon,
	filterTasks,
	matches,
	overdue,
	upcomingMeetings,
} from "./views-data.js"

const task = (slug: string, card: Record<string, string>): WikiPage => ({
	slug: `tasks/${slug}`,
	title: slug,
	kind: "procedure",
	taskCard: card,
})
const meeting = (slug: string, start: string, status?: string): WikiPage => ({
	slug: `meetings/${slug}`,
	title: slug,
	kind: "source",
	frontmatter: {
		type: "meeting",
		meeting: { start },
		...(status ? { status } : {}),
	},
})

const TODAY = "2026-11-17"
const TASKS = [
	task("late", { owner: "me", status: "open", dueDate: "2026-11-01" }),
	task("soon", { owner: "Kai", status: "open", dueDate: "2026-11-20" }),
	task("later", { owner: "Kai", status: "open", dueDate: "2026-12-30" }),
	task("undated", { owner: "me", status: "in-progress" }),
	task("done", { owner: "me", status: "done", dueDate: "2026-11-02" }),
]

describe("task selections", () => {
	it("splits open, overdue, soon, undated and done", () => {
		const names = (f: Parameters<typeof filterTasks>[1]) =>
			filterTasks(TASKS, f, TODAY).map((p) => p.title)
		expect(names("open")).toEqual(["late", "soon", "later", "undated"])
		expect(names("overdue")).toEqual(["late"])
		expect(names("soon")).toEqual(["soon"])
		expect(names("undated")).toEqual(["undated"])
		expect(names("done")).toEqual(["done"])
		expect(overdue(TASKS, TODAY).map((p) => p.title)).toEqual(["late"])
		expect(dueSoon(TASKS, 7, TODAY).map((p) => p.title)).toEqual(["soon"])
	})

	it("suggested: open tasks with a pending suggestion only", () => {
		const pending = new Set(["tasks/late", "tasks/done"])
		const names = filterTasks(TASKS, "suggested", TODAY, pending).map(
			(p) => p.title,
		)
		expect(names).toEqual(["late"])
		expect(filterTasks(TASKS, "suggested", TODAY)).toEqual([])
	})
})

describe("upcomingMeetings", () => {
	it("lists the next week's meetings in order, skipping removed ones", () => {
		const now = new Date("2026-11-17T09:00:00Z")
		const out = upcomingMeetings(
			[
				meeting("b", "2026-11-19T10:00:00Z"),
				meeting("past", "2026-11-16T10:00:00Z"),
				meeting("a", "2026-11-18T10:00:00Z"),
				meeting("gone", "2026-11-18T12:00:00Z", "deprecated"),
				meeting("far", "2026-12-30T10:00:00Z"),
			],
			now,
		)
		expect(out.map((p) => p.title)).toEqual(["a", "b"])
	})
})

describe("matches", () => {
	it("finds by title, owner and alias", () => {
		const p = { ...TASKS[1], aliases: ["k-task"] }
		expect(matches(p, "SOON")).toBe(true)
		expect(matches(p, "kai")).toBe(true)
		expect(matches(p, "k-task")).toBe(true)
		expect(matches(p, "nope")).toBe(false)
	})
})

import { noteSummary } from "./create-dialog.js"
import { errorText } from "./drawer-context.js"

describe("create and error helpers", () => {
	it("summarises a note by its first line of text, else its title", () => {
		expect(noteSummary("## Plan\n\nship it", "T")).toBe("Plan")
		expect(noteSummary("  \n", "Title")).toBe("Title")
	})

	it("shows an API error's message, not its JSON", () => {
		expect(
			errorText(
				new Error(
					'Sqrrl API 400: {"error":{"code":"VALIDATION_ERROR","message":"summary is required"}}',
				),
			),
		).toBe("summary is required")
		expect(errorText(new Error("network down"))).toBe("network down")
	})
})
