import type { SqrrlDecisionJob } from "@sqrrl/client"
import { describe, expect, it } from "vitest"
import { type Pending, settle } from "./decision-queue.js"

const pending = (id: string, jobId?: string): Pending => ({
	kind: "task-suggestion",
	id,
	action: "accept",
	label: `Closed ${id}`,
	affects: [`tasks/${id}`],
	...(jobId ? { jobId } : {}),
})

const job = (
	id: string,
	status: SqrrlDecisionJob["status"],
	message?: string,
): SqrrlDecisionJob => ({
	id,
	kind: "task-suggestion",
	suggestionId: "x",
	action: "accept",
	status,
	createdAt: "2026-11-20T00:00:00Z",
	...(message ? { error: { code: "X", message, status: 409 } } : {}),
})

describe("settle", () => {
	it("splits finished jobs into done and failed, leaving the rest waiting", () => {
		const map = new Map([
			["a", pending("a", "j1")],
			["b", pending("b", "j2")],
			["c", pending("c", "j3")],
			["d", pending("d")],
		])
		const out = settle(map, [
			job("j1", "done"),
			job("j2", "failed", "the task is no longer open"),
			job("j3", "running"),
		])
		expect(out.done.map((p) => p.id)).toEqual(["a"])
		expect(out.failed).toEqual([
			expect.objectContaining({ id: "b", error: "the task is no longer open" }),
		])
	})

	it("gives a failure without a message a generic reason", () => {
		const out = settle(new Map([["a", pending("a", "j1")]]), [
			job("j1", "failed"),
		])
		expect(out.failed[0].error).toBe("the decision failed")
	})
})
