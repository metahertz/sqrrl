import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { WikiPage } from "./shared.js"
import {
	completedCaption,
	DoneToggle,
	isTask,
	OFFERED_STATUSES,
	StatusPicker,
	taskStatusOf,
} from "./task-status.js"

function task(status?: string, extra: Partial<WikiPage> = {}): WikiPage {
	return {
		slug: "tasks/fix-mic",
		title: "Fix the mic",
		kind: "procedure",
		taskCard: { owner: "lauren", ...(status ? { status } : {}) },
		...extra,
	}
}

const topic: WikiPage = {
	slug: "topics/audio",
	title: "audio",
	kind: "concept",
}

describe("task predicates", () => {
	it("treats anything with a task card as a task", () => {
		expect(isTask(task("open"))).toBe(true)
		expect(isTask(topic)).toBe(false)
	})

	it("defaults a card with no status to open", () => {
		expect(taskStatusOf(task())).toBe("open")
	})

	it("does not offer dropped, which is ingestion's own marker", () => {
		expect(OFFERED_STATUSES).not.toContain("dropped")
		expect(OFFERED_STATUSES).toContain("done")
	})
})

describe("DoneToggle", () => {
	it("offers to mark an open task done", () => {
		const html = renderToStaticMarkup(
			createElement(DoneToggle, {
				page: task("open"),
				busy: false,
				onSetStatus: () => {},
			}),
		)
		expect(html).toContain("Mark done")
		expect(html).toContain('aria-label="Mark Fix the mic done"')
	})

	it("offers to reopen one already done", () => {
		const html = renderToStaticMarkup(
			createElement(DoneToggle, {
				page: task("done"),
				busy: false,
				onSetStatus: () => {},
			}),
		)
		expect(html).toContain("reopen")
		expect(html).toContain('aria-label="Reopen Fix the mic"')
	})

	it("names the owner in the title so a dense row stays unambiguous", () => {
		const html = renderToStaticMarkup(
			createElement(DoneToggle, {
				page: task("open"),
				busy: false,
				onSetStatus: () => {},
				compact: true,
			}),
		)
		expect(html).toContain("(lauren)")
	})

	it("disables itself while a write is in flight", () => {
		const html = renderToStaticMarkup(
			createElement(DoneToggle, {
				page: task("open"),
				busy: true,
				onSetStatus: () => {},
			}),
		)
		expect(html).toContain("disabled")
	})
})

describe("StatusPicker", () => {
	it("renders every offered status", () => {
		const html = renderToStaticMarkup(
			createElement(StatusPicker, {
				page: task("open"),
				busy: false,
				onSetStatus: () => {},
			}),
		)
		for (const s of OFFERED_STATUSES) expect(html).toContain(`>${s}</button>`)
	})

	it("disables the status the task already holds", () => {
		const html = renderToStaticMarkup(
			createElement(StatusPicker, {
				page: task("done"),
				busy: false,
				onSetStatus: () => {},
			}),
		)
		const doneButton = html.slice(html.indexOf(">done</button>") - 300)
		expect(doneButton).toContain("disabled")
	})
})

describe("completedCaption", () => {
	it("shows the completion day", () => {
		expect(
			completedCaption({
				owner: "l",
				status: "done",
				completedAt: "2026-09-15T12:00:00.000Z",
			}),
		).toBe("done 2026-09-15")
	})

	it("says done without a date when none was recorded", () => {
		expect(completedCaption({ owner: "l", status: "done" })).toBe("done")
	})

	it("is empty for a task that is not done", () => {
		expect(completedCaption({ owner: "l", status: "open" })).toBe("")
		expect(completedCaption(null)).toBe("")
	})
})
