import type { SqrrlStatus, SqrrlStatusJob } from "@sqrrl/client"
import { describe, expect, it } from "vitest"
import {
	backlogEta,
	jobState,
	outlook,
	relTime,
	sourceLabel,
	sourceTone,
} from "./activity-data.js"

const NOW = Date.parse("2026-11-18T16:00:00Z")
const MIN = 60_000

function job(over: Partial<SqrrlStatusJob> = {}): SqrrlStatusJob {
	return {
		id: "task_review",
		label: "Task review",
		installed: true,
		enabled: true,
		running: false,
		lastStartedAt: new Date(NOW - 20 * MIN).toISOString(),
		lastFinishedAt: new Date(NOW - 19 * MIN).toISOString(),
		nextRunAt: new Date(NOW + 10 * MIN).toISOString(),
		result: "success",
		exitCode: 0,
		...over,
	}
}

function status(over: {
	queuedSources?: number
	pendingTasks?: number
	pending?: number
	jobs?: SqrrlStatusJob[]
	available?: boolean
}): SqrrlStatus {
	return {
		scope: "workspace",
		scopeRef: "default",
		generatedAt: new Date(NOW).toISOString(),
		taskReview: {
			queuedSources: over.queuedSources ?? 0,
			pendingTasks: over.pendingTasks ?? 0,
			suggestions: {
				pending: over.pending ?? 0,
				accepted: 0,
				dismissed: 0,
				stale: 0,
			},
		},
		sources: [],
		host:
			over.available === false
				? { available: false, reason: "status exporter unreachable" }
				: { available: true, jobs: over.jobs ?? [job()], services: [] },
	}
}

describe("relTime", () => {
	it("formats past and future", () => {
		expect(relTime(undefined, NOW)).toBe("never")
		expect(relTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now")
		expect(relTime(new Date(NOW - 5 * MIN).toISOString(), NOW)).toBe(
			"5 min ago",
		)
		expect(relTime(new Date(NOW + 90 * MIN).toISOString(), NOW)).toBe(
			"in 1.5 h",
		)
		expect(relTime(new Date(NOW - 3 * 86400_000).toISOString(), NOW)).toBe(
			"3 days ago",
		)
	})
})

describe("jobState", () => {
	it("orders running, off, never run, failed, problem, ok", () => {
		expect(jobState(job({ running: true })).text).toBe("Running")
		expect(jobState(job({ installed: false })).text).toBe("Not installed")
		expect(jobState(job({ enabled: false })).text).toBe("Off")
		expect(jobState(job({ result: null })).text).toBe("Not run yet")
		expect(jobState(job({ result: "failed" })).tone).toBe("danger")
		expect(jobState(job({ problem: "API returned 500" })).tone).toBe("warn")
		expect(jobState(job()).tone).toBe("ok")
	})
})

describe("backlogEta", () => {
	it("is null without a backlog or with task review off", () => {
		expect(backlogEta(status({}), NOW)).toBeNull()
		expect(
			backlogEta(
				status({ queuedSources: 10, jobs: [job({ enabled: false })] }),
				NOW,
			),
		).toBeNull()
	})

	it("takes the slower of pages and tasks at the timer's pace", () => {
		// 1392 pages / 50 = 28 runs; 91 tasks / 20 = 5 runs.
		const eta = backlogEta(
			status({ queuedSources: 1392, pendingTasks: 91 }),
			NOW,
		)
		expect(eta?.runs).toBe(28)
		// First run in 10 min, then 27 more every 30 min.
		expect(eta?.finishAt).toBe(
			new Date(NOW + 10 * MIN + 27 * 30 * MIN).toISOString(),
		)
	})

	it("uses the server's per-run sizes when it reports them", () => {
		const s = status({ queuedSources: 1000, pendingTasks: 10 })
		s.taskReview.perRun = { sources: 200, tasks: 40 }
		expect(backlogEta(s, NOW)?.runs).toBe(5)
	})

	it("counts a running pass as the first", () => {
		const eta = backlogEta(
			status({ pendingTasks: 40, jobs: [job({ running: true })] }),
			NOW,
		)
		expect(eta?.runs).toBe(2)
		expect(eta?.finishAt).toBe(new Date(NOW + 30 * MIN).toISOString())
	})
})

describe("outlook", () => {
	it("is idle when nothing is queued", () => {
		const o = outlook(status({ pending: 2 }), NOW)
		expect(o.state).toBe("idle")
		expect(o.details).toContain(
			"2 close suggestions waiting for your decision.",
		)
	})

	it("is working with a backlog and says when it clears", () => {
		const o = outlook(status({ queuedSources: 100, pendingTasks: 5 }), NOW)
		expect(o.state).toBe("working")
		expect(o.details[0]).toMatch(
			/100 pages to scan, 5 tasks to check; clears in/,
		)
	})

	it("needs attention when a job failed or task review is off", () => {
		expect(
			outlook(
				status({
					jobs: [
						job(),
						job({
							id: "nextcloud_sync",
							label: "Nextcloud import",
							result: "failed",
							exitCode: 1,
						}),
					],
				}),
				NOW,
			).state,
		).toBe("attention")
		const off = outlook(
			status({ queuedSources: 3, jobs: [job({ enabled: false })] }),
			NOW,
		)
		expect(off.state).toBe("attention")
		expect(off.details).toContain(
			"Task review is switched off, so the backlog is not moving.",
		)
	})

	it("says when scheduled jobs cannot be read", () => {
		const o = outlook(status({ available: false }), NOW)
		expect(o.details).toContain(
			"Scheduled jobs unknown: status exporter unreachable.",
		)
	})
})

describe("sources", () => {
	it("labels and flags quiet sources", () => {
		expect(sourceLabel("apple-notes")).toBe("Apple Notes")
		expect(sourceLabel("git-diff")).toBe("Git diff")
		expect(sourceTone(new Date(NOW - 3600_000).toISOString(), NOW)).toBe("ok")
		expect(sourceTone(new Date(NOW - 4 * 86400_000).toISOString(), NOW)).toBe(
			"warn",
		)
	})
})
