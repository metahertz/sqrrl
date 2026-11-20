"use client"

// A suggestion to close a task, and the evidence it rests on. The user
// decides: Accept closes the task (done, or dropped as no longer needed),
// Dismiss forgets this evidence for the task. "Find evidence" asks for a
// fresh review of one task now.

import type { SqrrlClient } from "@sqrrl/client"
import { useState } from "react"
import type { QueuedDecision } from "./decision-queue.js"
import type { RunFn } from "./drawer-context.js"
import { IconSparkle } from "./icons.js"
import type { WikiPage } from "./shared.js"

export type Suggestion = {
	id: string
	taskSlug: string
	taskTitle: string
	proposed: "done" | "dropped"
	confidence: number
	rationale: string
	evidence: Array<{
		key: string
		kind: "page" | "raw"
		slug?: string
		title: string
		quote: string
		occurredAt?: string
		source?: string
	}>
}

export function proposalLabel(s: Pick<Suggestion, "proposed">): string {
	return s.proposed === "done" ? "Looks done" : "No longer needed"
}

type Common = {
	client: SqrrlClient
	scope: string
	scopeRef: string
	run: RunFn
	/** Queues accept/dismiss; the card disappears at once. */
	decide: (d: QueuedDecision) => void
	busy: boolean
	openSlug: (slug: string) => void
}

export function SuggestionCard({
	s,
	compact,
	...ctx
}: Common & { s: Suggestion; compact?: boolean }) {
	const [dismissing, setDismissing] = useState(false)
	const [note, setNote] = useState("")
	const evidence = compact ? s.evidence.slice(0, 1) : s.evidence
	return (
		<div className="mdb-suggestion">
			<div className="mdb-suggestion-head">
				<IconSparkle size={15} />
				<strong>{proposalLabel(s)}</strong>
				<span
					className={`mdb-badge ${s.proposed === "done" ? "mdb-badge-ok" : "mdb-badge-warn"}`}
				>
					{Math.round(s.confidence * 100)}%
				</span>
				{compact ? (
					<button
						type="button"
						className="mdb-link mdb-suggestion-task"
						onClick={() => ctx.openSlug(s.taskSlug)}
						title={s.taskSlug}
					>
						{s.taskTitle}
					</button>
				) : null}
			</div>
			{!compact && s.rationale ? (
				<p className="mdb-suggestion-why">{s.rationale}</p>
			) : null}
			<ul className="mdb-suggestion-evidence">
				{evidence.map((e) => (
					<li key={e.key}>
						<blockquote>“{e.quote}”</blockquote>
						<span className="mdb-muted">
							{e.source ?? e.kind}
							{e.occurredAt
								? ` · ${new Date(e.occurredAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
								: ""}
							{" · "}
							{e.slug ? (
								<button
									type="button"
									className="mdb-link"
									onClick={() => ctx.openSlug(e.slug as string)}
								>
									{e.title}
								</button>
							) : (
								e.title
							)}
						</span>
					</li>
				))}
			</ul>
			{dismissing ? (
				<div style={{ display: "flex", gap: 6 }}>
					<input
						className="mdb-input"
						style={{ flex: 1 }}
						placeholder="Why not? (optional)"
						value={note}
						onChange={(e) => setNote(e.target.value)}
					/>
					<button
						type="button"
						className="mdb-btn mdb-btn-sm"
						onClick={() => setDismissing(false)}
					>
						Cancel
					</button>
					<button
						type="button"
						className="mdb-btn mdb-btn-sm mdb-btn-danger"
						onClick={() =>
							ctx.decide({
								kind: "task-suggestion",
								id: s.id,
								action: "dismiss",
								...(note.trim() ? { note: note.trim() } : {}),
								label: `Kept open: ${s.taskTitle}`,
								affects: [],
							})
						}
					>
						Dismiss
					</button>
				</div>
			) : (
				<div style={{ display: "flex", gap: 6 }}>
					<button
						type="button"
						className="mdb-btn mdb-btn-sm mdb-btn-primary"
						onClick={() =>
							ctx.decide({
								kind: "task-suggestion",
								id: s.id,
								action: "accept",
								label:
									s.proposed === "done"
										? `Closed: ${s.taskTitle}`
										: `Dropped: ${s.taskTitle}`,
								// The task changes; the evidence pages gain a backlink.
								affects: [
									s.taskSlug,
									...s.evidence.flatMap((e) => (e.slug ? [e.slug] : [])),
								],
							})
						}
					>
						{s.proposed === "done" ? "Mark done" : "Drop task"}
					</button>
					<button
						type="button"
						className="mdb-btn mdb-btn-sm"
						disabled={ctx.busy}
						onClick={() => setDismissing(true)}
					>
						Not yet
					</button>
				</div>
			)}
		</div>
	)
}

/** In the task drawer: the pending suggestion, or a button to look for one. */
export function TaskEvidence(
	ctx: Common & { page: WikiPage; suggestion?: Suggestion },
) {
	const [result, setResult] = useState<string | null>(null)
	const find = async () => {
		setResult(null)
		await ctx.run(
			"Looked for evidence",
			async () => {
				const out = await ctx.client.reviewTask({
					slug: ctx.page.slug,
					scope: ctx.scope,
					scopeRef: ctx.scopeRef,
				})
				const r = out.outcome.result
				setResult(
					r === "suggested"
						? null
						: r === "no-evidence"
							? "Nothing newer than this task mentions it yet."
							: r === "no-verdict"
								? "Found related items, but nothing that shows it is finished."
								: r === "dismissed-evidence"
									? "Only evidence you already dismissed."
									: "This task is no longer open.",
				)
			},
			{ lists: true },
		)
	}
	return (
		<div className="mdb-section">
			<h3 className="mdb-section-title">
				Is it finished?
				<span className="mdb-spacer" />
				<button
					type="button"
					className="mdb-btn mdb-btn-sm"
					disabled={ctx.busy}
					onClick={find}
					title="Search notes, meetings, Slack and mail since this task was created"
				>
					<IconSparkle size={13} /> Find evidence
				</button>
			</h3>
			{ctx.suggestion ? (
				<SuggestionCard {...ctx} s={ctx.suggestion} />
			) : (
				<p className="mdb-muted" style={{ margin: 0, fontSize: 13 }}>
					{result ??
						"No suggestion yet. New notes, meetings, Slack and mail are checked against open tasks as they arrive."}
				</p>
			)}
		</div>
	)
}
