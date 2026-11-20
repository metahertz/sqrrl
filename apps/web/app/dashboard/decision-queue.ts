"use client"

// Accept/dismiss without waiting. A click hides the item at once and queues
// the decision on the API (POST /v1/wiki/decisions, apps/api/src/lib/
// decision-queue.ts). The hook then watches the job:
//   done   -> refresh only the pages it touched and the suggestion lists, then
//             forget the item (the fresh list no longer has it);
//   failed -> show the item again and say why.
// A request that fails before it is queued (already decided, network down)
// shows the item again at once.

import type { SqrrlClient, SqrrlDecisionJob } from "@sqrrl/client"
import { useCallback, useEffect, useRef, useState } from "react"

export interface QueuedDecision {
	kind: "task-suggestion" | "identity-suggestion"
	/** The suggestion id: what is hidden while the job runs. */
	id: string
	action: "accept" | "dismiss"
	chosen?: string
	note?: string
	/** Toast text when it is done. */
	label: string
	/** Pages to refetch when it is done. */
	affects: string[]
}

export interface Pending extends QueuedDecision {
	jobId?: string
}

/** What a poll result means for the pending map: which items are settled,
 *  and which failed (to show again). Pure, for tests. */
export function settle(
	pending: Map<string, Pending>,
	jobs: SqrrlDecisionJob[],
): {
	done: Pending[]
	failed: Array<Pending & { error: string }>
} {
	const byJob = new Map(jobs.map((j) => [j.id, j]))
	const done: Pending[] = []
	const failed: Array<Pending & { error: string }> = []
	for (const p of pending.values()) {
		const j = p.jobId ? byJob.get(p.jobId) : undefined
		if (!j) continue
		if (j.status === "done") done.push(p)
		else if (j.status === "failed")
			failed.push({ ...p, error: j.error?.message ?? "the decision failed" })
	}
	return { done, failed }
}

const POLL_MS = 1_000

export function useDecisionQueue(p: {
	client: SqrrlClient
	scope: string
	scopeRef: string
	say: (text: string, error?: boolean) => void
	/** Refetches pages and the suggestion lists after jobs finish. */
	onSettled: (pages: string[]) => Promise<void>
	errorText: (err: unknown) => string
}) {
	const [pending, setPending] = useState<Map<string, Pending>>(new Map())
	const latest = useRef(p)
	latest.current = p
	const pendingRef = useRef(pending)
	pendingRef.current = pending

	const drop = useCallback((ids: string[]) => {
		setPending((m) => {
			const next = new Map(m)
			for (const id of ids) next.delete(id)
			return next
		})
	}, [])

	const decide = useCallback(
		(d: QueuedDecision) => {
			setPending((m) => new Map(m).set(d.id, d))
			const { client, scope, scopeRef } = latest.current
			client
				.queueDecision({
					scope,
					scopeRef,
					kind: d.kind,
					id: d.id,
					action: d.action,
					...(d.chosen ? { chosen: d.chosen } : {}),
					...(d.note ? { note: d.note } : {}),
				})
				.then(({ job }) =>
					setPending((m) => {
						const cur = m.get(d.id)
						return cur ? new Map(m).set(d.id, { ...cur, jobId: job.id }) : m
					}),
				)
				.catch((err) => {
					drop([d.id])
					latest.current.say(
						`${d.label} failed: ${latest.current.errorText(err)}`,
						true,
					)
				})
		},
		[drop],
	)

	// Watch queued jobs until each is done or failed.
	const watching = [...pending.values()].filter((x) => x.jobId)
	const watchKey = watching.map((x) => x.jobId).join(",")
	useEffect(() => {
		if (!watchKey) return
		let stopped = false
		const tick = async () => {
			const { client, scope, scopeRef } = latest.current
			const ids = watchKey.split(",")
			const jobs = await client
				.decisionJobs({ scope, scopeRef, ids })
				.then((r) => r.jobs)
				.catch(() => [] as SqrrlDecisionJob[])
			if (stopped) return
			const { done, failed } = settle(pendingRef.current, jobs)
			if (failed.length) {
				drop(failed.map((f) => f.id))
				for (const f of failed)
					latest.current.say(`${f.label} failed: ${f.error}`, true)
			}
			if (done.length) {
				// Clear the job id first so the next tick does not report it again;
				// the item stays hidden until the refreshed lists no longer have it.
				setPending((m) => {
					const next = new Map(m)
					for (const d of done) next.set(d.id, { ...d, jobId: undefined })
					return next
				})
				await latest.current
					.onSettled([...new Set(done.flatMap((d) => d.affects))])
					.catch(() => {})
				drop(done.map((d) => d.id))
				latest.current.say(done.map((d) => d.label).join("; "))
			}
		}
		const timer = setInterval(() => void tick(), POLL_MS)
		void tick()
		return () => {
			stopped = true
			clearInterval(timer)
		}
	}, [watchKey, drop])

	const isHidden = useCallback((id: string) => pending.has(id), [pending])
	return { decide, isHidden, pendingCount: pending.size }
}
