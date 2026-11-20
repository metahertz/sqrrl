// Pure selections behind the Overview and list views.

import { pageType, type PageType, type WikiPage } from "./shared.js"
import { isOpen, isOverdue, TODAY } from "./wiki-data.js"

/** A meeting page's start, from the calendar distiller's frontmatter. */
export function meetingStart(p: WikiPage): string | undefined {
	const m = p.frontmatter?.meeting as { start?: unknown } | undefined
	return typeof m?.start === "string" ? m.start : undefined
}

export function isRemoved(p: WikiPage): boolean {
	return (
		(p.frontmatter as { status?: unknown } | undefined)?.status === "deprecated"
	)
}

export function ofType(pages: WikiPage[], type: PageType): WikiPage[] {
	return pages.filter((p) => pageType(p) === type)
}

export function upcomingMeetings(
	pages: WikiPage[],
	now = new Date(),
	days = 7,
): WikiPage[] {
	const from = now.toISOString()
	const to = new Date(now.getTime() + days * 86400_000).toISOString()
	return ofType(pages, "meeting")
		.filter((p) => {
			const s = meetingStart(p)
			return s !== undefined && s >= from && s < to && !isRemoved(p)
		})
		.sort((a, b) =>
			String(meetingStart(a)).localeCompare(String(meetingStart(b))),
		)
}

export function dueSoon(
	pages: WikiPage[],
	days = 7,
	today = TODAY(),
): WikiPage[] {
	const limit = new Date(Date.parse(today) + days * 86400_000)
		.toISOString()
		.slice(0, 10)
	return ofType(pages, "task")
		.filter(
			(p) =>
				isOpen(p) &&
				p.taskCard?.dueDate &&
				p.taskCard.dueDate >= today &&
				p.taskCard.dueDate <= limit,
		)
		.sort((a, b) =>
			String(a.taskCard?.dueDate).localeCompare(String(b.taskCard?.dueDate)),
		)
}

export function overdue(pages: WikiPage[], today = TODAY()): WikiPage[] {
	return ofType(pages, "task")
		.filter((p) => isOverdue(p, today))
		.sort((a, b) =>
			String(a.taskCard?.dueDate).localeCompare(String(b.taskCard?.dueDate)),
		)
}

export function recentlyUpdated(pages: WikiPage[], n = 8): WikiPage[] {
	return [...pages]
		.filter((p) => p.updatedAt)
		.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
		.slice(0, n)
}

export type TaskFilter =
	| "open"
	| "overdue"
	| "soon"
	| "undated"
	| "done"
	| "suggested"
	| "all"

export function filterTasks(
	tasks: WikiPage[],
	f: TaskFilter,
	today = TODAY(),
	/** Tasks with a pending suggestion to close them. */
	suggested?: { has(slug: string): boolean },
): WikiPage[] {
	switch (f) {
		case "suggested":
			return tasks.filter((p) => isOpen(p) && Boolean(suggested?.has(p.slug)))
		case "open":
			return tasks.filter(isOpen)
		case "overdue":
			return tasks.filter((p) => isOverdue(p, today))
		case "soon":
			return dueSoon(tasks, 7, today)
		case "undated":
			return tasks.filter((p) => isOpen(p) && !p.taskCard?.dueDate)
		case "done":
			return tasks.filter((p) => p.taskCard?.status === "done")
		default:
			return tasks
	}
}

/** Free-text match over title, slug, aliases, owner and summary. */
export function matches(p: WikiPage, needle: string): boolean {
	const q = needle.trim().toLowerCase()
	if (!q) return true
	return [
		p.title,
		p.slug,
		p.summary ?? "",
		p.taskCard?.owner ?? "",
		...(p.aliases ?? []),
	].some((s) => s.toLowerCase().includes(q))
}
