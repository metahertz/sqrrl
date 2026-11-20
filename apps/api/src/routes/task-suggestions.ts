// Suggested task closures: list, accept, dismiss, and the review runs that
// produce them (roadmap, "Living tasks"; logic in @sqrrl/source-layer
// task-review/).
//
//   GET  /v1/wiki/task-suggestions             list (read)
//   POST /v1/wiki/task-suggestions/:id/accept  close the task (write)
//   POST /v1/wiki/task-suggestions/:id/dismiss forget this evidence (write)
//   POST /v1/wiki/task-review/run              process the queue (write)
//   POST /v1/wiki/task-review/task             "Find evidence" for one task
//   POST /v1/wiki/task-review/sweep            the nightly pass
//
// Suggest only: no review changes a task. Accepting is an ordinary,
// revision-guarded task edit made as the caller, with a resolved_by edge to
// the evidence page, so the wiki's history shows who closed it and why.

import { type Context, Hono } from "hono"
import {
	ensureTaskReviewSchema,
	listSuggestions,
	processQueue,
	type ReviewDeps,
	reviewTask,
	type SuggestionStatus,
	sweep,
	taskReviewCounts,
} from "@sqrrl/source-layer"
import {
	createVoyageReranker,
	WikiSearchUnavailableError,
} from "@sqrrl/wiki-engine"
import type { ApiEnvironment } from "../api-context.js"
import {
	acceptTaskDecision,
	DecisionError,
	dismissTaskDecision,
} from "../lib/decisions.js"
import { jsonError } from "../lib/errors.js"
import { createTaskJudge, LlmNotConfiguredError } from "../lib/llm-generate.js"
import {
	getWikiStoreHandle,
	withWikiTransaction,
} from "../wiki-store-runtime.js"
import { readScope } from "./raw.js"
import { actorOf } from "./wiki-context.js"

const STATUSES: SuggestionStatus[] = [
	"pending",
	"accepted",
	"dismissed",
	"stale",
]

function reviewDeps(): ReviewDeps {
	const voyage = process.env.VOYAGE_API_KEY?.trim()
	const min = Number(process.env.SQRRL_TASK_REVIEW_MIN_CONFIDENCE ?? "0.7")
	return {
		judge: createTaskJudge(),
		...(voyage ? { rerank: createVoyageReranker({ apiKey: voyage }) } : {}),
		minConfidence: Number.isFinite(min) ? min : 0.7,
	}
}

class SuggestionConflict extends Error {}

async function body(c: { req: { json(): Promise<unknown> } }) {
	return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<
		string,
		unknown
	>
}

function envInt(name: string, fallback: number): number {
	const n = Number(process.env[name]?.trim() || Number.NaN)
	return Number.isInteger(n) && n > 0 ? n : fallback
}

/** What one scheduled task review run takes on, for the run route and the
 *  Activity view's backlog estimate. */
export function taskReviewPerRun(): { sources: number; tasks: number } {
	return {
		sources: Math.min(envInt("SQRRL_TASK_REVIEW_SOURCES_PER_RUN", 50), 1000),
		tasks: Math.min(envInt("SQRRL_TASK_REVIEW_TASKS_PER_RUN", 20), 200),
	}
}

export function createTaskSuggestionsRouter(): Hono<ApiEnvironment> {
	const r = new Hono<ApiEnvironment>()

	r.get("/", async (c) => {
		const scope = readScope({
			scope: c.req.query("scope"),
			scopeRef: c.req.query("scopeRef"),
		})
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const status = (c.req.query("status") ?? "pending") as SuggestionStatus
		if (!STATUSES.includes(status))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`status must be one of ${STATUSES.join("|")}`,
			)
		const handle = await getWikiStoreHandle()
		await ensureTaskReviewSchema(handle)
		const [suggestions, counts] = await Promise.all([
			listSuggestions(handle, {
				...scope,
				status,
				...(c.req.query("taskSlug")
					? { taskSlug: c.req.query("taskSlug") as string }
					: {}),
				limit: Number(c.req.query("limit") ?? "100") || 100,
			}),
			taskReviewCounts(handle, scope),
		])
		return c.json({ ...scope, status, suggestions, counts })
	})

	r.post("/:id/accept", async (c) => {
		const b = await body(c)
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		try {
			const out = await acceptTaskDecision(
				await getWikiStoreHandle(),
				withWikiTransaction as never,
				{
					...scope,
					id: c.req.param("id"),
					actor: actorOf(c, scope.scope, scope.scopeRef),
					...(typeof b.expectedRevision === "number"
						? { expectedRevision: b.expectedRevision }
						: {}),
					operationId: c.req.header("Idempotency-Key")?.trim() || undefined,
				},
			)
			return c.json(out)
		} catch (err) {
			if (err instanceof DecisionError)
				return jsonError(c, err.status, err.code, err.message)
			return jsonError(
				c,
				500,
				"SUGGESTION_ACCEPT_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	})

	r.post("/:id/dismiss", async (c) => {
		const b = await body(c)
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		try {
			return c.json(
				await dismissTaskDecision(await getWikiStoreHandle(), {
					...scope,
					id: c.req.param("id"),
					actor: actorOf(c, scope.scope, scope.scopeRef),
					...(typeof b.note === "string" ? { note: b.note } : {}),
				}),
			)
		} catch (err) {
			if (err instanceof DecisionError)
				return jsonError(c, err.status, err.code, err.message)
			throw err
		}
	})

	return r
}

export function createTaskReviewRouter(): Hono<ApiEnvironment> {
	const r = new Hono<ApiEnvironment>()

	const run = async (
		c: Context<ApiEnvironment, string>,
		fn: (
			deps: ReviewDeps,
			scope: { scope: string; scopeRef: string },
			b: Record<string, unknown>,
		) => Promise<unknown>,
	) => {
		const b = await body(c)
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		let deps: ReviewDeps
		try {
			deps = reviewDeps()
		} catch (err) {
			if (err instanceof LlmNotConfiguredError)
				return jsonError(c, 503, "LLM_NOT_CONFIGURED", err.message)
			throw err
		}
		try {
			return c.json({ ...scope, ...((await fn(deps, scope, b)) as object) })
		} catch (err) {
			if (err instanceof WikiSearchUnavailableError)
				return jsonError(
					c,
					503,
					"SEARCH_UNAVAILABLE",
					"search is currently unavailable",
				)
			return jsonError(
				c,
				500,
				"TASK_REVIEW_FAILED",
				err instanceof Error ? err.message : String(err),
			)
		}
	}
	const posInt = (v: unknown, fallback: number, max: number) =>
		typeof v === "number" && Number.isInteger(v) && v > 0
			? Math.min(v, max)
			: fallback
	const limit = (b: Record<string, unknown>, fallback: number) =>
		posInt(b.limit, fallback, 200)
	// Tasks judged side by side; the LLM gate (SQRRL_ENRICHMENT_CONCURRENCY)
	// still caps what reaches the model.
	const concurrency = () =>
		Math.min(envInt("SQRRL_TASK_REVIEW_CONCURRENCY", 4), 16)

	r.post("/run", (c) =>
		run(c, async (deps, scope, b) =>
			processQueue(await getWikiStoreHandle(), deps, {
				...scope,
				limit: limit(b, taskReviewPerRun().tasks),
				sourceLimit: posInt(b.sourceLimit, taskReviewPerRun().sources, 1000),
				concurrency: concurrency(),
			}),
		),
	)
	r.post("/sweep", (c) =>
		run(c, async (deps, scope, b) =>
			sweep(await getWikiStoreHandle(), deps, {
				...scope,
				limit: limit(
					b,
					Number(process.env.SQRRL_TASK_REVIEW_SWEEP_LIMIT ?? "40") || 40,
				),
				concurrency: concurrency(),
			}),
		),
	)
	r.post("/task", (c) =>
		run(c, async (deps, scope, b) => {
			const slug = typeof b.slug === "string" ? b.slug.trim() : ""
			if (!slug) throw new Error("slug is required")
			return {
				outcome: await reviewTask(await getWikiStoreHandle(), deps, {
					...scope,
					slug,
				}),
			}
		}),
	)
	return r
}
