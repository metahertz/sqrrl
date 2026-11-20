"use client"

// The wiki as a place to read: an index of every page grouped by where it
// came from, and the selected page as an article. [[links]], relationships
// and backlinks move within the reader (and the browser's back button
// works, as each page is its own URL hash). Editing and history open the
// page drawer; the API's standalone /wiki stays for links shared outside
// the console.

import { useEffect, useMemo, useRef, useState } from "react"
import { edgeLabel } from "./drawer-context.js"
import {
	IconEdit,
	IconExternal,
	IconGraph,
	IconHistory,
	IconSparkle,
} from "./icons.js"
import { Markdown } from "./markdown.js"
import { pageType, TYPE_META, type WikiPage } from "./shared.js"
import { type TaskStatus, taskStatusOf } from "./task-status.js"
import { isRemoved, meetingStart, recentlyUpdated } from "./views-data.js"
import { isOverdue } from "./wiki-data.js"
import { groupWiki, mostLinked, wikiGroupOf } from "./wiki-index.js"
import { wikiPageUrl } from "./wiki-links.js"

type Props = {
	pages: WikiPage[]
	slug?: string
	apiBase: string
	scope: string
	scopeRef: string
	busy: boolean
	onNavigate: (slug?: string) => void
	onOpenDrawer: (page: WikiPage, tab: "edit" | "history") => void
	onShowInGraph: (page: WikiPage) => void
	onSetStatus: (page: WikiPage, status: TaskStatus) => void
	/** Task slug → proposed status, for tasks with a pending suggestion. */
	suggested?: Map<string, "done" | "dropped">
	onOpenSuggestion?: (page: WikiPage) => void
}

function fmt(iso?: string, time = false): string {
	if (!iso) return ""
	const d = new Date(iso)
	return Number.isNaN(d.getTime())
		? iso
		: d.toLocaleString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
				...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
			})
}

function PageLink({
	page,
	onNavigate,
	meta,
}: {
	page: WikiPage
	onNavigate: (slug: string) => void
	meta?: string
}) {
	const t = TYPE_META[pageType(page)]
	return (
		<button
			type="button"
			className="mdb-wiki-item"
			onClick={() => onNavigate(page.slug)}
			title={page.slug}
		>
			<span className="mdb-dot" style={{ background: t.color }} />
			<span className="mdb-wiki-item-title">{page.title}</span>
			{meta ? <span className="mdb-wiki-item-meta">{meta}</span> : null}
		</button>
	)
}

function Index({
	pages,
	slug,
	onNavigate,
}: {
	pages: WikiPage[]
	slug?: string
	onNavigate: (s?: string) => void
}) {
	const [filter, setFilter] = useState("")
	const groups = useMemo(() => groupWiki(pages), [pages])
	const needle = filter.trim().toLowerCase()
	const current = slug ? wikiGroupOf(slug).id : undefined
	const active = useRef<HTMLButtonElement>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: keep the open page in view when it changes
	useEffect(() => {
		active.current?.scrollIntoView({ block: "nearest" })
	}, [slug])
	return (
		<nav className="mdb-wiki-index" aria-label="Wiki index">
			<div className="mdb-wiki-index-head">
				<button
					type="button"
					className="mdb-wiki-home"
					onClick={() => onNavigate(undefined)}
					aria-current={!slug ? "page" : undefined}
				>
					Wiki home
				</button>
				<input
					className="mdb-input"
					style={{ width: "100%" }}
					placeholder={`Filter ${pages.length} pages…`}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
				/>
			</div>
			{groups.map((g) => {
				const list = needle
					? g.pages.filter(
							(p) =>
								p.title.toLowerCase().includes(needle) ||
								p.slug.includes(needle),
						)
					: g.pages
				if (!list.length) return null
				return (
					<details
						key={g.id}
						className="mdb-wiki-group"
						open={Boolean(needle) || g.id === current}
					>
						<summary>
							{g.label}
							<span className="mdb-count">{list.length}</span>
						</summary>
						{list.map((p) => (
							<button
								key={p.slug}
								ref={p.slug === slug ? active : undefined}
								type="button"
								className="mdb-wiki-index-link"
								aria-current={p.slug === slug ? "page" : undefined}
								onClick={() => onNavigate(p.slug)}
								title={p.slug}
							>
								{p.title}
							</button>
						))}
					</details>
				)
			})}
		</nav>
	)
}

function Home({
	pages,
	onNavigate,
}: {
	pages: WikiPage[]
	onNavigate: (s: string) => void
}) {
	const hubs = useMemo(() => mostLinked(pages, 12), [pages])
	const recent = useMemo(() => recentlyUpdated(pages, 12), [pages])
	const groups = useMemo(() => groupWiki(pages), [pages])
	return (
		<article className="mdb-wiki-article">
			<div className="mdb-wiki-crumbs">Wiki</div>
			<h1 className="mdb-wiki-title">Your wiki</h1>
			<p className="mdb-wiki-lead">
				{pages.length} pages distilled from your notes, files, meetings, chats
				and mail, linked by the people and topics they share. Pick a hub to
				start from, or browse by source on the left.
			</p>
			<div className="mdb-chips" style={{ marginBottom: 24 }}>
				{groups.map((g) => (
					<button
						key={g.id}
						type="button"
						className="mdb-chip"
						onClick={() => g.pages[0] && onNavigate(g.pages[0].slug)}
					>
						{g.label}
						<span className="mdb-muted">{g.pages.length}</span>
					</button>
				))}
			</div>
			<div className="mdb-grid mdb-two">
				<section>
					<h2 className="mdb-wiki-h2">Start from a hub</h2>
					{hubs.map((p) => (
						<PageLink
							key={p.slug}
							page={p}
							onNavigate={onNavigate}
							meta={`${(p.backlinks ?? []).length} links`}
						/>
					))}
				</section>
				<section>
					<h2 className="mdb-wiki-h2">Recently updated</h2>
					{recent.map((p) => (
						<PageLink
							key={p.slug}
							page={p}
							onNavigate={onNavigate}
							meta={fmt(p.updatedAt)}
						/>
					))}
				</section>
			</div>
		</article>
	)
}

function Article(props: Props & { page: WikiPage }) {
	const { page, pages, onNavigate } = props
	const type = pageType(page)
	const meta = TYPE_META[type]
	const bySlug = useMemo(() => new Map(pages.map((p) => [p.slug, p])), [pages])
	const rels = page.relationships ?? []
	const groups = new Map<string, typeof rels>()
	for (const r of rels) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r])
	const card = page.taskCard
	const status = card ? taskStatusOf(page) : undefined
	const m = page.frontmatter?.meeting as
		| { start?: string; end?: string; location?: string }
		| undefined
	const go = (slug: string) => onNavigate(slug)

	return (
		<article className="mdb-wiki-article">
			<div className="mdb-wiki-crumbs">
				<button
					type="button"
					className="mdb-link"
					onClick={() => onNavigate(undefined)}
				>
					Wiki
				</button>
				<span>›</span>
				<span>{wikiGroupOf(page.slug).label}</span>
			</div>
			<h1 className="mdb-wiki-title">{page.title}</h1>
			<div className="mdb-wiki-meta">
				<span
					className="mdb-badge"
					style={{
						color: meta.color,
						borderColor: "transparent",
						background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
					}}
				>
					<span className="mdb-dot" style={{ background: meta.color }} />
					{meta.label}
				</span>
				{isRemoved(page) ? (
					<span className="mdb-badge mdb-badge-warn">removed / deprecated</span>
				) : null}
				{page.updatedAt ? <span>Updated {fmt(page.updatedAt)}</span> : null}
				{typeof page.revision === "number" ? (
					<span>Revision {page.revision}</span>
				) : null}
				{page.aliases?.length ? (
					<span>Also: {page.aliases.join(", ")}</span>
				) : null}
				<span className="mdb-spacer" />
				<button
					type="button"
					className="mdb-btn mdb-btn-sm"
					onClick={() => props.onOpenDrawer(page, "edit")}
				>
					<IconEdit size={13} /> Edit
				</button>
				<button
					type="button"
					className="mdb-btn mdb-btn-sm"
					onClick={() => props.onOpenDrawer(page, "history")}
				>
					<IconHistory size={13} /> History
				</button>
				<button
					type="button"
					className="mdb-btn mdb-btn-sm"
					onClick={() => props.onShowInGraph(page)}
				>
					<IconGraph size={13} /> Graph
				</button>
				<a
					className="mdb-btn mdb-btn-sm mdb-btn-ghost"
					href={wikiPageUrl(
						props.apiBase,
						page.slug,
						props.scope,
						props.scopeRef,
					)}
					target="_blank"
					rel="noopener noreferrer"
					title="Standalone page, for sharing a link"
				>
					<IconExternal size={13} />
				</a>
			</div>

			{card ? (
				<div className="mdb-wiki-card">
					<strong>Task</strong>
					<span>
						owned by <b>{card.owner ?? "unassigned"}</b>
					</span>
					<span
						className={`mdb-badge ${status === "done" ? "mdb-badge-ok" : status === "blocked" ? "mdb-badge-warn" : ""}`}
					>
						{status}
					</span>
					{card.dueDate ? (
						<span
							className={`mdb-badge ${isOverdue(page) ? "mdb-badge-danger" : "mdb-badge-accent"}`}
						>
							due {card.dueDate}
						</span>
					) : null}
					<span className="mdb-spacer" />
					<button
						type="button"
						className="mdb-btn mdb-btn-sm"
						disabled={props.busy}
						onClick={() =>
							props.onSetStatus(page, status === "done" ? "open" : "done")
						}
					>
						{status === "done" ? "Reopen" : "Mark done"}
					</button>
				</div>
			) : null}
			{card && props.suggested?.has(page.slug) && props.onOpenSuggestion ? (
				<button
					type="button"
					className="mdb-wiki-card mdb-wiki-suggested"
					onClick={() => props.onOpenSuggestion?.(page)}
				>
					<IconSparkle size={14} />
					<strong>
						{props.suggested.get(page.slug) === "done"
							? "Evidence suggests this is done"
							: "Evidence suggests this is no longer needed"}
					</strong>
					<span className="mdb-muted">Review the evidence →</span>
				</button>
			) : null}
			{m?.start ? (
				<div className="mdb-wiki-card">
					<strong>Meeting</strong>
					<span>{fmt(meetingStart(page), true)}</span>
					{m.location ? <span className="mdb-muted">{m.location}</span> : null}
				</div>
			) : null}

			{page.summary ? (
				<div className="mdb-wiki-lead">
					<Markdown text={page.summary} onWikiLink={go} />
				</div>
			) : null}
			{page.body?.trim() ? <Markdown text={page.body} onWikiLink={go} /> : null}

			{page.claims?.length ? (
				<section>
					<h2 className="mdb-wiki-h2">Claims</h2>
					<ul className="mdb-wiki-claims">
						{page.claims.map((c) => (
							<li key={c.text}>{c.text}</li>
						))}
					</ul>
				</section>
			) : null}

			{rels.length || page.backlinks?.length ? (
				<section>
					<h2 className="mdb-wiki-h2">Connections</h2>
					{[...groups.entries()].map(([kind, list]) => (
						<div key={kind} className="mdb-wiki-rel">
							<span className="mdb-wiki-rel-kind">{edgeLabel(kind)}</span>
							<div className="mdb-chips">
								{list.map((r) => {
									const target = bySlug.get(r.targetPageSlug)
									return (
										<button
											key={r.targetPageSlug}
											type="button"
											className="mdb-chip"
											onClick={() => go(r.targetPageSlug)}
											disabled={!target}
											title={target ? r.targetPageSlug : "Not in this scope"}
										>
											<span
												className="mdb-dot"
												style={{
													background: target
														? TYPE_META[pageType(target)].color
														: "#94a3b8",
												}}
											/>
											{r.targetTitle ?? target?.title ?? r.targetPageSlug}
										</button>
									)
								})}
							</div>
						</div>
					))}
					{page.backlinks?.length ? (
						<div className="mdb-wiki-rel">
							<span className="mdb-wiki-rel-kind">linked from</span>
							<div className="mdb-chips">
								{page.backlinks.map((b) => {
									const source = bySlug.get(b.sourcePageSlug)
									return (
										<button
											key={b.sourcePageSlug}
											type="button"
											className="mdb-chip"
											onClick={() => go(b.sourcePageSlug)}
											disabled={!source}
										>
											<span
												className="mdb-dot"
												style={{
													background: source
														? TYPE_META[pageType(source)].color
														: "#94a3b8",
												}}
											/>
											{b.sourceTitle ?? source?.title ?? b.sourcePageSlug}
										</button>
									)
								})}
							</div>
						</div>
					) : null}
				</section>
			) : null}
			<footer className="mdb-wiki-foot">
				<span className="mdb-slug">{page.slug}</span>
				<span>
					{props.scope}:{props.scopeRef}
				</span>
			</footer>
		</article>
	)
}

export function WikiView(props: Props) {
	const page = props.slug
		? props.pages.find((p) => p.slug === props.slug)
		: undefined
	const reader = useRef<HTMLDivElement>(null)
	// A new page starts at its top, as a link click in any reader does.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on page change only
	useEffect(() => {
		reader.current?.scrollTo({ top: 0 })
	}, [props.slug])
	return (
		<div className="mdb-wiki">
			<Index
				pages={props.pages}
				slug={props.slug}
				onNavigate={props.onNavigate}
			/>
			<div className="mdb-wiki-reader" ref={reader}>
				{!props.slug ? (
					<Home pages={props.pages} onNavigate={(s) => props.onNavigate(s)} />
				) : page ? (
					<Article {...props} page={page} />
				) : (
					<article className="mdb-wiki-article">
						<h1 className="mdb-wiki-title">Page not found</h1>
						<p className="mdb-muted">
							No page <span className="mdb-slug">{props.slug}</span> in{" "}
							{props.scope}:{props.scopeRef}. It may have been merged, purged,
							or be in another scope.
						</p>
						<button
							type="button"
							className="mdb-btn"
							onClick={() => props.onNavigate(undefined)}
						>
							Back to the wiki
						</button>
					</article>
				)}
			</div>
		</div>
	)
}
