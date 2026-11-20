"use client"

// Activity: the background jobs and what they still have to do, so it is
// clear whether more tasks and close suggestions are on the way.
// Data: GET /v1/wiki/status (see apps/api/src/routes/status.ts).

import type { SqrrlStatus } from "@sqrrl/client"
import {
	backlogEta,
	jobState,
	outlook,
	perRun,
	relTime,
	sourceLabel,
	sourceTone,
	type Tone,
} from "./activity-data.js"
import { IconRefresh } from "./icons.js"

const TONE_VAR: Record<Tone, string> = {
	ok: "var(--ok)",
	warn: "var(--warn)",
	danger: "var(--danger)",
	accent: "var(--accent)",
	neutral: "var(--muted)",
}

const STATE_TONE = { idle: "ok", working: "accent", attention: "warn" } as const

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
	const cls =
		tone === "neutral"
			? "mdb-badge"
			: tone === "accent"
				? "mdb-badge mdb-badge-accent"
				: `mdb-badge mdb-badge-${tone}`
	return <span className={cls}>{children}</span>
}

function When({ iso, now }: { iso?: string | null; now: number }) {
	return (
		<span title={iso ? new Date(iso).toLocaleString() : undefined}>
			{relTime(iso, now)}
		</span>
	)
}

/** The Overview card: one line on whether work is still coming. */
export function ActivitySummaryCard(props: {
	status: SqrrlStatus
	onOpen: () => void
}) {
	const o = outlook(props.status)
	return (
		<div className="mdb-card mdb-activity-summary" style={{ marginBottom: 16 }}>
			<span
				className="mdb-dot"
				style={{ background: TONE_VAR[STATE_TONE[o.state]] }}
			/>
			<div className="mdb-activity-summary-text">
				<strong>{o.headline}</strong>
				{o.details.slice(0, 2).map((d) => (
					<span key={d} className="mdb-muted">
						{d}
					</span>
				))}
			</div>
			<button
				type="button"
				className="mdb-btn mdb-btn-sm"
				onClick={props.onOpen}
			>
				Activity
			</button>
		</div>
	)
}

export function ActivityView(props: {
	status: SqrrlStatus | null
	error: string | null
	loading: boolean
	onRefresh: () => void
	onOpenSuggested: () => void
}) {
	const { status, error } = props
	const now = Date.now()
	const head = (
		<div className="mdb-page-head">
			<div>
				<h1>Activity</h1>
				<p>
					Background jobs and what they still have to do
					{status ? (
						<>
							{" "}
							· updated <When iso={status.generatedAt} now={now} />
						</>
					) : null}
				</p>
			</div>
			<span className="mdb-spacer" />
			<button
				type="button"
				className="mdb-btn"
				onClick={props.onRefresh}
				disabled={props.loading}
			>
				<IconRefresh size={15} /> {props.loading ? "Refreshing…" : "Refresh"}
			</button>
		</div>
	)
	if (!status)
		return (
			<div className="mdb-page">
				{head}
				<div className="mdb-card mdb-card-pad">
					{error ? (
						<span style={{ color: "var(--danger)" }}>
							Could not load activity: {error}
						</span>
					) : (
						<span className="mdb-muted">Loading…</span>
					)}
				</div>
			</div>
		)

	const o = outlook(status, now)
	const tr = status.taskReview
	const eta = backlogEta(status, now)
	const per = perRun(status)
	const jobs = status.host.jobs ?? []
	const services = status.host.services ?? []
	const decided = tr.suggestions.accepted + tr.suggestions.dismissed

	return (
		<div className="mdb-page">
			{head}
			{error ? (
				<p style={{ color: "var(--danger)", marginTop: 0 }}>
					Refresh failed: {error}. Showing the last result.
				</p>
			) : null}
			<div
				className="mdb-card mdb-card-pad mdb-activity-outlook"
				data-state={o.state}
			>
				<span
					className="mdb-dot"
					style={{ background: TONE_VAR[STATE_TONE[o.state]] }}
				/>
				<div>
					<strong>{o.headline}</strong>
					{o.details.length ? (
						<ul>
							{o.details.map((d) => (
								<li key={d}>{d}</li>
							))}
						</ul>
					) : null}
				</div>
			</div>

			<div className="mdb-grid mdb-two" style={{ marginBottom: 16 }}>
				<div className="mdb-card">
					<div className="mdb-card-head">Task review backlog</div>
					<div className="mdb-activity-kv">
						<span>Pages waiting to be scanned for tasks</span>
						<strong>{tr.queuedSources.toLocaleString()}</strong>
						<span>Tasks waiting to be checked against new evidence</span>
						<strong>{tr.pendingTasks.toLocaleString()}</strong>
						<span>Close suggestions waiting for you</span>
						<strong>
							{tr.suggestions.pending ? (
								<button
									type="button"
									className="mdb-link-btn"
									onClick={props.onOpenSuggested}
								>
									{tr.suggestions.pending}
								</button>
							) : (
								0
							)}
						</strong>
						<span>Suggestions decided so far</span>
						<strong>
							{decided
								? `${tr.suggestions.accepted} accepted, ${tr.suggestions.dismissed} dismissed`
								: "none yet"}
						</strong>
					</div>
					<p className="mdb-activity-note mdb-muted">
						{eta
							? `At ${per.sources} pages and ${per.tasks} tasks per run, the backlog takes about ${eta.runs} more ${
									eta.runs === 1 ? "run" : "runs"
								} and clears ${relTime(eta.finishAt, now)} (${new Date(
									eta.finishAt,
								).toLocaleString(undefined, {
									weekday: "short",
									hour: "2-digit",
									minute: "2-digit",
								})}). Scanning pages can add more tasks to check.`
							: tr.queuedSources || tr.pendingTasks
								? "No task review run is scheduled, so this will not go down on its own."
								: "Nothing waiting. New pages are queued as sources are imported."}
					</p>
				</div>

				<div className="mdb-card">
					<div className="mdb-card-head">
						Sources
						<span className="mdb-sub">last item received</span>
					</div>
					{status.sources.length ? (
						<div className="mdb-activity-rows">
							{status.sources.map((s) => {
								const tone = sourceTone(s.lastReceivedAt, now)
								return (
									<div key={s.source} className="mdb-activity-row">
										<span className="mdb-activity-name">
											{sourceLabel(s.source)}
											<span className="mdb-muted">
												{s.items.toLocaleString()} items
											</span>
										</span>
										<span style={{ color: TONE_VAR[tone] }}>
											<When iso={s.lastReceivedAt} now={now} />
										</span>
										{tone === "warn" ? (
											<Badge tone="warn">quiet</Badge>
										) : (
											<span />
										)}
									</div>
								)
							})}
						</div>
					) : (
						<p className="mdb-activity-note mdb-muted">
							Nothing imported into this scope yet.
						</p>
					)}
				</div>
			</div>

			<div className="mdb-card" style={{ marginBottom: 16 }}>
				<div className="mdb-card-head">
					Scheduled jobs
					<span className="mdb-sub">on the server</span>
				</div>
				{status.host.available ? (
					<div className="mdb-jobs">
						<div className="mdb-job mdb-job-head" aria-hidden="true">
							<span>Job</span>
							<span>State</span>
							<span>Last run</span>
							<span>Next run</span>
							<span>Last result</span>
						</div>
						{jobs.map((j) => {
							const st = jobState(j)
							return (
								<div key={j.id} className="mdb-job">
									<span className="mdb-activity-name">
										{j.label}
										{j.about ? (
											<span className="mdb-muted">{j.about}</span>
										) : null}
									</span>
									<span>
										<Badge tone={st.tone}>{st.text}</Badge>
									</span>
									<span>
										<span className="mdb-job-label">Last run </span>
										{j.running ? (
											<>
												started <When iso={j.lastStartedAt} now={now} />
											</>
										) : (
											<When
												iso={j.lastFinishedAt ?? j.lastStartedAt}
												now={now}
											/>
										)}
									</span>
									<span>
										<span className="mdb-job-label">Next run </span>
										{j.enabled && j.nextRunAt ? (
											<When iso={j.nextRunAt} now={now} />
										) : (
											"—"
										)}
									</span>
									<span className="mdb-job-result">
										{j.problem ? (
											<span style={{ color: "var(--warn)" }}>{j.problem}</span>
										) : null}
										{j.problem && j.summary ? " · " : null}
										{j.summary ??
											(j.problem ? null : <span className="mdb-muted">—</span>)}
									</span>
								</div>
							)
						})}
					</div>
				) : (
					<p className="mdb-activity-note mdb-muted">
						{status.host.reason ?? "Scheduled jobs are not available."}
					</p>
				)}
			</div>

			{services.length ? (
				<div className="mdb-card">
					<div className="mdb-card-head">Services</div>
					<div className="mdb-activity-services">
						{services.map((s) => (
							<span key={s.id} className="mdb-activity-service">
								<span
									className="mdb-dot"
									style={{
										background: s.active ? "var(--ok)" : "var(--danger)",
									}}
								/>
								{s.label}
								<span className="mdb-muted">
									{s.active ? (
										<>
											up since <When iso={s.since} now={now} />
										</>
									) : (
										"down"
									)}
									{s.queue && (s.queue.queued || s.queue.running)
										? ` · ${s.queue.running ?? 0} running, ${s.queue.queued ?? 0} queued`
										: ""}
								</span>
							</span>
						))}
					</div>
				</div>
			) : null}
		</div>
	)
}
