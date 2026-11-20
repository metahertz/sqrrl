// Deciding a suggestion: the work behind the accept/dismiss routes and the
// decision queue (lib/decision-queue.ts), without a request context. The
// caller passes who is deciding (an Actor) instead; a queued job stores the
// same Actor, so a decision made later carries the identity and governance
// of whoever clicked.
//
// Failures are DecisionErrors with the HTTP status and code the routes
// return, so the routes and the queue report them the same way.

import { randomUUID } from "node:crypto"
import {
	acceptIdentitySuggestion,
	decideSuggestion,
	dismissIdentitySuggestion,
	getSuggestion,
	IdentityDecisionError,
	isOpenTask,
	markSuggestionsStale,
	type TaskSuggestion,
} from "@sqrrl/source-layer"
import {
	addRelationships,
	type GovernanceContext,
	getWikiPage,
	recordWikiMutationIntent,
	updateWikiPage,
	type WikiDbHandle,
	type WikiPageInput,
	WikiRevisionConflictError,
} from "@sqrrl/wiki-engine"

export interface Actor {
	subjectId: string
	displayName?: string
	governance: Omit<GovernanceContext, "scope" | "scopeRef">
}

export class DecisionError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 500,
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

type Scope = { scope: string; scopeRef: string }
type Tx = <T>(
	op: (h: WikiDbHandle, session: unknown) => Promise<T>,
) => Promise<T>

/** A pending task suggestion in this scope, or a DecisionError. */
export async function pendingTaskSuggestion(
	handle: WikiDbHandle,
	p: Scope & { id: string },
): Promise<TaskSuggestion> {
	const s = await getSuggestion(handle, p.id)
	if (!s || s.scope !== p.scope || s.scopeRef !== p.scopeRef)
		throw new DecisionError(
			404,
			"SUGGESTION_NOT_FOUND",
			"no such suggestion in this scope",
		)
	if (s.status !== "pending")
		throw new DecisionError(
			409,
			"SUGGESTION_DECIDED",
			`suggestion is already ${s.status}`,
		)
	return s
}

/** Closes the task as suggested (done with completedAt from the evidence,
 *  or dropped), links it to the evidence pages, and records the decision. */
export async function acceptTaskDecision(
	handle: WikiDbHandle,
	tx: Tx,
	p: Scope & {
		id: string
		actor: Actor
		expectedRevision?: number
		operationId?: string
	},
): Promise<{ suggestion: TaskSuggestion; task: unknown }> {
	const s = await pendingTaskSuggestion(handle, p)
	const latest = s.evidence
		.map((e) => e.occurredAt)
		.filter(
			(d): d is string => Boolean(d) && !Number.isNaN(Date.parse(d as string)),
		)
		.sort()
		.at(-1)
	const governance = {
		...p.actor.governance,
		scope: s.scope,
		scopeRef: s.scopeRef,
	}
	let updated: unknown
	try {
		updated = await tx(async (h, session) => {
			const page = await getWikiPage(
				h,
				s.taskSlug,
				s.scope,
				s.scopeRef,
				governance as GovernanceContext,
				session as never,
			)
			if (!page) return undefined
			if (!isOpenTask(page))
				throw new DecisionError(
					409,
					"TASK_NOT_OPEN",
					"the task is no longer open",
				)
			if (
				typeof p.expectedRevision === "number" &&
				page.revision !== p.expectedRevision
			)
				throw new WikiRevisionConflictError(
					s.taskSlug,
					s.scope,
					s.scopeRef,
					p.expectedRevision,
				)
			const card = page.taskCard as Record<string, unknown>
			const patch = {
				taskCard: {
					...card,
					status: s.proposed,
					// Done when the evidence says so, not when it was accepted.
					completedAt:
						s.proposed === "done"
							? new Date(latest ?? Date.now()).toISOString()
							: null,
				},
			} as Partial<WikiPageInput>
			const result = await updateWikiPage(
				h,
				s.taskSlug,
				s.scope,
				s.scopeRef,
				patch,
				{
					session: session as never,
					editor: {
						id: p.actor.subjectId,
						name: p.actor.displayName?.trim() || p.actor.subjectId,
					},
				},
			)
			await recordWikiMutationIntent(
				h,
				{
					operationId: p.operationId || randomUUID(),
					kind: "update",
					pageSlug: s.taskSlug,
					scope: s.scope,
					scopeRef: s.scopeRef,
					principalSubjectId: p.actor.subjectId,
					payload: { ...patch, taskSuggestion: s.id },
				},
				session as never,
			)
			return result
		})
	} catch (err) {
		if (err instanceof DecisionError && err.code === "TASK_NOT_OPEN")
			await markSuggestionsStale(handle, {
				scope: s.scope,
				scopeRef: s.scopeRef,
				taskSlug: s.taskSlug,
			})
		if (err instanceof WikiRevisionConflictError)
			throw new DecisionError(409, "REVISION_CONFLICT", err.message)
		throw err
	}
	if (!updated) {
		await markSuggestionsStale(handle, {
			scope: s.scope,
			scopeRef: s.scopeRef,
			taskSlug: s.taskSlug,
		})
		throw new DecisionError(
			404,
			"WIKI_NOT_FOUND",
			`task "${s.taskSlug}" no longer exists`,
		)
	}
	const pages = s.evidence.filter((e) => e.kind === "page" && e.slug)
	if (pages.length)
		await addRelationships(
			handle,
			s.taskSlug,
			s.scope,
			s.scopeRef,
			pages.map((e) => ({
				targetPageSlug: e.slug as string,
				targetTitle: e.title,
				kind: "resolved_by",
				weight: 1,
				confidence: s.confidence,
			})),
		)
	await decideSuggestion(handle, s, {
		status: "accepted",
		by: p.actor.subjectId,
	})
	return { suggestion: { ...s, status: "accepted" }, task: updated }
}

export async function dismissTaskDecision(
	handle: WikiDbHandle,
	p: Scope & { id: string; actor: Actor; note?: string },
): Promise<{ suggestion: TaskSuggestion }> {
	const s = await pendingTaskSuggestion(handle, p)
	await decideSuggestion(handle, s, {
		status: "dismissed",
		by: p.actor.subjectId,
		...(p.note?.trim() ? { note: p.note.trim().slice(0, 500) } : {}),
	})
	return { suggestion: { ...s, status: "dismissed" } }
}

const IDENTITY_STATUS = {
	NOT_FOUND: 404,
	NOT_PENDING: 409,
	BAD_CHOICE: 400,
	GONE: 409,
} as const

/** Accepts (chosen) or dismisses (no chosen) a same-person question. */
export async function identityDecision(
	handle: WikiDbHandle,
	p: Scope & { id: string; actor: Actor; chosen?: string },
): Promise<unknown> {
	const editor = { subjectId: p.actor.subjectId }
	try {
		if (p.chosen)
			return {
				suggestion: await acceptIdentitySuggestion(handle, {
					scope: p.scope,
					scopeRef: p.scopeRef,
					id: p.id,
					chosen: p.chosen,
					editor,
				}),
			}
		await dismissIdentitySuggestion(handle, {
			scope: p.scope,
			scopeRef: p.scopeRef,
			id: p.id,
			editor,
		})
		return { dismissed: true }
	} catch (err) {
		if (err instanceof IdentityDecisionError)
			throw new DecisionError(
				IDENTITY_STATUS[err.code],
				`IDENTITY_${err.code}`,
				err.message,
			)
		throw err
	}
}
