// Queued decisions from the console (lib/decision-queue.ts).
//
//   POST /v1/wiki/decisions {scope, scopeRef, kind, id, action, chosen?,
//        note?, expectedRevision?}   -> 202 {job}   (write)
//   GET  /v1/wiki/decisions?scope=&scopeRef=&ids=a,b -> {jobs}   (read)
//
// kind is "task-suggestion" or "identity-suggestion"; action "accept" or
// "dismiss". What can be checked at once (the suggestion exists and is still
// pending, a choice is one of the candidates) fails here with the same codes
// as the direct routes; the rest is reported on the job.

import { Hono } from "hono"
import type { ApiEnvironment } from "../api-context.js"
import {
	type DecisionAction,
	type DecisionKind,
	enqueueDecision,
	getDecisionJobs,
	startDecisionWorker,
} from "../lib/decision-queue.js"
import { DecisionError } from "../lib/decisions.js"
import { jsonError } from "../lib/errors.js"
import {
	getWikiStoreHandle,
	withWikiTransaction,
} from "../wiki-store-runtime.js"
import { readScope } from "./raw.js"
import { actorOf } from "./wiki-context.js"

const KINDS: DecisionKind[] = ["task-suggestion", "identity-suggestion"]
const ACTIONS: DecisionAction[] = ["accept", "dismiss"]

/** Starts the worker with the live store (idempotent). */
export async function ensureDecisionWorker() {
	const handle = await getWikiStoreHandle()
	await startDecisionWorker(handle, withWikiTransaction as never)
	return handle
}

export function createDecisionsRouter(): Hono<ApiEnvironment> {
	const r = new Hono<ApiEnvironment>()

	r.post("/", async (c) => {
		const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<
			string,
			unknown
		>
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const kind = b.kind as DecisionKind
		const action = b.action as DecisionAction
		const id = typeof b.id === "string" ? b.id.trim() : ""
		if (!KINDS.includes(kind))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`kind must be one of ${KINDS.join("|")}`,
			)
		if (!ACTIONS.includes(action))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`action must be one of ${ACTIONS.join("|")}`,
			)
		if (!id) return jsonError(c, 400, "VALIDATION_ERROR", "id is required")
		try {
			const handle = await ensureDecisionWorker()
			const { job, existing } = await enqueueDecision(
				handle,
				{
					...scope,
					kind,
					action,
					suggestionId: id,
					...(typeof b.chosen === "string" && b.chosen.trim()
						? { chosen: b.chosen.trim() }
						: {}),
					...(typeof b.note === "string" && b.note.trim()
						? { note: b.note.trim().slice(0, 500) }
						: {}),
					...(typeof b.expectedRevision === "number"
						? { expectedRevision: b.expectedRevision }
						: {}),
				},
				actorOf(c, scope.scope, scope.scopeRef),
			)
			return c.json({ job, existing }, 202)
		} catch (err) {
			if (err instanceof DecisionError)
				return jsonError(c, err.status, err.code, err.message)
			throw err
		}
	})

	r.get("/", async (c) => {
		const scope = readScope({
			scope: c.req.query("scope"),
			scopeRef: c.req.query("scopeRef"),
		})
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const ids = (c.req.query("ids") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.slice(0, 100)
		const handle = await ensureDecisionWorker()
		return c.json({
			...scope,
			jobs: await getDecisionJobs(handle, { ...scope, ids }),
		})
	})

	return r
}
