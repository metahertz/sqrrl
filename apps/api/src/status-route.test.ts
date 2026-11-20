import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { hostStatus } from "./routes/status.js"
import { WIKI_RESERVED_SLUG_SEGMENTS } from "./routes/v1.js"

let server: Server
let base = ""

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === "/status.json") {
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify({
					generatedAt: "2026-11-18T16:00:00Z",
					jobs: [{ id: "task_review", label: "Task review" }],
					services: [{ id: "sqrrl-api", label: "API", active: true }],
				}),
			)
		} else if (req.url === "/odd.json") {
			res.end(JSON.stringify({ jobs: "nope" }))
		} else {
			res.statusCode = 500
			res.end("boom")
		}
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe("hostStatus", () => {
	it("explains when no status URL is configured", async () => {
		const s = await hostStatus("")
		expect(s.available).toBe(false)
		expect(s.reason).toMatch(/SQRRL_STATUS_URL/)
	})

	it("passes the exporter's jobs and services through", async () => {
		const s = await hostStatus(`${base}/status.json`)
		expect(s).toEqual({
			available: true,
			generatedAt: "2026-11-18T16:00:00Z",
			jobs: [{ id: "task_review", label: "Task review" }],
			services: [{ id: "sqrrl-api", label: "API", active: true }],
		})
	})

	it("drops malformed lists", async () => {
		const s = await hostStatus(`${base}/odd.json`)
		expect(s).toEqual({ available: true, jobs: [], services: [] })
	})

	it("reports an error status or an unreachable exporter", async () => {
		expect(await hostStatus(`${base}/missing`)).toEqual({
			available: false,
			reason: "status exporter returned 500",
		})
		const down = await hostStatus("http://127.0.0.1:9/status.json")
		expect(down.available).toBe(false)
		expect(down.reason).toMatch(/^status exporter unreachable/)
	})
})

describe("routing", () => {
	it("reserves the status slug so a page cannot shadow the route", () => {
		expect(WIKI_RESERVED_SLUG_SEGMENTS).toContain("status")
	})
})

describe("taskReviewPerRun", () => {
	it("reads the per-run sizes from env, with defaults and caps", async () => {
		const { taskReviewPerRun } = await import("./routes/task-suggestions.js")
		const keep = { ...process.env }
		try {
			delete process.env.SQRRL_TASK_REVIEW_SOURCES_PER_RUN
			delete process.env.SQRRL_TASK_REVIEW_TASKS_PER_RUN
			expect(taskReviewPerRun()).toEqual({ sources: 50, tasks: 20 })
			process.env.SQRRL_TASK_REVIEW_SOURCES_PER_RUN = "200"
			process.env.SQRRL_TASK_REVIEW_TASKS_PER_RUN = "999"
			expect(taskReviewPerRun()).toEqual({ sources: 200, tasks: 200 })
			process.env.SQRRL_TASK_REVIEW_TASKS_PER_RUN = "nope"
			expect(taskReviewPerRun().tasks).toBe(20)
		} finally {
			process.env = keep
		}
	})
})
