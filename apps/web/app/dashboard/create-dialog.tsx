"use client"

import type { RunFn } from "./drawer-context.js"
import type { SqrrlClient } from "@sqrrl/client"
import { useEffect, useRef, useState } from "react"
import { NEW_PAGE_KINDS, slugify } from "./new-page.js"
import { PagePicker } from "./page-picker.js"
import { pageType, type PageType, TYPE_META, type WikiPage } from "./shared.js"

export type CreatableType = Extract<
	PageType,
	"note" | "task" | "person" | "topic"
>
export const CREATABLE: CreatableType[] = ["note", "task", "person", "topic"]

/** The slug a new page gets. Topics and people follow the hub convention
 *  the distillers use (new-page.ts), so a later note mentioning the same
 *  name links to the hand-made hub instead of minting a twin; tasks follow
 *  taskSlug in source-layer. */
export function draftSlug(
	type: CreatableType,
	title: string,
	owner?: string,
): string {
	if (type === "topic") return `${NEW_PAGE_KINDS[0].prefix}${slugify(title)}`
	if (type === "person") return `${NEW_PAGE_KINDS[1].prefix}${slugify(title)}`
	if (type === "task")
		return `tasks/${slugify(owner || "me", 24)}-${slugify(title, 40)}`
	return `notes/${slugify(title, 64)}`
}

/** A note's default summary: its first line of text, else its title. */
export function noteSummary(body: string, title: string): string {
	const first = body
		.split("\n")
		.map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
		.find(Boolean)
	if (!first) return title
	return first.length > 200 ? `${first.slice(0, 199)}…` : first
}

export function CreateDialog({
	initialType,
	pages,
	client,
	scope,
	scopeRef,
	run,
	busy,
	onClose,
	onCreated,
}: {
	initialType: CreatableType
	pages: WikiPage[]
	client: SqrrlClient
	scope: string
	scopeRef: string
	run: RunFn
	busy: boolean
	onClose: () => void
	onCreated: (slug: string) => void
}) {
	const [type, setType] = useState<CreatableType>(initialType)
	const titleInput = useRef<HTMLInputElement>(null)
	useEffect(() => titleInput.current?.focus(), [])
	const [title, setTitle] = useState("")
	const [summary, setSummary] = useState("")
	const [body, setBody] = useState("")
	const [owner, setOwner] = useState<WikiPage | null>(null)
	const [due, setDue] = useState("")
	const ownerName = owner?.title ?? "me"
	const slug = draftSlug(
		type,
		title.trim(),
		type === "task" ? ownerName : undefined,
	)
	const clash = pages.find((p) => p.slug === slug)
	const error = !title.trim()
		? null
		: clash
			? `“${clash.title}” already uses ${slug}.`
			: null

	const create = async () => {
		const clean = title.trim()
		const kind =
			type === "task"
				? "procedure"
				: type === "person"
					? "entity"
					: type === "topic"
						? "concept"
						: "source"
		const defaultSummary =
			type === "task"
				? `${ownerName} owns: ${clean}`
				: type === "person"
					? `Person hub for ${clean}. Tasks they own link here.`
					: type === "topic"
						? `Topic hub for ${clean}. Sources referencing it link here.`
						: // The API requires a summary; a note's is its opening words.
							noteSummary(body, clean)
		const ok = await run(
			`Created ${TYPE_META[type].label.toLowerCase()} “${clean}”`,
			async () => {
				await client.wikiApply({
					kind,
					title: clean,
					slug,
					summary: summary.trim() || defaultSummary,
					body,
					frontmatter: { type: type === "note" ? "note" : type },
					scope,
					scopeRef,
					trustTier: "standard",
				})
				if (type === "task") {
					await client.wikiPatch({
						slug,
						scope,
						scopeRef,
						patch: {
							taskCard: {
								owner: ownerName,
								status: "open",
								...(due ? { dueDate: due } : {}),
							},
						},
					})
					// The owned_by edge and the owner on the card move together.
					if (owner)
						await client.wikiReassignTask({
							slug,
							scope,
							scopeRef,
							owner: { name: owner.title, hubSlug: owner.slug },
						})
				}
			},
			// The new page, and the owner's hub that gains a backlink.
			{ pages: [slug, ...(owner ? [owner.slug] : [])] },
		)
		if (ok) onCreated(slug)
	}

	return (
		<>
			<div className="mdb-scrim" onClick={onClose} aria-hidden="true" />
			<div className="mdb-dialog" role="dialog" aria-label="New page">
				<div className="mdb-dialog-head">New page</div>
				<div className="mdb-dialog-body">
					<div className="mdb-chips" style={{ marginBottom: 14 }}>
						{CREATABLE.map((t) => (
							<button
								key={t}
								type="button"
								className="mdb-chip"
								aria-pressed={type === t}
								onClick={() => setType(t)}
							>
								<span
									className="mdb-dot"
									style={{ background: TYPE_META[t].color }}
								/>
								{TYPE_META[t].label}
							</button>
						))}
					</div>
					<label className="mdb-field">
						<span>{type === "task" ? "What needs doing" : "Title"}</span>
						<input
							className="mdb-input"
							ref={titleInput}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
						{title.trim() ? (
							<span className="mdb-slug" style={{ fontWeight: 400 }}>
								{slug}
							</span>
						) : null}
					</label>
					{type === "task" ? (
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 160px",
								gap: 12,
							}}
						>
							<div className="mdb-field">
								<span>
									Owner {owner ? `: ${owner.title}` : "(default: me)"}
								</span>
								<PagePicker
									pages={pages.filter((p) => pageType(p) === "person")}
									placeholder="Pick a person…"
									onPick={setOwner}
								/>
							</div>
							<label className="mdb-field">
								<span>Due</span>
								<input
									type="date"
									className="mdb-input"
									value={due}
									onChange={(e) => setDue(e.target.value)}
								/>
							</label>
						</div>
					) : null}
					<label className="mdb-field">
						<span>Summary {type !== "note" ? "(optional)" : ""}</span>
						<textarea
							className="mdb-textarea"
							rows={2}
							value={summary}
							onChange={(e) => setSummary(e.target.value)}
						/>
					</label>
					{type === "note" ? (
						<label className="mdb-field">
							<span>Body (Markdown)</span>
							<textarea
								className="mdb-textarea"
								rows={8}
								value={body}
								onChange={(e) => setBody(e.target.value)}
							/>
						</label>
					) : null}
					{error ? (
						<p
							style={{
								color: "var(--danger)",
								fontSize: 13,
								margin: "0 0 8px",
							}}
						>
							{error}
						</p>
					) : null}
				</div>
				<div className="mdb-dialog-foot">
					<button type="button" className="mdb-btn" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="mdb-btn mdb-btn-primary"
						disabled={busy || !title.trim() || Boolean(error)}
						onClick={create}
					>
						Create
					</button>
				</div>
			</div>
		</>
	)
}
