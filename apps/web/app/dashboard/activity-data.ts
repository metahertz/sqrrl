// Pure helpers for the Activity view: is background work still coming,
// how long until the task review backlog clears, and how each job and
// source is doing. Kept free of React so they are unit tested.

import type { SqrrlStatus, SqrrlStatusJob } from "@sqrrl/client"

/** Default per-run limits of POST /v1/wiki/task-review/run, used when the
 *  server does not report its own (taskReview.perRun). */
export const SOURCES_PER_RUN = 50
export const TASKS_PER_RUN = 20

export function perRun(status: SqrrlStatus): {
	sources: number
	tasks: number
} {
	return (
		status.taskReview.perRun ?? {
			sources: SOURCES_PER_RUN,
			tasks: TASKS_PER_RUN,
		}
	)
}
const DEFAULT_INTERVAL_MS = 30 * 60_000

/** A source that has delivered nothing for this long is flagged. */
export const QUIET_SOURCE_MS = 3 * 24 * 3600_000

export type Tone = "ok" | "warn" | "danger" | "accent" | "neutral"

const SOURCE_LABELS: Record<string, string> = {
	"apple-notes": "Apple Notes",
	calendar: "Calendar",
	email: "Mail",
	nextcloud: "Nextcloud",
	slack: "Slack",
}

export function sourceLabel(source: string): string {
	return (
		SOURCE_LABELS[source] ??
		source.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
	)
}

/** "just now", "5 min ago", "in 2 h", "3 days ago". */
export function relTime(iso: string | null | undefined, now = Date.now()) {
	if (!iso) return "never"
	const t = Date.parse(iso)
	if (Number.isNaN(t)) return "unknown"
	const diff = t - now
	const abs = Math.abs(diff)
	if (abs < 45_000) return "just now"
	let text: string
	if (abs < 3600_000) text = `${Math.round(abs / 60_000)} min`
	else if (abs < 48 * 3600_000) {
		const h = abs / 3600_000
		text = `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`
	} else text = `${Math.round(abs / (24 * 3600_000))} days`
	return diff > 0 ? `in ${text}` : `${text} ago`
}

export function jobState(job: SqrrlStatusJob): { text: string; tone: Tone } {
	if (job.running) return { text: "Running", tone: "accent" }
	if (job.installed === false) return { text: "Not installed", tone: "neutral" }
	if (!job.enabled) return { text: "Off", tone: "neutral" }
	if (job.result === null) return { text: "Not run yet", tone: "neutral" }
	if (job.result === "failed") return { text: "Failed", tone: "danger" }
	if (job.problem) return { text: "Problem", tone: "warn" }
	return { text: "OK", tone: "ok" }
}

export function taskReviewJob(status: SqrrlStatus): SqrrlStatusJob | undefined {
	return status.host.jobs?.find((j) => j.id === "task_review")
}

/** When the task review backlog should clear at the current pace, or null
 *  when there is no backlog or nothing is scheduled to work it off. Each run
 *  expands up to perRun().sources queued pages and judges up to
 *  perRun().tasks tasks, so the slower of the two sets the pace. Expanding
 *  pages marks more tasks, so this is a lower bound. */
export function backlogEta(
	status: SqrrlStatus,
	now = Date.now(),
): { runs: number; finishAt: string } | null {
	const { queuedSources, pendingTasks } = status.taskReview
	if (!queuedSources && !pendingTasks) return null
	const job = taskReviewJob(status)
	if (!job?.enabled) return null
	const per = perRun(status)
	const runs = Math.max(
		Math.ceil(queuedSources / per.sources),
		Math.ceil(pendingTasks / per.tasks),
	)
	const next = job.nextRunAt ? Date.parse(job.nextRunAt) : Number.NaN
	const last = job.lastStartedAt ? Date.parse(job.lastStartedAt) : Number.NaN
	const interval =
		next > last ? Math.max(60_000, next - last) : DEFAULT_INTERVAL_MS
	// The first pass is the running one, else the next scheduled one; the
	// last of `runs` passes starts (runs - 1) intervals after it.
	const first = job.running ? now : next > now ? next : now
	const finishAt = first + (runs - 1) * interval
	return { runs, finishAt: new Date(finishAt).toISOString() }
}

export interface Outlook {
	state: "working" | "idle" | "attention"
	headline: string
	/** Short lines under the headline. */
	details: string[]
}

function plural(n: number, word: string) {
	return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`
}

/** The one-line answer to "are we still expecting new tasks or close
 *  suggestions?", with what needs a look. */
export function outlook(status: SqrrlStatus, now = Date.now()): Outlook {
	const details: string[] = []
	const { queuedSources, pendingTasks, suggestions } = status.taskReview
	const jobs = status.host.jobs ?? []
	const broken = jobs.filter(
		(j) =>
			j.enabled && !j.running && (j.result === "failed" || Boolean(j.problem)),
	)
	const review = taskReviewJob(status)
	const backlog = queuedSources > 0 || pendingTasks > 0
	const parts: string[] = []
	if (queuedSources) parts.push(`${plural(queuedSources, "page")} to scan`)
	if (pendingTasks) parts.push(`${plural(pendingTasks, "task")} to check`)
	if (backlog) {
		const eta = backlogEta(status, now)
		details.push(
			`Task review: ${parts.join(", ")}${
				eta ? `; clears ${relTime(eta.finishAt, now)} at the current pace` : ""
			}.`,
		)
	}
	if (suggestions.pending)
		details.push(
			`${plural(suggestions.pending, "close suggestion")} waiting for your decision.`,
		)
	for (const j of broken)
		details.push(
			`${j.label}: ${j.problem ?? `last run failed (exit ${j.exitCode ?? "?"})`}.`,
		)
	if (backlog && status.host.available && review && !review.enabled)
		details.push("Task review is switched off, so the backlog is not moving.")
	if (!status.host.available && status.host.reason)
		details.push(`Scheduled jobs unknown: ${status.host.reason}.`)

	if (broken.length || (backlog && review && !review.enabled))
		return {
			state: "attention",
			headline: broken.length
				? `${plural(broken.length, "job")} need a look`
				: "Task review is off with work waiting",
			details,
		}
	if (backlog || review?.running)
		return {
			state: "working",
			headline: "Still working: more tasks and close suggestions may appear",
			details,
		}
	return {
		state: "idle",
		headline: "All caught up: nothing waiting for task review",
		details,
	}
}

export function sourceTone(
	lastReceivedAt: string | undefined,
	now = Date.now(),
): Tone {
	if (!lastReceivedAt) return "neutral"
	return now - Date.parse(lastReceivedAt) > QUIET_SOURCE_MS ? "warn" : "ok"
}
