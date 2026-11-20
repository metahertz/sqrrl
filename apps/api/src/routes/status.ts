// Background work at a glance, for the console's Activity view.
//
//   GET /v1/wiki/status?scope=&scopeRef=   (read)
//
// Answers "is anything still coming?": the task review backlog (pages waiting
// to be expanded into tasks, tasks waiting to be judged, suggestions waiting
// for a decision), when each source last delivered something, and - when
// SQRRL_STATUS_URL points at the host's status exporter - each scheduled
// job's last run, result and next run. The host part is optional: without it
// the scoped numbers still come back, with host.available false.

import { Hono } from "hono"
import {
	ensureTaskReviewSchema,
	rawSourceActivity,
	taskReviewCounts,
} from "@sqrrl/source-layer"
import type { ApiEnvironment } from "../api-context.js"
import { jsonError } from "../lib/errors.js"
import { getWikiStoreHandle } from "../wiki-store-runtime.js"
import { readScope } from "./raw.js"
import { taskReviewPerRun } from "./task-suggestions.js"

const HOST_TIMEOUT_MS = 5_000

export interface HostStatus {
	available: boolean
	reason?: string
	generatedAt?: string
	jobs?: unknown[]
	services?: unknown[]
}

/** The host exporter's /status.json, or why it could not be read. */
export async function hostStatus(
	url = process.env.SQRRL_STATUS_URL?.trim(),
): Promise<HostStatus> {
	if (!url)
		return {
			available: false,
			reason: "SQRRL_STATUS_URL is not set, so scheduled jobs are not shown",
		}
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
		})
		if (!res.ok)
			return {
				available: false,
				reason: `status exporter returned ${res.status}`,
			}
		const body = (await res.json()) as {
			generatedAt?: string
			jobs?: unknown[]
			services?: unknown[]
		}
		return {
			available: true,
			...(body.generatedAt ? { generatedAt: body.generatedAt } : {}),
			jobs: Array.isArray(body.jobs) ? body.jobs : [],
			services: Array.isArray(body.services) ? body.services : [],
		}
	} catch (err) {
		// fetch() wraps the reason (ECONNREFUSED, a timeout) in err.cause.
		const e = err as {
			code?: string
			name?: string
			cause?: { code?: string; message?: string }
		}
		const cause =
			e.cause?.code ||
			e.cause?.message ||
			e.code ||
			(e.name === "TimeoutError" ? "timed out" : undefined)
		return {
			available: false,
			reason: `status exporter unreachable${cause ? ` (${cause})` : ""}`,
		}
	}
}

export function createStatusRouter(): Hono<ApiEnvironment> {
	const r = new Hono<ApiEnvironment>()
	r.get("/", async (c) => {
		const scope = readScope({
			scope: c.req.query("scope"),
			scopeRef: c.req.query("scopeRef"),
		})
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const handle = await getWikiStoreHandle()
		await ensureTaskReviewSchema(handle)
		const [taskReview, sources, host] = await Promise.all([
			taskReviewCounts(handle, scope),
			rawSourceActivity(handle, scope),
			hostStatus(),
		])
		return c.json({
			...scope,
			generatedAt: new Date().toISOString(),
			taskReview: { ...taskReview, perRun: taskReviewPerRun() },
			sources,
			host,
		})
	})
	return r
}
