"use client"

import type { SqrrlClient } from "@sqrrl/client"
import { ApiKeysPanel } from "./api-keys-panel.js"
import { EndpointSettingsPanel } from "./endpoint-settings-panel.js"
import { SelfIdentityPanel } from "./self-identity-panel.js"
import { SlackPanel } from "./slack-panel.js"
import type { WikiPage } from "./shared.js"

const SCRIPTS = [
	["sqrrl-notes-sync.sh", "notes sync"],
	["sqrrl-notes-export.js", "notes export"],
	["sqrrl-calendar-sync.sh", "calendar sync"],
	["sqrrl-calendar-export.swift", "calendar export"],
	["sqrrl-mail-sync.sh", "mail sync"],
	["sqrrl-mail-export.js", "mail export"],
	["sqrrl-schedule.sh", "scheduler"],
	["README.md", "README"],
] as const

export function SettingsView({
	client,
	apiBase,
	isMaster,
	ready,
	readyError,
	theme,
	onTheme,
	scope,
	scopeRef,
	pages,
	onIdentitySaved,
}: {
	scope: string
	scopeRef: string
	pages: WikiPage[]
	onIdentitySaved: () => void
	client: SqrrlClient
	apiBase: string
	isMaster: boolean | null
	ready: Record<string, unknown> | null
	readyError: string | null
	theme: "system" | "light" | "dark"
	onTheme: (t: "system" | "light" | "dark") => void
}) {
	const wiki = (ready?.wiki ?? {}) as {
		transactional?: boolean
		search?: boolean
	}
	const raw = (ready?.raw ?? {}) as { search?: boolean }
	return (
		<div className="mdb-page">
			<div className="mdb-page-head">
				<div>
					<h1>Settings</h1>
					<p>
						You, Slack, connection, appearance, importers, vision, transcription
						and API keys.
					</p>
				</div>
			</div>
			<SelfIdentityPanel
				client={client}
				scope={scope}
				scopeRef={scopeRef}
				pages={pages}
				onSaved={onIdentitySaved}
			/>
			<div className="mdb-grid mdb-two" style={{ marginBottom: 14 }}>
				<div className="mdb-card">
					<div className="mdb-card-head">Connection</div>
					<dl className="mdb-kv mdb-card-pad">
						<dt>API</dt>
						<dd className="mdb-slug" style={{ fontSize: 12.5 }}>
							{apiBase}
						</dd>
						<dt>Status</dt>
						<dd>
							{readyError ? (
								<span className="mdb-badge mdb-badge-danger">
									not ready: {readyError}
								</span>
							) : ready ? (
								<span className="mdb-chips">
									<span
										className={`mdb-badge ${wiki.transactional ? "mdb-badge-ok" : "mdb-badge-warn"}`}
									>
										wiki
									</span>
									<span
										className={`mdb-badge ${wiki.search ? "mdb-badge-ok" : "mdb-badge-warn"}`}
									>
										search
									</span>
									<span
										className={`mdb-badge ${raw.search ? "mdb-badge-ok" : "mdb-badge-warn"}`}
									>
										raw search
									</span>
								</span>
							) : (
								<span className="mdb-muted">checking…</span>
							)}
						</dd>
						<dt>Key</dt>
						<dd>
							{isMaster === null ? "—" : isMaster ? "master key" : "scoped key"}
						</dd>
					</dl>
				</div>
				<div className="mdb-card">
					<div className="mdb-card-head">Appearance</div>
					<div className="mdb-card-pad">
						<div className="mdb-chips">
							{(["system", "light", "dark"] as const).map((t) => (
								<button
									key={t}
									type="button"
									className="mdb-chip"
									aria-pressed={theme === t}
									onClick={() => onTheme(t)}
								>
									{t[0].toUpperCase() + t.slice(1)}
								</button>
							))}
						</div>
						<p
							className="mdb-muted"
							style={{ fontSize: 12.5, marginBottom: 0 }}
						>
							Stored in this browser only.
						</p>
					</div>
				</div>
			</div>

			<div className="mdb-card" style={{ marginBottom: 14 }}>
				<div className="mdb-card-head">
					Mac importer
					<span className="mdb-sub">Apple Notes, Calendar and Mail</span>
				</div>
				<div className="mdb-card-pad">
					<p style={{ marginTop: 0, maxWidth: "70ch", color: "var(--label)" }}>
						Runs on your Mac. Notes become pages with their claims and a task
						per action item; calendar events become meetings linked to the
						people in them and to their transcripts. Notes written on an iPhone
						come through once iCloud has synced them.
					</p>
					<div className="mdb-toolbar">
						<a
							className="mdb-btn mdb-btn-primary"
							href="/downloads/apple-notes"
							style={{ textDecoration: "none" }}
						>
							Download (.tar.gz)
						</a>
						{/* Scripts that will be given control of Notes and Calendar:
						    reading them first is reasonable, so the sources are linked. */}
						{SCRIPTS.map(([file, label]) => (
							<a
								key={file}
								className="mdb-link"
								style={{ fontSize: 13 }}
								href={`/apple-notes/${file}`}
							>
								{label}
							</a>
						))}
					</div>
					<pre className="mdb-prose" style={{ margin: 0 }}>
						<code>
							{[
								"tar xzf ~/Downloads/sqrrl-apple-notes.tar.gz && cd sqrrl-apple-notes",
								`export SQRRL_API_URL=${apiBase}`,
								"export SQRRL_API_KEY=...            # a scoped key with write access",
								"",
								"./sqrrl-notes-sync.sh --dry-run     # nothing is sent",
								"./sqrrl-notes-sync.sh --all         # first real run",
								"./sqrrl-calendar-sync.sh --all      # a year of meetings",
								"./sqrrl-mail-sync.sh --all          # 30 days of Inbox + Sent",
								"",
								"./sqrrl-schedule.sh notes install      # hourly",
								"./sqrrl-schedule.sh calendar install   # hourly",
								"./sqrrl-schedule.sh mail install       # hourly",
							].join("\n")}
						</code>
					</pre>
					<p className="mdb-muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
						Run the notes sync from Terminal once first: macOS asks whether
						Terminal may control Notes, and a scheduled job cannot show that
						prompt.
					</p>
				</div>
			</div>

			{isMaster ? (
				<div className="mdb-card" style={{ marginBottom: 14 }}>
					<div className="mdb-card-head">
						Slack
						<span className="mdb-sub">channels, DMs and group DMs</span>
					</div>
					<SlackPanel client={client} scope={scope} scopeRef={scopeRef} />
				</div>
			) : (
				<div className="mdb-card mdb-card-pad" style={{ marginBottom: 14 }}>
					<strong>Slack</strong>
					<p className="mdb-muted" style={{ marginBottom: 0 }}>
						Connecting Slack needs the master key: sign in with it to see the
						steps and save a token.
					</p>
				</div>
			)}

			{isMaster ? (
				<div className="mdb-grid mdb-two" style={{ marginBottom: 14 }}>
					<div className="mdb-card">
						<div className="mdb-card-head">
							Language model
							<span className="mdb-sub">distilling, answers, task review</span>
						</div>
						<div className="mdb-card-pad">
							<EndpointSettingsPanel
								client={client}
								group="llm"
								intro="Turns sources into wiki pages and tasks, answers questions in Ask, and reviews tasks against new evidence. Images go here too unless Vision has its own endpoint."
								applies="Changes apply to the next request; nothing restarts."
								test={(input) => client.testLlm(input)}
							/>
						</div>
					</div>
					<div className="mdb-card">
						<div className="mdb-card-head">
							Vision
							<span className="mdb-sub">images and scanned pages</span>
						</div>
						<div className="mdb-card-pad">
							<EndpointSettingsPanel
								client={client}
								group="vision"
								intro="Images and scanned PDF pages in the Nextcloud import folders are sent to this OpenAI-compatible endpoint to be described and their text transcribed."
								test={(input) => client.testVision(input)}
							/>
						</div>
					</div>
					<div className="mdb-card">
						<div className="mdb-card-head">
							Transcription
							<span className="mdb-sub">recordings in Nextcloud</span>
						</div>
						<div className="mdb-card-pad">
							<EndpointSettingsPanel
								client={client}
								group="transcription"
								intro="Audio and video in the Nextcloud import folders are cut into chunks and sent to this OpenAI-compatible endpoint for speech-to-text."
								test={(input) => client.testTranscription(input)}
							/>
						</div>
					</div>
				</div>
			) : null}

			{isMaster ? (
				<div className="mdb-card mdb-card-pad">
					<ApiKeysPanel client={client} />
				</div>
			) : (
				<div
					className="mdb-card mdb-card-pad mdb-muted"
					style={{ fontSize: 13 }}
				>
					API keys and transcription settings are managed with the master key.
				</div>
			)}
		</div>
	)
}
