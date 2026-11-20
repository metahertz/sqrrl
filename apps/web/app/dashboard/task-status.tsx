"use client"

import { palette, type WikiPage, type WikiTaskCard } from "./shared.js"

export type TaskStatus = "open" | "in-progress" | "blocked" | "done" | "dropped"

/** The statuses offered in the UI. "blocked" and "dropped" exist in the
 *  schema but are not offered here: dropped is ingestion's own marker for a
 *  task that vanished from its source note, and reopening one by hand would
 *  fight the next extraction run, which treats dropped as "offer again". */
export const OFFERED_STATUSES: TaskStatus[] = ["open", "in-progress", "done"]

export function isTask(page: WikiPage): boolean {
	return Boolean(page.taskCard)
}

export function taskStatusOf(page: WikiPage): TaskStatus {
	return (page.taskCard?.status as TaskStatus) ?? "open"
}

export const statusColor: Record<TaskStatus, string> = {
	open: palette.muted,
	"in-progress": palette.warning,
	blocked: palette.error,
	done: palette.success,
	dropped: palette.muted,
}

/** Marks a task done, or puts it back. One control rather than a status
 *  picker, because "done" is the transition that actually gets used and a
 *  single click is the whole point. The full picker lives in the maintenance
 *  panel for the rarer moves. */
export function DoneToggle({
	page,
	busy,
	onSetStatus,
	compact = false,
}: {
	page: WikiPage
	busy: boolean
	onSetStatus: (page: WikiPage, status: TaskStatus) => void
	/** List rows are dense; the pane has room for a word more. */
	compact?: boolean
}) {
	const status = taskStatusOf(page)
	const done = status === "done"
	return (
		<button
			type="button"
			disabled={busy}
			onClick={() => onSetStatus(page, done ? "open" : "done")}
			title={
				done
					? `Reopen "${page.title}"`
					: `Mark "${page.title}" done${
							page.taskCard?.owner ? ` (${page.taskCard.owner})` : ""
						}`
			}
			aria-label={done ? `Reopen ${page.title}` : `Mark ${page.title} done`}
			style={{
				border: `1px solid ${done ? palette.success : palette.border}`,
				borderRadius: 6,
				background: done ? "#ecfdf5" : palette.panel,
				color: done ? palette.success : palette.ink,
				padding: compact ? "1px 7px" : "3px 10px",
				fontSize: compact ? 11.5 : 12.5,
				cursor: busy ? "progress" : "pointer",
				flex: "0 0 auto",
				opacity: busy ? 0.6 : 1,
			}}
		>
			{done
				? compact
					? "✓ done"
					: "✓ done — reopen"
				: compact
					? "done"
					: "Mark done"}
		</button>
	)
}

/** Full status picker for the maintenance panel. */
export function StatusPicker({
	page,
	busy,
	onSetStatus,
}: {
	page: WikiPage
	busy: boolean
	onSetStatus: (page: WikiPage, status: TaskStatus) => void
}) {
	const current = taskStatusOf(page)
	return (
		<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
			{OFFERED_STATUSES.map((s) => {
				const active = s === current
				return (
					<button
						key={s}
						type="button"
						disabled={busy || active}
						onClick={() => onSetStatus(page, s)}
						style={{
							border: `1px solid ${active ? statusColor[s] : palette.border}`,
							borderRadius: 6,
							background: active ? "#f1f5f9" : palette.panel,
							color: active ? statusColor[s] : palette.ink,
							padding: "3px 10px",
							fontSize: 12.5,
							fontWeight: active ? 600 : 400,
							cursor: active ? "default" : busy ? "progress" : "pointer",
						}}
					>
						{s}
					</button>
				)
			})}
		</div>
	)
}

/** Reads back what was stored, for the caption under the picker. */
export function completedCaption(
	card: WikiTaskCard | null | undefined,
): string {
	if (!card || card.status !== "done") return ""
	const at = card.completedAt
	if (!at) return "done"
	const day = String(at).slice(0, 10)
	return `done ${day}`
}
