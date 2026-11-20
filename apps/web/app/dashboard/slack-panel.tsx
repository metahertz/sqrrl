"use client"

// Settings → Slack: connect Slack without the command line. The steps on
// Slack's side (create the app from our manifest, install it, copy the user
// token), then a token field that is write-only like the other API keys, a
// check that reads nothing but who the token is and what it can see, and
// the import's last run. The sync job (bin/slack-sync.sh, every 30 minutes)
// skips quietly until a token is saved, then picks it up on its next run.
// Data: /v1/admin/settings (SLACK_USER_TOKEN), /v1/admin/settings/slack/*,
// and the slack_sync job in /v1/wiki/status.

import type {
	SqrrlClient,
	SqrrlSetting,
	SqrrlSlackCheck,
	SqrrlStatusJob,
} from "@sqrrl/client"
import { useCallback, useEffect, useState } from "react"
import { relTime } from "./activity-data.js"
import { errorText } from "./drawer-context.js"

const KEY = "SLACK_USER_TOKEN"

/** "3 channels, 12 DMs" from the check's counts. */
export function describeReach(c: SqrrlSlackCheck["conversations"]): string {
	if (!c) return ""
	const order = ["channel", "private channel", "group dm", "dm"]
	const parts = order
		.filter((t) => c.byType[t])
		.map((t) => {
			const n = c.byType[t]
			const word = t === "dm" ? "DM" : t === "group dm" ? "group DM" : t
			return `${n} ${word}${n === 1 ? "" : "s"}`
		})
	return `${parts.join(", ") || "no conversations"}${c.more ? " (and more)" : ""}`
}

export function SlackPanel({
	client,
	scope,
	scopeRef,
}: {
	client: SqrrlClient
	scope: string
	scopeRef: string
}) {
	const [setting, setSetting] = useState<SqrrlSetting | null>(null)
	const [job, setJob] = useState<SqrrlStatusJob | null>(null)
	const [token, setToken] = useState("")
	const [check, setCheck] = useState<SqrrlSlackCheck | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [note, setNote] = useState<string | null>(null)
	const [manifest, setManifest] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		const [s, st] = await Promise.all([
			client.settings().catch((err) => {
				setError(errorText(err))
				return null
			}),
			client.backgroundStatus({ scope, scopeRef }).catch(() => null),
		])
		if (s) setSetting(s.settings.find((x) => x.key === KEY) ?? null)
		setJob(st?.host.jobs?.find((j) => j.id === "slack_sync") ?? null)
	}, [client, scope, scopeRef])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const act = async (label: string, fn: () => Promise<void>) => {
		setBusy(label)
		setError(null)
		setNote(null)
		try {
			await fn()
		} catch (err) {
			setError(errorText(err))
		} finally {
			setBusy(null)
		}
	}

	const runCheck = () =>
		act("check", async () => {
			setCheck(
				await client.testSlack(token.trim() ? { token: token.trim() } : {}),
			)
		})

	const save = () =>
		act("save", async () => {
			await client.updateSettings({ [KEY]: token.trim() })
			setToken("")
			setNote("Saved. The import starts on its next run (within 30 minutes).")
			await refresh()
		})

	const remove = () =>
		act("remove", async () => {
			await client.updateSettings({ [KEY]: null })
			setCheck(null)
			setNote("Token removed. The import stops on its next run.")
			await refresh()
		})

	const copyManifest = () =>
		act("manifest", async () => {
			const text =
				manifest ?? JSON.stringify(await client.slackManifest(), null, 2)
			setManifest(text)
			try {
				await navigator.clipboard.writeText(text)
				setNote("Manifest copied. Paste it into Slack (step 1).")
			} catch {
				setNote("Copy it from the box below.")
			}
		})

	const connected = Boolean(setting?.isSet)
	return (
		<div className="mdb-card-pad mdb-slack">
			<div className="mdb-slack-status">
				<span
					className="mdb-dot"
					style={{ background: connected ? "var(--ok)" : "var(--muted)" }}
				/>
				<strong>{connected ? "Token saved" : "Not connected"}</strong>
				{job ? (
					<span className="mdb-muted">
						{job.enabled ? "Import every 30 minutes" : "Import job is off"}
						{job.lastFinishedAt
							? ` · last run ${relTime(job.lastFinishedAt)}`
							: ""}
						{job.summary ? ` · ${job.summary}` : ""}
					</span>
				) : null}
			</div>

			<ol className="mdb-slack-steps">
				<li>
					Open{" "}
					<a
						className="mdb-link"
						href="https://api.slack.com/apps?new_app=1"
						target="_blank"
						rel="noreferrer"
					>
						api.slack.com/apps
					</a>{" "}
					→ <em>Create New App</em> → <em>From a manifest</em> → your workspace,
					and paste our manifest.{" "}
					<button
						type="button"
						className="mdb-btn mdb-btn-sm"
						disabled={busy !== null}
						onClick={() => void copyManifest()}
					>
						Copy manifest
					</button>
					<span className="mdb-muted mdb-slack-hint">
						Read-only: channels, private channels, DMs and group DMs, plus
						people’s names and emails. Nothing can be posted.
					</span>
				</li>
				<li>
					<em>Install to Workspace</em>. If your org requires approval, request
					it there and come back when it is approved.
				</li>
				<li>
					<em>OAuth &amp; Permissions</em> → copy the{" "}
					<strong>User OAuth Token</strong> (starts <code>xoxp-</code>; a bot
					token cannot read your DMs) and paste it below.
				</li>
				<li>
					<em>Check</em>, then <em>Save</em>. The first import reads the last 30
					days of every conversation the token can see; after that, every 30
					minutes.
				</li>
			</ol>

			{manifest ? (
				<textarea
					className="mdb-input mdb-slack-manifest"
					readOnly
					value={manifest}
					onFocus={(e) => e.currentTarget.select()}
				/>
			) : null}

			<div className="mdb-slack-token">
				<input
					className="mdb-input"
					type="password"
					autoComplete="off"
					placeholder={
						connected ? "Saved (paste a new token to replace it)" : "xoxp-…"
					}
					value={token}
					onChange={(e) => {
						setToken(e.target.value)
						setCheck(null)
					}}
				/>
				<button
					type="button"
					className="mdb-btn"
					disabled={busy !== null || (!token.trim() && !connected)}
					onClick={() => void runCheck()}
					title={
						token.trim() ? "Check the pasted token" : "Check the saved token"
					}
				>
					{busy === "check" ? "Checking…" : "Check"}
				</button>
				<button
					type="button"
					className="mdb-btn mdb-btn-primary"
					disabled={busy !== null || !token.trim()}
					onClick={() => void save()}
				>
					{busy === "save" ? "Saving…" : "Save"}
				</button>
				{connected ? (
					<button
						type="button"
						className="mdb-btn mdb-btn-ghost"
						disabled={busy !== null}
						onClick={() => void remove()}
					>
						Remove
					</button>
				) : null}
			</div>

			{check ? (
				<div
					className={`mdb-slack-check ${check.ok ? "is-ok" : "is-bad"}`}
					role="status"
				>
					{check.team ? (
						<span>
							{check.ok ? "✓ " : ""}
							<strong>{check.user}</strong> in <strong>{check.team}</strong>
							{check.conversations
								? ` · can read ${describeReach(check.conversations)}`
								: ""}
						</span>
					) : null}
					{check.error ? <span>{check.error}</span> : null}
				</div>
			) : null}
			{error ? (
				<p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>
			) : null}
			{note ? (
				<p className="mdb-muted" style={{ margin: 0 }}>
					{note}
				</p>
			) : null}
		</div>
	)
}
