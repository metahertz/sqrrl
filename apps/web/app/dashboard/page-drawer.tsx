"use client"

import { useEffect, useState } from "react"
import type { DrawerCtx } from "./drawer-context.js"
import { OverviewTab } from "./drawer-overview.js"
import { EditTab, HistoryTab, ManageTab } from "./drawer-tabs.js"
import { IconBook, IconExternal, IconX } from "./icons.js"
import { pageType, TYPE_META } from "./shared.js"
import { wikiPageUrl } from "./wiki-links.js"

export type Tab = "overview" | "edit" | "history" | "manage"

/** The selected page, over whatever view is open: read it, edit it, see its
 *  history, or merge/delete it, without losing your place. Escape closes. */
export function PageDrawer(
	ctx: DrawerCtx & {
		onClose: () => void
		/** The tab to open on (the wiki's Edit and History buttons). */
		initialTab?: Tab
		onReadInWiki?: (slug: string) => void
	},
) {
	const { page, scope, scopeRef, apiBase, onClose } = ctx
	const [tab, setTab] = useState<Tab>(ctx.initialTab ?? "overview")
	const type = pageType(page)
	const meta = TYPE_META[type]
	const deprecated =
		(page.frontmatter as { status?: string } | undefined)?.status ===
		"deprecated"

	// A different page opens on its overview, not mid-edit of the last one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on purpose whenever the page shown changes
	useEffect(() => {
		setTab(ctx.initialTab ?? "overview")
	}, [page.slug, ctx.initialTab])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (
				e.key === "Escape" &&
				!(e.target as HTMLElement)?.closest?.("input, textarea, select")
			)
				onClose()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose])

	return (
		<>
			<aside className="mdb-drawer" aria-label={page.title}>
				<div className="mdb-drawer-head">
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							marginBottom: 8,
						}}
					>
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
						{deprecated ? (
							<span className="mdb-badge mdb-badge-warn">
								removed / deprecated
							</span>
						) : null}
						{typeof page.revision === "number" ? (
							<span className="mdb-badge">r{page.revision}</span>
						) : null}
						{page.updatedAt ? (
							<span className="mdb-muted" style={{ fontSize: 12 }}>
								updated{" "}
								{new Date(page.updatedAt).toLocaleDateString(undefined, {
									day: "numeric",
									month: "short",
									year: "numeric",
								})}
							</span>
						) : null}
						<span className="mdb-spacer" />
						{ctx.onReadInWiki ? (
							<button
								type="button"
								className="mdb-btn mdb-btn-sm"
								onClick={() => ctx.onReadInWiki?.(page.slug)}
								title="Read this page in the wiki"
							>
								<IconBook size={13} /> Read in wiki
							</button>
						) : null}
						<a
							className="mdb-btn mdb-btn-ghost mdb-btn-icon"
							href={wikiPageUrl(apiBase, page.slug, scope, scopeRef)}
							target="_blank"
							rel="noopener noreferrer"
							title="Standalone page, for sharing a link"
						>
							<IconExternal />
						</a>
						<button
							type="button"
							className="mdb-btn mdb-btn-ghost mdb-btn-icon"
							onClick={onClose}
							title="Close (Esc)"
						>
							<IconX />
						</button>
					</div>
					<div className="mdb-drawer-title">
						<h2>{page.title}</h2>
					</div>
					<div className="mdb-slug">{page.slug}</div>
					<div className="mdb-tabs" role="tablist">
						{(["overview", "edit", "history", "manage"] as Tab[]).map((t) => (
							<button
								key={t}
								type="button"
								role="tab"
								className="mdb-tab"
								aria-selected={tab === t}
								onClick={() => setTab(t)}
							>
								{t[0].toUpperCase() + t.slice(1)}
							</button>
						))}
					</div>
				</div>
				<div className="mdb-drawer-body">
					{tab === "overview" ? <OverviewTab {...ctx} /> : null}
					{tab === "edit" ? (
						<EditTab
							key={`${page.slug}@${page.revision}`}
							{...ctx}
							onSaved={() => setTab("overview")}
						/>
					) : null}
					{tab === "history" ? <HistoryTab {...ctx} /> : null}
					{tab === "manage" ? <ManageTab {...ctx} onGone={onClose} /> : null}
				</div>
			</aside>
		</>
	)
}
