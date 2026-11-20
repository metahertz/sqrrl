"use client"

import { useMemo, useState } from "react"
import { IconCheck, IconPlus, IconSparkle } from "./icons.js"
import { pageType, type PageType, TYPE_META, type WikiPage } from "./shared.js"
import { type TaskStatus, taskStatusOf } from "./task-status.js"
import {
	dueSoon,
	filterTasks,
	isRemoved,
	matches,
	meetingStart,
	ofType,
	overdue,
	recentlyUpdated,
	type TaskFilter,
	upcomingMeetings,
} from "./views-data.js"
import {
	backlinkCount,
	isOverdue,
	sourceEdgeLabel,
	tasksByOwner,
	TODAY,
} from "./wiki-data.js"

export type View =
	| "overview"
	| "ask"
	| "wiki"
	| "graph"
	| "task"
	| "meeting"
	| "person"
	| "topic"
	| "note"
	| "activity"
	| "settings"

function fmtDate(iso?: string, withTime = false): string {
	if (!iso) return ""
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return withTime
		? d.toLocaleString(undefined, {
				weekday: "short",
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			})
		: d.toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
			})
}

function relativeDue(due: string, today = TODAY()): string {
	const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400_000)
	if (days === 0) return "due today"
	if (days === 1) return "due tomorrow"
	if (days === -1) return "1 day late"
	if (days < 0) return `${-days} days late`
	if (days < 14) return `due in ${days} days`
	return `due ${fmtDate(due)}`
}

/** A check that marks a task done, or reopens it. */
function DoneCheck({
	page,
	busy,
	onSetStatus,
}: {
	page: WikiPage
	busy: boolean
	onSetStatus: (p: WikiPage, s: TaskStatus) => void
}) {
	const done = taskStatusOf(page) === "done"
	return (
		<button
			type="button"
			disabled={busy}
			aria-label={done ? `Reopen ${page.title}` : `Mark ${page.title} done`}
			title={done ? "Reopen" : "Mark done"}
			onClick={(e) => {
				e.stopPropagation()
				onSetStatus(page, done ? "open" : "done")
			}}
			style={{
				width: 18,
				height: 18,
				flex: "none",
				display: "grid",
				placeItems: "center",
				borderRadius: 5,
				border: `1.5px solid ${done ? "var(--ok)" : "var(--border-strong)"}`,
				background: done ? "var(--ok)" : "transparent",
				color: "#fff",
				cursor: "pointer",
				padding: 0,
			}}
		>
			{done ? <IconCheck size={12} /> : null}
		</button>
	)
}

export function PageRow({
	page,
	selected,
	onOpen,
	busy,
	onSetStatus,
	ownerLoad,
	suggested,
}: {
	page: WikiPage
	selected?: boolean
	/** A pending suggestion to close this task. */
	suggested?: "done" | "dropped"
	onOpen: (p: WikiPage) => void
	busy: boolean
	onSetStatus: (p: WikiPage, s: TaskStatus) => void
	ownerLoad?: { open: number; overdue: number }
}) {
	const type = pageType(page)
	const meta = TYPE_META[type]
	const card = page.taskCard
	const status = card ? taskStatusOf(page) : undefined
	const badges: React.ReactNode[] = []
	let sub = ""
	if (type === "task" && card) {
		sub = [card.owner ?? "unassigned", sourceEdgeLabel(page)]
			.filter(Boolean)
			.join(" · ")
		if (card.dueDate && status !== "done")
			badges.push(
				<span
					key="due"
					className={`mdb-badge ${isOverdue(page) ? "mdb-badge-danger" : "mdb-badge-accent"}`}
				>
					{relativeDue(card.dueDate)}
				</span>,
			)
		if (suggested && status !== "done" && status !== "dropped")
			badges.push(
				<span
					key="sg"
					className="mdb-badge mdb-badge-accent"
					title={
						suggested === "done"
							? "Evidence suggests this is done"
							: "Evidence suggests this is no longer needed"
					}
				>
					<IconSparkle size={11} />{" "}
					{suggested === "done" ? "looks done" : "not needed?"}
				</span>,
			)
		if (
			status === "in-progress" ||
			status === "blocked" ||
			status === "dropped"
		)
			badges.push(
				<span
					key="st"
					className={`mdb-badge ${status === "blocked" ? "mdb-badge-warn" : ""}`}
				>
					{status}
				</span>,
			)
	} else if (type === "meeting") {
		sub = fmtDate(meetingStart(page), true)
	} else if (type === "person") {
		sub = page.personCard?.emails?.[0] ?? ""
		if (ownerLoad?.open)
			badges.push(
				<span key="load" className="mdb-badge">
					{ownerLoad.open} open
				</span>,
			)
		if (ownerLoad?.overdue)
			badges.push(
				<span key="late" className="mdb-badge mdb-badge-danger">
					{ownerLoad.overdue} late
				</span>,
			)
	} else {
		sub = page.summary ?? ""
	}
	if (type !== "task" && type !== "note" && backlinkCount(page))
		badges.push(
			<span key="bl" className="mdb-badge" title="Pages linking here">
				{backlinkCount(page)} links
			</span>,
		)
	if (isRemoved(page))
		badges.push(
			<span key="rm" className="mdb-badge mdb-badge-warn">
				removed
			</span>,
		)

	return (
		<li className="mdb-row" data-selected={selected ? "true" : undefined}>
			{card ? (
				<DoneCheck page={page} busy={busy} onSetStatus={onSetStatus} />
			) : (
				<span className="mdb-dot" style={{ background: meta.color }} />
			)}
			<button
				type="button"
				className="mdb-row-btn"
				onClick={() => onOpen(page)}
			>
				<div className="mdb-row-main">
					<div
						className="mdb-row-title"
						style={
							status === "done"
								? { textDecoration: "line-through", color: "var(--muted)" }
								: undefined
						}
					>
						{page.title}
					</div>
					{sub ? <div className="mdb-row-meta">{sub}</div> : null}
				</div>
				<div style={{ display: "flex", gap: 6, flex: "none" }}>{badges}</div>
			</button>
		</li>
	)
}

type Common = {
	pages: WikiPage[]
	selectedSlug: string | null
	onOpen: (p: WikiPage) => void
	busy: boolean
	onSetStatus: (p: WikiPage, s: TaskStatus) => void
	/** Task slug → proposed status, for tasks with a pending suggestion. */
	suggested?: Map<string, "done" | "dropped">
}

function ListCard({
	title,
	sub,
	pages,
	empty,
	...common
}: Common & { title: string; sub?: string; empty: string }) {
	return (
		<div className="mdb-card">
			<div className="mdb-card-head">
				{title}
				{sub ? <span className="mdb-sub">{sub}</span> : null}
			</div>
			{pages.length ? (
				<ul className="mdb-rows">
					{pages.map((p) => (
						<PageRow
							key={p.slug}
							page={p}
							selected={common.selectedSlug === p.slug}
							{...common}
							suggested={common.suggested?.get(p.slug)}
						/>
					))}
				</ul>
			) : (
				<div className="mdb-empty" style={{ padding: 24 }}>
					{empty}
				</div>
			)}
		</div>
	)
}

export function OverviewView(
	props: Common & {
		onNavigate: (v: View, filter?: TaskFilter) => void
		onCreate: () => void
		/** The "Suggested to close" card, when there are suggestions. */
		suggestionsCard?: React.ReactNode
		identityCard?: React.ReactNode
		/** One line on whether background work is still coming. */
		activityCard?: React.ReactNode
	},
) {
	const { pages, onNavigate } = props
	const late = useMemo(() => overdue(pages), [pages])
	const soon = useMemo(() => dueSoon(pages), [pages])
	const meetings = useMemo(() => upcomingMeetings(pages), [pages])
	const recent = useMemo(() => recentlyUpdated(pages), [pages])
	const tasks = ofType(pages, "task")
	const open = tasks.filter(
		(t) => taskStatusOf(t) !== "done" && taskStatusOf(t) !== "dropped",
	)

	const stats: Array<{
		label: string
		value: number
		type: PageType
		view: View
		filter?: TaskFilter
		note?: string
		tone?: string
	}> = [
		{
			label: "Open tasks",
			value: open.length,
			type: "task",
			view: "task",
			filter: "open",
		},
		{
			label: "Overdue",
			value: late.length,
			type: "task",
			view: "task",
			filter: "overdue",
			tone: late.length ? "var(--danger)" : undefined,
		},
		{
			label: "Meetings",
			value: ofType(pages, "meeting").length,
			type: "meeting",
			view: "meeting",
			note: meetings.length ? `${meetings.length} this week` : undefined,
		},
		{
			label: "Notes",
			value: ofType(pages, "note").length,
			type: "note",
			view: "note",
		},
		{
			label: "People",
			value: ofType(pages, "person").length,
			type: "person",
			view: "person",
		},
		{
			label: "Topics",
			value: ofType(pages, "topic").length,
			type: "topic",
			view: "topic",
		},
	]

	return (
		<div className="mdb-page">
			<div className="mdb-page-head">
				<div>
					<h1>Overview</h1>
					<p>
						{pages.length} pages ·{" "}
						{new Date().toLocaleDateString(undefined, {
							weekday: "long",
							day: "numeric",
							month: "long",
						})}
					</p>
				</div>
				<span className="mdb-spacer" />
				<button
					type="button"
					className="mdb-btn mdb-btn-primary"
					onClick={props.onCreate}
				>
					<IconPlus size={15} /> New page
				</button>
			</div>
			<div className="mdb-grid mdb-stats">
				{stats.map((s) => (
					<button
						key={s.label}
						type="button"
						className="mdb-card mdb-stat"
						onClick={() => onNavigate(s.view, s.filter)}
					>
						<span className="mdb-stat-label">
							<span
								className="mdb-dot"
								style={{ background: TYPE_META[s.type].color }}
							/>
							{s.label}
						</span>
						<span
							className="mdb-stat-value"
							style={s.tone ? { color: s.tone } : undefined}
						>
							{s.value}
						</span>
						{s.note ? (
							<span className="mdb-stat-note mdb-muted">{s.note}</span>
						) : null}
					</button>
				))}
			</div>
			{props.activityCard}
			{props.suggestionsCard}
			{props.identityCard}
			<div className="mdb-grid mdb-two">
				<ListCard
					{...props}
					title="Overdue"
					sub={late.length ? `${late.length}` : undefined}
					pages={late.slice(0, 8)}
					empty="Nothing overdue."
				/>
				<ListCard
					{...props}
					title="Due in the next 7 days"
					pages={soon.slice(0, 8)}
					empty="Nothing due this week."
				/>
				<ListCard
					{...props}
					title="Upcoming meetings"
					pages={meetings.slice(0, 8)}
					empty="No meetings in the next week. Calendar sync runs on the Mac."
				/>
				<ListCard
					{...props}
					title="Recently updated"
					pages={recent}
					empty="Nothing yet."
				/>
			</div>
		</div>
	)
}

const TASK_FILTERS: Array<{ id: TaskFilter; label: string }> = [
	{ id: "open", label: "Open" },
	{ id: "overdue", label: "Overdue" },
	{ id: "soon", label: "Due this week" },
	{ id: "undated", label: "No date" },
	{ id: "done", label: "Done" },
	{ id: "suggested", label: "Suggested" },
	{ id: "all", label: "All" },
]

type Sort = "relevant" | "title" | "updated"

export function ListView(
	props: Common & {
		type: PageType
		taskFilter: TaskFilter
		onTaskFilter: (f: TaskFilter) => void
		onCreate: () => void
	},
) {
	const { pages, type, taskFilter, onTaskFilter } = props
	const [needle, setNeedle] = useState("")
	const [owner, setOwner] = useState("")
	const [when, setWhen] = useState<"upcoming" | "past" | "all">("upcoming")
	const [sort, setSort] = useState<Sort>("relevant")
	const [limit, setLimit] = useState(150)
	const meta = TYPE_META[type]

	const all = useMemo(() => ofType(pages, type), [pages, type])
	const owners = useMemo(
		() => (type === "task" ? [...tasksByOwner(all).keys()].sort() : []),
		[all, type],
	)
	const loads = useMemo(() => {
		if (type !== "person") return null
		const byOwner = tasksByOwner(pages)
		return (p: WikiPage) => {
			const held = (byOwner.get(p.title.trim().toLowerCase()) ?? []).filter(
				(t) => taskStatusOf(t) !== "done" && taskStatusOf(t) !== "dropped",
			)
			return {
				open: held.length,
				overdue: held.filter((t) => isOverdue(t)).length,
			}
		}
	}, [pages, type])

	const rows = useMemo(() => {
		let list = all
		if (type === "task") {
			list = filterTasks(list, taskFilter, undefined, props.suggested)
			if (owner)
				list = list.filter(
					(p) =>
						(p.taskCard?.owner?.trim() || "unassigned").toLowerCase() === owner,
				)
		}
		if (type === "meeting" && when !== "all") {
			const now = new Date().toISOString()
			list = list.filter((p) => {
				const s = meetingStart(p) ?? ""
				return when === "upcoming" ? s >= now : s < now
			})
		}
		list = list.filter((p) => matches(p, needle))
		const sorted = [...list]
		if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title))
		else if (sort === "updated")
			sorted.sort((a, b) =>
				String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
			)
		else if (type === "task")
			sorted.sort((a, b) =>
				String(a.taskCard?.dueDate ?? "9999").localeCompare(
					String(b.taskCard?.dueDate ?? "9999"),
				),
			)
		else if (type === "meeting")
			sorted.sort((a, b) => {
				const x = String(meetingStart(a) ?? "")
				const y = String(meetingStart(b) ?? "")
				return when === "upcoming" ? x.localeCompare(y) : y.localeCompare(x)
			})
		else if (type === "person" || type === "topic")
			sorted.sort((a, b) => backlinkCount(b) - backlinkCount(a))
		else
			sorted.sort((a, b) =>
				String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
			)
		return sorted
	}, [all, type, taskFilter, owner, when, needle, sort, props.suggested])

	return (
		<div className="mdb-page">
			<div className="mdb-page-head">
				<div>
					<h1>{meta.plural}</h1>
					<p>
						{rows.length === all.length
							? `${all.length}`
							: `${rows.length} of ${all.length}`}{" "}
						{meta.plural.toLowerCase()}
					</p>
				</div>
				<span className="mdb-spacer" />
				<button
					type="button"
					className="mdb-btn mdb-btn-primary"
					onClick={props.onCreate}
				>
					<IconPlus size={15} /> New {meta.label.toLowerCase()}
				</button>
			</div>
			<div className="mdb-toolbar">
				<input
					className="mdb-input"
					style={{ width: 260 }}
					placeholder={`Filter ${meta.plural.toLowerCase()}…`}
					value={needle}
					onChange={(e) => setNeedle(e.target.value)}
				/>
				{type === "task" ? (
					<>
						<div className="mdb-chips">
							{TASK_FILTERS.map((f) => (
								<button
									key={f.id}
									type="button"
									className="mdb-chip"
									aria-pressed={taskFilter === f.id}
									onClick={() => onTaskFilter(f.id)}
								>
									{f.label}
								</button>
							))}
						</div>
						<select
							className="mdb-select"
							value={owner}
							onChange={(e) => setOwner(e.target.value)}
						>
							<option value="">Any owner</option>
							{owners.map((o) => (
								<option key={o} value={o}>
									{o}
								</option>
							))}
						</select>
					</>
				) : null}
				{type === "meeting" ? (
					<div className="mdb-chips">
						{(["upcoming", "past", "all"] as const).map((w) => (
							<button
								key={w}
								type="button"
								className="mdb-chip"
								aria-pressed={when === w}
								onClick={() => setWhen(w)}
							>
								{w[0].toUpperCase() + w.slice(1)}
							</button>
						))}
					</div>
				) : null}
				<span className="mdb-spacer" />
				<select
					className="mdb-select"
					value={sort}
					onChange={(e) => setSort(e.target.value as Sort)}
				>
					<option value="relevant">
						{type === "task"
							? "Due date"
							: type === "meeting"
								? "Date"
								: type === "note"
									? "Recent"
									: "Most linked"}
					</option>
					<option value="title">Title</option>
					<option value="updated">Recently updated</option>
				</select>
			</div>
			<div className="mdb-card">
				{rows.length ? (
					<ul className="mdb-rows">
						{rows.slice(0, limit).map((p) => (
							<PageRow
								key={p.slug}
								page={p}
								selected={props.selectedSlug === p.slug}
								onOpen={props.onOpen}
								busy={props.busy}
								onSetStatus={props.onSetStatus}
								ownerLoad={loads?.(p)}
								suggested={props.suggested?.get(p.slug)}
							/>
						))}
					</ul>
				) : (
					<div className="mdb-empty">Nothing matches.</div>
				)}
				{rows.length > limit ? (
					<div
						style={{
							padding: 12,
							textAlign: "center",
							borderTop: "1px solid var(--border)",
						}}
					>
						<button
							type="button"
							className="mdb-btn"
							onClick={() => setLimit((l) => l + 300)}
						>
							Show {Math.min(300, rows.length - limit)} more
						</button>
					</div>
				) : null}
			</div>
		</div>
	)
}
