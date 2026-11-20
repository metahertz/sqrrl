import type { SqrrlClient } from "@sqrrl/client"
import type { WikiPage } from "./shared.js"

/** The engine clamps a listing to 100 rows, so anything that needs the whole
 *  scope has to page. The old dashboard called wikiLint once and drew whatever
 *  came back, which silently became "the most recently updated 100 pages" as
 *  soon as the scope outgrew that — a graph missing two thirds of its nodes
 *  and summary counts that were simply wrong. */
const PAGE_SIZE = 100
/** Refuses to spin forever if `total` and the returned rows ever disagree. */
const MAX_REQUESTS = 60

export async function fetchAllPages(
	client: SqrrlClient,
	scope: string,
	scopeRef: string,
): Promise<{ pages: WikiPage[]; total: number; truncated: boolean }> {
	const first = await client.wikiList({ scope, scopeRef, limit: PAGE_SIZE })
	const pages = [...(first.pages as WikiPage[])]
	const total = first.total ?? pages.length
	let requests = 1
	while (pages.length < total && requests < MAX_REQUESTS) {
		const next = await client.wikiList({
			scope,
			scopeRef,
			limit: PAGE_SIZE,
			skip: pages.length,
		})
		const batch = next.pages as WikiPage[]
		// A short page means the server has nothing further to give, whatever
		// `total` claims; continuing would loop on the same skip forever.
		if (batch.length === 0) break
		pages.push(...batch)
		requests++
	}
	return { pages, total, truncated: pages.length < total }
}

export const TODAY = () => new Date().toISOString().slice(0, 10)

export function isOpen(p: WikiPage): boolean {
	const s = p.taskCard?.status ?? "open"
	return s !== "done" && s !== "dropped"
}

export function isOverdue(p: WikiPage, today = TODAY()): boolean {
	return Boolean(p.taskCard?.dueDate && p.taskCard.dueDate < today && isOpen(p))
}

/** Groups tasks by owner. Owner is free text on the card, so it is normalised
 *  for grouping only — the original casing is kept for display. */
export function tasksByOwner(pages: WikiPage[]): Map<string, WikiPage[]> {
	const out = new Map<string, WikiPage[]>()
	for (const p of pages) {
		if (p.kind !== "procedure") continue
		const owner = p.taskCard?.owner?.trim() || "unassigned"
		const key = owner.toLowerCase()
		const bucket = out.get(key)
		if (bucket) bucket.push(p)
		else out.set(key, [p])
	}
	return out
}

/** Pages a hub actually joins. A hub with one backlink connects nothing; it is
 *  noise until something else references it. */
export function backlinkCount(p: WikiPage): number {
	return (p.backlinks ?? []).length
}

export type Bucket = {
	id: string
	label: string
	pages: WikiPage[]
	note?: string
	tone?: "warning" | "error"
}

/** The drill-down buckets behind the summary cards. Each one is a saved
 *  question ("what is overdue", "who owns nothing") rather than a raw kind
 *  filter, because that is what the numbers on the cards actually mean. */
export function buildBuckets(pages: WikiPage[]): Bucket[] {
	const today = TODAY()
	const tasks = pages.filter((p) => p.kind === "procedure")
	const open = tasks.filter(isOpen)
	const overdue = open.filter((p) => isOverdue(p, today))
	const dated = open.filter((p) => p.taskCard?.dueDate)
	const soon = dated.filter((p) => {
		const due = p.taskCard?.dueDate
		if (!due || due < today) return false
		const days = (Date.parse(due) - Date.parse(today)) / 86_400_000
		return days <= 7
	})
	const hubs = pages.filter((p) => p.kind === "concept")
	// Calendar meetings are source pages too, but a separate question:
	// newest first, which their date-led slugs give by reverse sort.
	const isMeeting = (p: WikiPage) => p.slug.startsWith("meetings/")
	return [
		{
			id: "notes",
			label: "notes",
			pages: pages.filter((p) => p.kind === "source" && !isMeeting(p)),
		},
		{
			id: "meetings",
			label: "meetings",
			pages: pages
				.filter(isMeeting)
				.sort((a, b) => b.slug.localeCompare(a.slug)),
		},
		{
			id: "open",
			label: "tasks open",
			pages: open,
			...(overdue.length
				? { note: `${overdue.length} overdue`, tone: "warning" as const }
				: {}),
		},
		{ id: "overdue", label: "overdue", pages: overdue, tone: "error" as const },
		{ id: "soon", label: "due in 7 days", pages: soon },
		{
			id: "unscheduled",
			label: "open, no date",
			pages: open.filter((p) => !p.taskCard?.dueDate),
		},
		{
			id: "done",
			label: "tasks done",
			pages: tasks.filter((p) => p.taskCard?.status === "done"),
		},
		{
			id: "people",
			label: "people",
			pages: pages.filter((p) => p.kind === "entity"),
		},
		{
			id: "topics",
			label: "topics",
			pages: hubs,
			...(hubs.filter((h) => backlinkCount(h) <= 1).length
				? {
						note: `${hubs.filter((h) => backlinkCount(h) <= 1).length} joining nothing`,
						tone: "warning" as const,
					}
				: {}),
		},
		{
			id: "orphans",
			label: "unlinked pages",
			pages: pages.filter(
				(p) => (p.relationships ?? []).length === 0 && backlinkCount(p) === 0,
			),
			tone: "warning" as const,
		},
	]
}

/** The kind of the edge a task carries back to the note it came from. Set by
 *  every writer on the promotion path (ingest.py and the connectors), so it is
 *  the one relationship a task page is guaranteed to have. */
const SOURCE_EDGE = "derived_from"

/** Name of the note a task was extracted from, for the task lists.
 *
 *  Prefers the edge's `targetTitle` — the readable note name ("Laura 1x1") —
 *  because the slug it points at is a file path. Falls back to the slug's last
 *  segment, and then to `taskCard.sourceRef`, which carries the same path when
 *  a page predates the relationship being written. Returns null when nothing
 *  names a source, so the caller can leave the row unprefixed rather than
 *  print a placeholder on every non-task. */
export function sourceEdgeLabel(p: WikiPage): string | null {
	const edge = (p.relationships ?? []).find((r) => r.kind === SOURCE_EDGE)
	const title = edge?.targetTitle?.trim()
	if (title) return title
	const ref = edge?.targetPageSlug ?? p.taskCard?.sourceRef
	if (!ref) return null
	// Paths only: "sources/apple-notes/95b8b0bc.md" reads as "95b8b0bc.md",
	// which at least identifies the note when no title was stored.
	const leaf = ref.split("/").filter(Boolean).pop()
	return leaf || null
}

export type RowFilters = {
	/** Exact owner as the dropdown offers it, "unassigned" included. */
	owner?: string
	/** Exact source name as sourceEdgeLabel returns it. */
	source?: string
	/** Free text, matched against title, slug and source name. */
	needle?: string
}

/** The list filters behind a bucket's drill-down, as one pure function so the
 *  three can be tested together — they compose, and the interesting cases are
 *  the combinations (an owner that holds nothing from the selected note has to
 *  come back empty, not fall back to either filter alone). */
export function filterRows(pages: WikiPage[], f: RowFilters): WikiPage[] {
	let list = pages
	if (f.owner) {
		list = list.filter(
			(p) => (p.taskCard?.owner?.trim() || "unassigned") === f.owner,
		)
	}
	if (f.source) {
		list = list.filter((p) => sourceEdgeLabel(p) === f.source)
	}
	const needle = f.needle?.trim().toLowerCase()
	if (needle) {
		// The source name is on the row, so it has to be searchable too: typing
		// a note's name and getting nothing back reads as a broken filter, not
		// as a filter that only covers the title.
		list = list.filter(
			(p) =>
				p.title.toLowerCase().includes(needle) ||
				p.slug.toLowerCase().includes(needle) ||
				(sourceEdgeLabel(p) ?? "").toLowerCase().includes(needle),
		)
	}
	return list
}
