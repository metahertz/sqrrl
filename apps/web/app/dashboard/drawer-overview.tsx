"use client"

import { useState } from "react"
import { type DrawerCtx, EDGE_KINDS, edgeLabel } from "./drawer-context.js"
import { IconPlus, IconX } from "./icons.js"
import { Markdown } from "./markdown.js"
import { PagePicker } from "./page-picker.js"
import { pageType, TYPE_META, type WikiPage } from "./shared.js"
import { type TaskStatus, taskStatusOf } from "./task-status.js"
import { TaskEvidence } from "./suggestion-panel.js"
import { isOverdue } from "./wiki-data.js"

/** "dropped" is ingestion's marker for a task gone from its source, and the
 *  next extraction treats it as "offer again", so it is shown but never
 *  offered (see OFFERED_STATUSES). */
const STATUSES: TaskStatus[] = ["open", "in-progress", "blocked", "done"]

function TaskSection(ctx: DrawerCtx) {
	const { page, pages, client, scope, scopeRef, run, busy } = ctx
	const card = page.taskCard ?? {}
	const status = taskStatusOf(page)
	const [changingOwner, setChangingOwner] = useState(false)
	const people = pages.filter((p) => pageType(p) === "person")
	const revision =
		typeof page.revision === "number" ? { expectedRevision: page.revision } : {}

	const setStatus = (next: TaskStatus) =>
		run(
			`Marked “${page.title}” ${next}`,
			() =>
				client.wikiSetTaskStatus({
					slug: page.slug,
					scope,
					scopeRef,
					status: next,
					taskCard: {
						owner: card.owner ?? "unassigned",
						...(card.dueDate ? { dueDate: card.dueDate } : {}),
						...(card.sourceRef ? { sourceRef: card.sourceRef } : {}),
					},
					...revision,
				}),
			{ pages: [page.slug] },
		)

	const setDue = (dueDate: string) =>
		run(
			dueDate ? `Due date set to ${dueDate}` : "Due date cleared",
			() =>
				client.wikiPatch({
					slug: page.slug,
					scope,
					scopeRef,
					patch: {
						taskCard: {
							owner: card.owner ?? "unassigned",
							status,
							...(dueDate ? { dueDate } : {}),
							...(card.sourceRef ? { sourceRef: card.sourceRef } : {}),
							...(card.completedAt ? { completedAt: card.completedAt } : {}),
						},
					},
					...revision,
				}),
			{ pages: [page.slug] },
		)

	return (
		<div className="mdb-section">
			<h3 className="mdb-section-title">Task</h3>
			<dl className="mdb-kv">
				<dt>Status</dt>
				<dd>
					<div className="mdb-chips">
						{(status === "dropped" ? [...STATUSES, status] : STATUSES).map(
							(s) => (
								<button
									key={s}
									type="button"
									className="mdb-chip"
									aria-pressed={status === s}
									disabled={busy || status === s}
									onClick={() => setStatus(s)}
								>
									{s}
								</button>
							),
						)}
					</div>
				</dd>
				<dt>Owner</dt>
				<dd>
					{changingOwner ? (
						<div style={{ display: "flex", gap: 6 }}>
							<div style={{ flex: 1 }}>
								<PagePicker
									pages={people}
									autoFocus
									placeholder="Pick a person…"
									onPick={async (p) => {
										const ok = await run(
											`Reassigned to ${p.title}`,
											() =>
												client.wikiReassignTask({
													slug: page.slug,
													scope,
													scopeRef,
													owner: { name: p.title, hubSlug: p.slug },
												}),
											// The task, the new owner and the old one(s).
											{
												pages: [
													page.slug,
													p.slug,
													...(page.relationships ?? [])
														.filter((r) => r.kind === "owned_by")
														.map((r) => r.targetPageSlug),
												],
											},
										)
										if (ok) setChangingOwner(false)
									}}
								/>
							</div>
							<button
								type="button"
								className="mdb-btn mdb-btn-ghost mdb-btn-icon"
								onClick={() => setChangingOwner(false)}
							>
								<IconX />
							</button>
						</div>
					) : (
						<span
							style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
						>
							<strong>{card.owner ?? "unassigned"}</strong>
							<button
								type="button"
								className="mdb-btn mdb-btn-sm"
								disabled={busy}
								onClick={() => setChangingOwner(true)}
							>
								Change
							</button>
						</span>
					)}
				</dd>
				<dt>Due</dt>
				<dd style={{ display: "flex", gap: 8, alignItems: "center" }}>
					<input
						type="date"
						className="mdb-input"
						value={card.dueDate ?? ""}
						disabled={busy}
						onChange={(e) => setDue(e.target.value)}
					/>
					{isOverdue(page) ? (
						<span className="mdb-badge mdb-badge-danger">overdue</span>
					) : null}
					{card.dueDate ? (
						<button
							type="button"
							className="mdb-btn mdb-btn-sm mdb-btn-ghost"
							disabled={busy}
							onClick={() => setDue("")}
						>
							Clear
						</button>
					) : null}
				</dd>
				{card.completedAt ? (
					<>
						<dt>Completed</dt>
						<dd>{String(card.completedAt).slice(0, 10)}</dd>
					</>
				) : null}
			</dl>
		</div>
	)
}

function MeetingSection({ page }: { page: WikiPage }) {
	const m = (page.frontmatter?.meeting ?? {}) as {
		start?: string
		end?: string
		location?: string
		calendar?: string
		status?: string
	}
	if (!m.start) return null
	const fmt = (iso?: string) =>
		iso
			? new Date(iso).toLocaleString(undefined, {
					dateStyle: "medium",
					timeStyle: "short",
				})
			: ""
	return (
		<div className="mdb-section">
			<h3 className="mdb-section-title">Meeting</h3>
			<dl className="mdb-kv">
				<dt>When</dt>
				<dd>
					{fmt(m.start)} –{" "}
					{m.end
						? new Date(m.end).toLocaleTimeString(undefined, {
								timeStyle: "short",
							})
						: ""}
				</dd>
				{m.location ? (
					<>
						<dt>Where</dt>
						<dd>{m.location}</dd>
					</>
				) : null}
				{m.calendar ? (
					<>
						<dt>Calendar</dt>
						<dd>{m.calendar}</dd>
					</>
				) : null}
			</dl>
		</div>
	)
}

function LinksSection(ctx: DrawerCtx) {
	const { page, pages, client, scope, scopeRef, run, busy, openSlug } = ctx
	const [adding, setAdding] = useState(false)
	const [kind, setKind] = useState("relates_to")
	const bySlug = new Map(pages.map((p) => [p.slug, p]))
	const rels = page.relationships ?? []
	const backlinks = page.backlinks ?? []
	const groups = new Map<string, typeof rels>()
	for (const r of rels) {
		const list = groups.get(r.kind)
		if (list) list.push(r)
		else groups.set(r.kind, [r])
	}

	const chip = (slug: string, title: string, onRemove?: () => void) => {
		const target = bySlug.get(slug)
		const color = target ? TYPE_META[pageType(target)].color : "#94a3b8"
		return (
			<span
				key={slug}
				className="mdb-chip"
				style={{ cursor: "default", paddingRight: onRemove ? 4 : 10 }}
			>
				<span className="mdb-dot" style={{ background: color }} />
				<button
					type="button"
					className="mdb-link"
					style={{ color: "var(--ink)" }}
					onClick={() => openSlug(slug)}
					title={slug}
				>
					{title}
				</button>
				{onRemove ? (
					<button
						type="button"
						className="mdb-btn mdb-btn-ghost mdb-btn-sm"
						style={{ width: 20, height: 20, padding: 0 }}
						title="Remove this link"
						disabled={busy}
						onClick={onRemove}
					>
						<IconX size={12} />
					</button>
				) : null}
			</span>
		)
	}

	return (
		<div className="mdb-section">
			<h3 className="mdb-section-title">
				Links
				<span className="mdb-spacer" />
				<button
					type="button"
					className="mdb-btn mdb-btn-sm"
					disabled={busy}
					onClick={() => setAdding((a) => !a)}
				>
					<IconPlus size={13} /> Add link
				</button>
			</h3>
			{adding ? (
				<div
					className="mdb-card mdb-card-pad"
					style={{ marginBottom: 12, display: "flex", gap: 8 }}
				>
					<select
						className="mdb-select"
						value={kind}
						onChange={(e) => setKind(e.target.value)}
					>
						{EDGE_KINDS.map((k) => (
							<option key={k} value={k}>
								{edgeLabel(k)}
							</option>
						))}
					</select>
					<div style={{ flex: 1 }}>
						<PagePicker
							pages={pages.filter((p) => p.slug !== page.slug)}
							autoFocus
							placeholder="Link to…"
							onPick={async (target) => {
								const ok = await run(
									`Linked to ${target.title}`,
									() =>
										client.wikiEditRelationships({
											slug: page.slug,
											scope,
											scopeRef,
											add: [
												{
													targetPageSlug: target.slug,
													targetTitle: target.title,
													kind,
												},
											],
										}),
									{ pages: [page.slug, target.slug] },
								)
								if (ok) setAdding(false)
							}}
						/>
					</div>
				</div>
			) : null}
			{rels.length === 0 && !adding ? (
				<p className="mdb-muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
					No outgoing links.
				</p>
			) : null}
			{[...groups.entries()].map(([k, list]) => (
				<div key={k} style={{ marginBottom: 10 }}>
					<div className="mdb-muted" style={{ fontSize: 12, marginBottom: 5 }}>
						{edgeLabel(k)}
					</div>
					<div className="mdb-chips">
						{list.map((r) =>
							chip(
								r.targetPageSlug,
								r.targetTitle ??
									bySlug.get(r.targetPageSlug)?.title ??
									r.targetPageSlug,
								() =>
									run(
										`Removed link to ${r.targetTitle ?? r.targetPageSlug}`,
										() =>
											client.wikiEditRelationships({
												slug: page.slug,
												scope,
												scopeRef,
												remove: [
													{ targetPageSlug: r.targetPageSlug, kind: r.kind },
												],
											}),
										{ pages: [page.slug, r.targetPageSlug] },
									),
							),
						)}
					</div>
				</div>
			))}
			{backlinks.length ? (
				<div style={{ marginTop: 14 }}>
					<div className="mdb-muted" style={{ fontSize: 12, marginBottom: 5 }}>
						Linked from ({backlinks.length})
					</div>
					<div className="mdb-chips">
						{backlinks.map((b) =>
							chip(
								b.sourcePageSlug,
								b.sourceTitle ??
									bySlug.get(b.sourcePageSlug)?.title ??
									b.sourcePageSlug,
							),
						)}
					</div>
				</div>
			) : null}
		</div>
	)
}

export function OverviewTab(ctx: DrawerCtx) {
	const { page, openSlug } = ctx
	const type = pageType(page)
	return (
		<>
			{type === "task" ? <TaskSection {...ctx} /> : null}
			{type === "task" && !["done", "dropped"].includes(taskStatusOf(page)) ? (
				<TaskEvidence
					{...ctx}
					suggestion={ctx.suggestions?.find((s) => s.taskSlug === page.slug)}
				/>
			) : null}
			{type === "meeting" ? <MeetingSection page={page} /> : null}
			{page.summary ? (
				<div className="mdb-section">
					<h3 className="mdb-section-title">Summary</h3>
					<Markdown text={page.summary} onWikiLink={openSlug} />
				</div>
			) : null}
			{page.body?.trim() ? (
				<div className="mdb-section">
					<h3 className="mdb-section-title">Page</h3>
					<Markdown text={page.body} onWikiLink={openSlug} />
				</div>
			) : null}
			{page.claims?.length ? (
				<div className="mdb-section">
					<h3 className="mdb-section-title">Claims ({page.claims.length})</h3>
					<ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
						{page.claims.map((c) => (
							<li key={c.text} style={{ marginBottom: 4 }}>
								{c.text}
								{typeof c.confidence === "number" ? (
									<span className="mdb-muted" style={{ fontSize: 11.5 }}>
										{" "}
										· {Math.round(c.confidence * 100)}%
									</span>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<LinksSection {...ctx} />
		</>
	)
}
