"use client"

import { useEffect, useState } from "react"
import { type DrawerCtx, isRevisionConflict } from "./drawer-context.js"
import { Markdown } from "./markdown.js"
import { PagePicker } from "./page-picker.js"
import { pageType, type WikiPage } from "./shared.js"

/** Title, summary, aliases and body, saved as one revision-guarded PATCH:
 *  if someone (or a sync) changed the page since it was opened, the save is
 *  refused rather than overwriting their change. */
export function EditTab(ctx: DrawerCtx & { onSaved: () => void }) {
	const { page, client, scope, scopeRef, run, busy, openSlug } = ctx
	const [title, setTitle] = useState(page.title)
	const [summary, setSummary] = useState(page.summary ?? "")
	const [body, setBody] = useState(page.body ?? "")
	const [aliases, setAliases] = useState((page.aliases ?? []).join(", "))
	const [preview, setPreview] = useState(false)
	const [conflict, setConflict] = useState(false)

	const dirty =
		title !== page.title ||
		summary !== (page.summary ?? "") ||
		body !== (page.body ?? "") ||
		aliases !== (page.aliases ?? []).join(", ")

	const save = async () => {
		setConflict(false)
		const ok = await run(
			`Saved “${title.trim()}”`,
			async () => {
				try {
					return await client.wikiPatch({
						slug: page.slug,
						scope,
						scopeRef,
						patch: {
							title: title.trim(),
							summary,
							body,
							aliases: aliases
								.split(",")
								.map((a) => a.trim())
								.filter(Boolean),
						},
						...(typeof page.revision === "number"
							? { expectedRevision: page.revision }
							: {}),
					})
				} catch (err) {
					if (isRevisionConflict(err)) setConflict(true)
					throw err
				}
			},
			{ pages: [page.slug] },
		)
		if (ok) ctx.onSaved()
	}

	return (
		<div>
			{conflict ? (
				<div
					className="mdb-card mdb-card-pad"
					style={{
						marginBottom: 14,
						borderColor: "var(--warn)",
						background: "var(--warn-soft)",
					}}
				>
					This page changed since you opened it. Your edits are still here: copy
					anything you need, then reopen the page to see the latest version.
				</div>
			) : null}
			<label className="mdb-field">
				<span>Title</span>
				<input
					className="mdb-input"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label className="mdb-field">
				<span>Summary</span>
				<textarea
					className="mdb-textarea"
					rows={3}
					value={summary}
					onChange={(e) => setSummary(e.target.value)}
				/>
			</label>
			<label className="mdb-field">
				<span>Aliases (comma-separated)</span>
				<input
					className="mdb-input"
					value={aliases}
					onChange={(e) => setAliases(e.target.value)}
				/>
			</label>
			<div className="mdb-field">
				<span style={{ display: "flex", alignItems: "center" }}>
					Page (Markdown; [[slug]] links to another page)
					<span className="mdb-spacer" />
					<span className="mdb-chips">
						<button
							type="button"
							className="mdb-chip"
							aria-pressed={!preview}
							onClick={() => setPreview(false)}
						>
							Write
						</button>
						<button
							type="button"
							className="mdb-chip"
							aria-pressed={preview}
							onClick={() => setPreview(true)}
						>
							Preview
						</button>
					</span>
				</span>
				{preview ? (
					<div className="mdb-card mdb-card-pad" style={{ minHeight: 240 }}>
						{body.trim() ? (
							<Markdown text={body} onWikiLink={openSlug} />
						) : (
							<span className="mdb-muted">Nothing yet.</span>
						)}
					</div>
				) : (
					<textarea
						className="mdb-textarea"
						rows={16}
						value={body}
						onChange={(e) => setBody(e.target.value)}
					/>
				)}
			</div>
			<div
				style={{
					display: "flex",
					gap: 8,
					justifyContent: "flex-end",
					position: "sticky",
					bottom: -40,
					padding: "12px 0",
					background: "var(--panel)",
				}}
			>
				<button
					type="button"
					className="mdb-btn"
					disabled={!dirty || busy}
					onClick={() => {
						setTitle(page.title)
						setSummary(page.summary ?? "")
						setBody(page.body ?? "")
						setAliases((page.aliases ?? []).join(", "))
					}}
				>
					Discard
				</button>
				<button
					type="button"
					className="mdb-btn mdb-btn-primary"
					disabled={!dirty || busy || !title.trim()}
					onClick={save}
				>
					Save changes
				</button>
			</div>
		</div>
	)
}

type Revision = {
	revision: number
	editKind: string
	editor?: { subjectId?: string; displayName?: string }
	createdAt: string
}

/** Every revision of the page; any one can be read and restored. Restoring
 *  writes the old title, summary and body as a new revision, so nothing is
 *  lost and the restore itself can be undone. */
export function HistoryTab(ctx: DrawerCtx) {
	const { page, client, scope, scopeRef, run, busy, openSlug } = ctx
	const [revisions, setRevisions] = useState<Revision[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [open, setOpen] = useState<{
		revision: number
		snapshot: Record<string, unknown>
	} | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: a save bumps page.revision, and the list must refetch to show it
	useEffect(() => {
		let cancelled = false
		setRevisions(null)
		setOpen(null)
		client
			.wikiRevisions({ slug: page.slug, scope, scopeRef })
			.then((r) => !cancelled && setRevisions(r.revisions))
			.catch(
				(err: unknown) =>
					!cancelled &&
					setError(err instanceof Error ? err.message : String(err)),
			)
		return () => {
			cancelled = true
		}
	}, [client, page.slug, page.revision, scope, scopeRef])

	const view = async (revision: number) => {
		try {
			const r = await client.wikiRevision({
				slug: page.slug,
				scope,
				scopeRef,
				revision,
			})
			setOpen({ revision, snapshot: r.snapshot })
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>
	if (!revisions) return <p className="mdb-muted">Loading history…</p>

	return (
		<div>
			<ul className="mdb-rows mdb-card" style={{ marginBottom: 16 }}>
				{revisions.map((r) => (
					<li
						key={r.revision}
						className="mdb-row"
						data-selected={open?.revision === r.revision ? "true" : undefined}
					>
						<button
							type="button"
							className="mdb-row-btn"
							onClick={() => view(r.revision)}
						>
							<span
								className="mdb-badge"
								style={{ fontVariantNumeric: "tabular-nums" }}
							>
								r{r.revision}
							</span>
							<div className="mdb-row-main">
								<div className="mdb-row-title" style={{ fontWeight: 450 }}>
									{r.editKind}
									{r.revision === page.revision ? (
										<span
											className="mdb-badge mdb-badge-accent"
											style={{ marginLeft: 8 }}
										>
											current
										</span>
									) : null}
								</div>
								<div className="mdb-row-meta">
									{new Date(r.createdAt).toLocaleString(undefined, {
										day: "numeric",
										month: "short",
										year: "numeric",
										hour: "2-digit",
										minute: "2-digit",
									})}
									{r.editor?.displayName || r.editor?.subjectId
										? ` · ${r.editor.displayName ?? r.editor.subjectId}`
										: ""}
								</div>
							</div>
						</button>
					</li>
				))}
			</ul>
			{open ? (
				<div className="mdb-card">
					<div className="mdb-card-head">
						Revision {open.revision}
						<span className="mdb-spacer" />
						<button
							type="button"
							className="mdb-btn mdb-btn-sm mdb-btn-primary"
							disabled={busy || open.revision === page.revision}
							onClick={() =>
								run(
									`Restored revision ${open.revision}`,
									() =>
										client.wikiPatch({
											slug: page.slug,
											scope,
											scopeRef,
											patch: {
												title: String(open.snapshot.title ?? page.title),
												summary: String(open.snapshot.summary ?? ""),
												body: String(open.snapshot.body ?? ""),
											},
											...(typeof page.revision === "number"
												? { expectedRevision: page.revision }
												: {}),
										}),
									{ pages: [page.slug] },
								)
							}
						>
							Restore this version
						</button>
					</div>
					<div className="mdb-card-pad">
						<h3 style={{ margin: "0 0 6px", fontSize: 15 }}>
							{String(open.snapshot.title ?? "")}
						</h3>
						{open.snapshot.summary ? (
							<Markdown
								text={String(open.snapshot.summary)}
								onWikiLink={openSlug}
							/>
						) : null}
						{open.snapshot.body ? (
							<Markdown
								text={String(open.snapshot.body)}
								onWikiLink={openSlug}
							/>
						) : null}
					</div>
				</div>
			) : (
				<p className="mdb-muted" style={{ fontSize: 13 }}>
					Pick a revision to read it.
				</p>
			)}
		</div>
	)
}

/** Corrections that change more than this page: merging a duplicate,
 *  deleting, and purging material that should never have been stored. */
export function ManageTab(ctx: DrawerCtx & { onGone: () => void }) {
	const { page, pages, client, scope, scopeRef, run, busy } = ctx
	const [mergeInto, setMergeInto] = useState<WikiPage | null>(null)
	const [confirm, setConfirm] = useState("")
	const sameType = pages.filter(
		(p) => p.slug !== page.slug && pageType(p) === pageType(page),
	)

	return (
		<div>
			<div className="mdb-section mdb-card mdb-card-pad">
				<h3 className="mdb-section-title">Merge into another page</h3>
				<p className="mdb-muted" style={{ marginTop: 0, fontSize: 13 }}>
					For duplicates, such as “people/kai” and “people/kai-smith”. Links and
					tasks pointing here move to the page you pick, and this one is
					retired.
				</p>
				{mergeInto ? (
					<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
						<span style={{ flex: 1 }}>
							Into <strong>{mergeInto.title}</strong>
						</span>
						<button
							type="button"
							className="mdb-btn"
							onClick={() => setMergeInto(null)}
						>
							Cancel
						</button>
						<button
							type="button"
							className="mdb-btn mdb-btn-primary"
							disabled={busy}
							onClick={async () => {
								// Links move on every page that pointed here: reload all.
								const ok = await run(
									`Merged into ${mergeInto.title}`,
									() =>
										client.wikiMerge({
											from: page.slug,
											into: mergeInto.slug,
											scope,
											scopeRef,
										}),
									{ all: true },
								)
								if (ok) ctx.openSlug(mergeInto.slug)
							}}
						>
							Merge
						</button>
					</div>
				) : (
					<PagePicker
						pages={sameType}
						placeholder="Find the page to keep…"
						onPick={setMergeInto}
					/>
				)}
			</div>

			<div className="mdb-section mdb-card mdb-card-pad">
				<h3 className="mdb-section-title">Delete</h3>
				<p className="mdb-muted" style={{ marginTop: 0, fontSize: 13 }}>
					Hides the page from lists, search and answers. Its history is kept.
				</p>
				<button
					type="button"
					className="mdb-btn mdb-btn-danger"
					disabled={busy}
					onClick={async () => {
						const ok = await run(
							`Deleted “${page.title}”`,
							() => client.wikiDelete({ slug: page.slug, scope, scopeRef }),
							// The page drops out; pages it linked to lose a backlink.
							{
								pages: [
									page.slug,
									...(page.relationships ?? []).map((r) => r.targetPageSlug),
									...(page.backlinks ?? []).map((b) => b.sourcePageSlug),
								],
							},
						)
						if (ok) ctx.onGone()
					}}
				>
					Delete page
				</button>
			</div>

			<div
				className="mdb-section mdb-card mdb-card-pad"
				style={{
					borderColor: "color-mix(in srgb, var(--danger) 35%, var(--border))",
				}}
			>
				<h3 className="mdb-section-title" style={{ color: "var(--danger)" }}>
					Purge permanently
				</h3>
				<p className="mdb-muted" style={{ marginTop: 0, fontSize: 13 }}>
					Erases the page, every revision and the links to it, plus tasks
					extracted from it. For material that must not be kept, like a leaked
					secret. Cannot be undone. Type the slug to confirm.
				</p>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						className="mdb-input"
						style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
						placeholder={page.slug}
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
					/>
					<button
						type="button"
						className="mdb-btn mdb-btn-danger"
						disabled={busy || confirm !== page.slug}
						onClick={async () => {
							// Also removes extracted tasks and links: reload all.
							const ok = await run(
								`Purged “${page.title}”`,
								() => client.wikiPurge({ slug: page.slug, scope, scopeRef }),
								{ all: true },
							)
							if (ok) ctx.onGone()
						}}
					>
						Purge
					</button>
				</div>
			</div>
		</div>
	)
}
