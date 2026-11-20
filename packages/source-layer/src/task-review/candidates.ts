// Which tasks a new page might close, and what evidence a task has.
//
// Two directions, no LLM in either:
//   - tasksForSourcePage: a page was just distilled; which open tasks could
//     it be evidence for? Tasks from the same source, then the closest
//     tasks by search, preferring those owned by people the page is about.
//   - gatherEvidence: for one task, what happened since it was created?
//     Raw items (verbatim text) and wiki pages that are newer than the task.
// One rule binds both: evidence must post-date the task. A page that was
// just distilled never counts as evidence for the tasks extracted from it in
// the same run.

import {
	getWikiPage,
	searchWikiPages,
	type WikiDbHandle,
	type WikiPageView,
} from "@sqrrl/wiki-engine"
import { searchRawItems } from "../raw-items.js"
import type { JudgeEvidence } from "./judge.js"

export const OPEN_STATUSES = ["open", "in-progress", "blocked"]
/** A source page counts as evidence for a task only if it changed at least
 *  this long after the task was created. */
const SAME_RUN_MS = 10 * 60_000
const MAX_CANDIDATES = 5
const MAX_EVIDENCE = 6
const EVIDENCE_CHARS = 1500

type Scope = { scope: string; scopeRef: string }
type Rerank = Parameters<typeof searchRawItems>[1]["rerank"]

function time(v: unknown): number {
	const t = v ? Date.parse(String(v)) : Number.NaN
	return Number.isNaN(t) ? 0 : t
}

export function isOpenTask(
	p: Pick<WikiPageView, "kind" | "taskCard"> | undefined,
): boolean {
	const card = p?.taskCard as { status?: string } | null | undefined
	return Boolean(
		p &&
			p.kind === "procedure" &&
			card &&
			OPEN_STATUSES.includes(card.status ?? "open"),
	)
}

export async function tasksForSourcePage(
	handle: WikiDbHandle,
	p: Scope & { slug: string },
): Promise<string[]> {
	const page = await getWikiPage(handle, p.slug, p.scope, p.scopeRef)
	if (!page || page.kind === "procedure") return []
	const changedAt = time(page.updatedAt)
	const ok = async (slug: string) => {
		const t = await getWikiPage(handle, slug, p.scope, p.scopeRef)
		return t && isOpenTask(t) && time(t.createdAt) < changedAt - SAME_RUN_MS
			? t
			: undefined
	}

	const out: string[] = []
	// Tasks extracted from this very source, before this change: an email
	// thread that later says "sent", a note with the item ticked off.
	for (const b of (page.backlinks ?? []) as Array<{ sourcePageSlug: string }>)
		if (b.sourcePageSlug.startsWith("tasks/") && (await ok(b.sourcePageSlug)))
			out.push(b.sourcePageSlug)

	const people = new Set(
		(
			(page.relationships ?? []) as Array<{
				kind: string
				targetPageSlug: string
			}>
		)
			.filter((r) =>
				["participant", "attended_by", "organized_by", "owned_by"].includes(
					r.kind,
				),
			)
			.map((r) => r.targetPageSlug),
	)
	const query = [page.title, page.summary]
		.filter(Boolean)
		.join("\n")
		.slice(0, 600)
	const found = query
		? (
				await searchWikiPages(handle, {
					query,
					scope: p.scope,
					scopeRef: p.scopeRef,
					kind: "procedure",
					maxResults: 12,
				})
			).results
		: []
	// Owned by someone this page is about first, then the rest by rank.
	const ownedByPeople = (r: (typeof found)[number]) =>
		(
			(r.page.relationships ?? []) as Array<{
				kind: string
				targetPageSlug: string
			}>
		).some((e) => e.kind === "owned_by" && people.has(e.targetPageSlug))
	const ranked = [
		...found.filter(ownedByPeople),
		...found.filter((r) => !ownedByPeople(r)),
	]
	for (const r of ranked) {
		if (out.length >= MAX_CANDIDATES) break
		if (!out.includes(r.page.slug) && (await ok(r.page.slug)))
			out.push(r.page.slug)
	}
	return out.slice(0, MAX_CANDIDATES)
}

function clip(s: string, n = EVIDENCE_CHARS): string {
	const t = s.trim()
	return t.length > n ? `${t.slice(0, n)} …` : t
}

/** A page as evidence: meetings say when they were and whether they were
 *  removed, since that is what the judge needs to call them. */
function pageEvidence(page: WikiPageView): JudgeEvidence {
	const fm = (page.frontmatter ?? {}) as {
		type?: string
		status?: string
		meeting?: { start?: string }
	}
	const removed = fm.status === "deprecated"
	const meeting = fm.type === "meeting" && fm.meeting?.start
	const lead = meeting
		? `Meeting scheduled for ${fm.meeting?.start?.slice(0, 16).replace("T", " ")}${removed ? " — REMOVED from the calendar (cancelled)" : ""}.`
		: removed
			? "(This page is marked deprecated.)"
			: ""
	return {
		key: `page:${page.slug}`,
		kind: "page",
		slug: page.slug,
		title: page.title,
		text: clip([lead, page.summary, page.body].filter(Boolean).join("\n\n")),
		occurredAt: meeting ? fm.meeting?.start : String(page.updatedAt ?? ""),
		source: meeting ? "meeting" : "wiki page",
	}
}

export async function gatherEvidence(
	handle: WikiDbHandle,
	task: WikiPageView,
	p: Scope & {
		hints?: string[]
		dismissed?: string[]
		notBefore?: Date
		rerank?: Rerank
	},
): Promise<JudgeEvidence[]> {
	const since = time(task.createdAt)
	// Newer than the task, and newer than the user's last dismissal for it.
	const after = Math.max(since + SAME_RUN_MS, p.notBefore?.getTime() ?? 0)
	const dismissed = new Set(p.dismissed ?? [])
	const out: JudgeEvidence[] = []
	const add = (e: JudgeEvidence) => {
		if (
			out.length >= MAX_EVIDENCE ||
			dismissed.has(e.key) ||
			out.some((x) => x.key === e.key)
		)
			return
		if (!e.text.trim()) return
		out.push(e)
	}
	const query = task.title

	// Verbatim source text first: the best quotes come from what was said.
	const raw = await searchRawItems(handle, {
		query,
		scope: p.scope,
		scopeRef: p.scopeRef,
		from: new Date(after),
		limit: 8,
		...(p.rerank ? { rerank: p.rerank } : {}),
	})
	for (const r of raw)
		add({
			key: `raw:${r.item.id}`,
			kind: "raw",
			rawItemId: r.item.id,
			title: r.item.title ?? r.item.source,
			text: clip(r.item.text),
			...(r.item.occurredAt
				? { occurredAt: new Date(r.item.occurredAt).toISOString() }
				: {}),
			source: r.item.source,
			...(r.item.author ? { author: r.item.author } : {}),
		})

	const usable = (page: WikiPageView | undefined) =>
		page &&
		page.slug !== task.slug &&
		page.kind !== "procedure" &&
		time(page.updatedAt) > after
	for (const slug of p.hints ?? []) {
		const page = await getWikiPage(handle, slug, p.scope, p.scopeRef)
		if (page && usable(page)) add(pageEvidence(page))
	}
	const pages = (
		await searchWikiPages(handle, {
			query,
			scope: p.scope,
			scopeRef: p.scopeRef,
			maxResults: 8,
		})
	).results
	for (const r of pages) if (usable(r.page)) add(pageEvidence(r.page))
	return out
}
