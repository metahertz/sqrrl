// Suggesting that open tasks be closed (see roadmap, "Living tasks").
//
// Every path ends in reviewTask: one task, its evidence, one judge call,
// at most one suggestion. What differs is how a task gets reviewed:
//   - processQueue: pages distilled since the last run are expanded into
//     the tasks they might close, which are then reviewed with the page as
//     a hint (timely, driven by new input);
//   - sweep: open tasks not reviewed for a week, overdue first (catches
//     evidence that arrived without naming the task's source);
//   - the API's "Find evidence": one task, now.
// Nothing here changes a task; suggestions wait for the user.

import {
	getWikiPage,
	type WikiDbHandle,
	type WikiPageView,
} from "@sqrrl/wiki-engine"
import type { searchRawItems } from "../raw-items.js"
import { gatherEvidence, isOpenTask, tasksForSourcePage } from "./candidates.js"
import {
	buildJudgePrompt,
	parseJudgeReply,
	TASK_JUDGE_PROMPT,
} from "./judge.js"
import {
	clearSourceQueueEntry,
	ensureTaskReviewSchema,
	finishReview,
	getReviewState,
	markSuggestionsStale,
	markTasksForReview,
	recordSuggestion,
	takePendingReviews,
	takeSourceQueue,
	type TaskSuggestion,
	tasksDueForSweep,
} from "./store.js"

export type TaskJudgeFn = (system: string, user: string) => Promise<unknown>

export interface ReviewDeps {
	judge: TaskJudgeFn
	rerank?: Parameters<typeof searchRawItems>[1]["rerank"]
	/** Default 0.7 (SQRRL_TASK_REVIEW_MIN_CONFIDENCE). */
	minConfidence?: number
	now?: () => Date
}

type Scope = { scope: string; scopeRef: string }

export type ReviewOutcome =
	| { slug: string; result: "suggested"; suggestion: TaskSuggestion }
	| {
			slug: string
			result: "no-evidence" | "no-verdict" | "not-open" | "dismissed-evidence"
	  }

export async function reviewTask(
	handle: WikiDbHandle,
	deps: ReviewDeps,
	p: Scope & { slug: string; hints?: string[] },
): Promise<ReviewOutcome> {
	await ensureTaskReviewSchema(handle)
	const task = (await getWikiPage(handle, p.slug, p.scope, p.scopeRef)) as
		| WikiPageView
		| undefined
	if (!task || !isOpenTask(task)) {
		await markSuggestionsStale(handle, { ...p, taskSlug: p.slug })
		return { slug: p.slug, result: "not-open" }
	}
	const state = await getReviewState(handle, { ...p, taskSlug: p.slug })
	const evidence = await gatherEvidence(handle, task, {
		...p,
		hints: [...new Set([...(p.hints ?? []), ...(state?.hints ?? [])])],
		dismissed: state?.dismissed,
		...(state?.dismissedAt ? { notBefore: new Date(state.dismissedAt) } : {}),
		rerank: deps.rerank,
	})
	if (!evidence.length) return { slug: p.slug, result: "no-evidence" }
	const card = task.taskCard as { owner?: string; dueDate?: string } | null
	const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
	const reply = await deps.judge(
		TASK_JUDGE_PROMPT,
		buildJudgePrompt(
			{
				title: task.title,
				...(card?.owner ? { owner: card.owner } : {}),
				...(task.createdAt ? { createdAt: String(task.createdAt) } : {}),
				...(card?.dueDate ? { dueDate: card.dueDate } : {}),
				...(task.body?.trim()
					? { context: task.body.trim().slice(0, 400) }
					: {}),
			},
			evidence,
			today,
		),
	)
	const verdict = parseJudgeReply(reply, evidence, deps.minConfidence ?? 0.7)
	if (!verdict) return { slug: p.slug, result: "no-verdict" }
	const suggestion = await recordSuggestion(handle, {
		...p,
		taskSlug: task.slug,
		taskTitle: task.title,
		...verdict,
		dismissed: state?.dismissed,
	})
	return suggestion
		? { slug: p.slug, result: "suggested", suggestion }
		: { slug: p.slug, result: "dismissed-evidence" }
}

export interface RunSummary {
	sourcesExpanded: number
	tasksMarked: number
	reviewed: number
	suggested: number
	errors: string[]
}

/** Expands up to `sourceLimit` queued source pages (default 50) into tasks
 *  to review, then reviews up to `limit` pending tasks (default 20),
 *  `concurrency` at a time (default 1; the LLM gate still caps the calls in
 *  flight). Bounded per run; the rest wait for the next. */
export async function processQueue(
	handle: WikiDbHandle,
	deps: ReviewDeps,
	p: Scope & { limit?: number; sourceLimit?: number; concurrency?: number },
): Promise<RunSummary> {
	await ensureTaskReviewSchema(handle)
	const out: RunSummary = {
		sourcesExpanded: 0,
		tasksMarked: 0,
		reviewed: 0,
		suggested: 0,
		errors: [],
	}
	const scope = { scope: p.scope, scopeRef: p.scopeRef }
	for (const entry of await takeSourceQueue(handle, {
		...scope,
		limit: p.sourceLimit ?? 50,
	})) {
		try {
			const tasks = await tasksForSourcePage(handle, {
				...p,
				slug: entry.sourceSlug,
			})
			if (tasks.length)
				await markTasksForReview(handle, {
					...p,
					taskSlugs: tasks,
					reason: "evidence",
					hint: entry.sourceSlug,
				})
			out.tasksMarked += tasks.length
			out.sourcesExpanded++
			await clearSourceQueueEntry(handle, entry._id, entry.enqueuedAt)
		} catch (err) {
			// Left queued: a search outage now is a retry next run.
			out.errors.push(
				`${entry.sourceSlug}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	const states = await takePendingReviews(handle, {
		...scope,
		limit: p.limit ?? 20,
	})
	const reviewOne = async (state: (typeof states)[number]) => {
		try {
			const outcome = await reviewTask(handle, deps, {
				...scope,
				slug: state.taskSlug,
			})
			out.reviewed++
			if (outcome.result === "suggested") out.suggested++
			await finishReview(handle, state._id)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			out.errors.push(`${state.taskSlug}: ${message}`)
			await finishReview(handle, state._id, message, state.attempts ?? 0)
		}
	}
	// A few workers pull from one list, so a slow task never holds up more
	// than its own slot.
	let next = 0
	const workers = Math.max(1, Math.min(p.concurrency ?? 1, states.length))
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < states.length) await reviewOne(states[next++])
		}),
	)
	return out
}

/** Marks open tasks not reviewed for `staleDays` (overdue first), then
 *  processes the queue. */
export async function sweep(
	handle: WikiDbHandle,
	deps: ReviewDeps,
	p: Scope & { limit?: number; staleDays?: number; concurrency?: number },
): Promise<RunSummary & { swept: number }> {
	await ensureTaskReviewSchema(handle)
	const now = deps.now?.() ?? new Date()
	const limit = p.limit ?? 40
	const slugs = await tasksDueForSweep(handle, {
		...p,
		limit,
		staleDays: p.staleDays ?? 7,
		now,
		today: now.toISOString().slice(0, 10),
	})
	if (slugs.length)
		await markTasksForReview(handle, {
			...p,
			taskSlugs: slugs,
			reason: "sweep",
		})
	const run = await processQueue(handle, deps, { ...p, limit })
	return { ...run, swept: slugs.length }
}
