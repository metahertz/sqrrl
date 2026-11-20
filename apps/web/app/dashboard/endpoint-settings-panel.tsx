"use client"

// Settings → Language model, Vision and Transcription: the endpoints the
// wiki's LLM calls, Nextcloud images and recordings go to. One panel per
// settings group. Values saved here override the env files (the language
// model at once, the others on the next Nextcloud sync); clearing one falls
// back to the file. API keys are write-only: the server says whether one is
// stored, never what it is.

import type {
	SqrrlClient,
	SqrrlEndpointTest,
	SqrrlSetting,
} from "@sqrrl/client"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { errorText } from "./drawer-context.js"

type TestInput = { baseUrl?: string; model?: string; apiKey?: string }

function sourceBadge(s: SqrrlSetting) {
	if (s.source === "console")
		return <span className="mdb-badge mdb-badge-accent">set here</span>
	if (s.source === "file")
		return <span className="mdb-badge">{s.fileLabel ?? "from env file"}</span>
	return <span className="mdb-badge mdb-badge-warn">not set</span>
}

export function EndpointSettingsPanel({
	client,
	group,
	intro,
	applies = "Changes apply on the next Nextcloud sync (every 15 minutes).",
	test: runEndpointTest,
}: {
	client: SqrrlClient
	group: string
	intro: ReactNode
	applies?: string
	test: (input: TestInput) => Promise<SqrrlEndpointTest>
}) {
	const [settings, setSettings] = useState<SqrrlSetting[] | null>(null)
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [keyDraft, setKeyDraft] = useState("")
	const [busy, setBusy] = useState(false)
	const [testing, setTesting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)
	const [test, setTest] = useState<SqrrlEndpointTest | null>(null)

	const adopt = useCallback((list: SqrrlSetting[]) => {
		setSettings(list)
		setDrafts(
			Object.fromEntries(
				list
					.filter((s) => s.kind !== "secret")
					.map((s) => [s.key, s.value ?? ""]),
			),
		)
		setKeyDraft("")
	}, [])

	useEffect(() => {
		client
			.settings()
			.then((r) => adopt(r.settings.filter((s) => s.group === group)))
			.catch((err) => setError(errorText(err)))
	}, [client, adopt, group])

	if (error && !settings)
		return (
			<p className="mdb-muted" style={{ margin: 0 }}>
				Could not load settings: {error}
			</p>
		)
	if (!settings) return <p className="mdb-muted">Loading…</p>

	const fields = settings.filter((s) => s.kind !== "secret")
	const keySetting = settings.find((s) => s.kind === "secret")
	const KEY = keySetting?.key ?? ""
	const URL_KEY = settings.find((s) => s.kind === "url")?.key ?? ""
	const MODEL_KEY = settings.find((s) => s.kind === "model")?.key ?? ""
	const changed: Record<string, string | null> = {}
	for (const s of fields) {
		const d = (drafts[s.key] ?? "").trim()
		if (d !== (s.value ?? "")) changed[s.key] = d === "" ? null : d
	}
	if (keyDraft.trim()) changed[KEY] = keyDraft.trim()
	const dirty = Object.keys(changed).length > 0

	async function save(values: Record<string, string | null>) {
		setBusy(true)
		setError(null)
		setSaved(false)
		try {
			const r = await client.updateSettings(values)
			adopt(r.settings.filter((s) => s.group === group))
			setSaved(true)
		} catch (err) {
			setError(errorText(err))
		} finally {
			setBusy(false)
		}
	}

	async function runTest() {
		setBusy(true)
		setTesting(true)
		setError(null)
		setTest(null)
		try {
			setTest(
				await runEndpointTest({
					baseUrl: drafts[URL_KEY]?.trim() || undefined,
					model: drafts[MODEL_KEY]?.trim() || undefined,
					apiKey: keyDraft.trim() || undefined,
				}),
			)
		} catch (err) {
			setError(errorText(err))
		} finally {
			setBusy(false)
			setTesting(false)
		}
	}

	return (
		<div className="mdb-settings-form">
			<p className="mdb-muted" style={{ marginTop: 0, maxWidth: "72ch" }}>
				{intro} {applies}
			</p>
			{fields.map((s) => (
				<div key={s.key} className="mdb-field">
					<span>
						{s.label} {sourceBadge(s)}
					</span>
					<div className="mdb-settings-row">
						<input
							className="mdb-input"
							aria-label={s.label}
							inputMode={s.kind === "seconds" ? "numeric" : undefined}
							value={drafts[s.key] ?? ""}
							placeholder={s.fileValue ?? ""}
							onChange={(e) =>
								setDrafts((d) => ({ ...d, [s.key]: e.target.value }))
							}
						/>
						{s.source === "console" ? (
							<button
								type="button"
								className="mdb-btn mdb-btn-ghost mdb-btn-sm"
								disabled={busy}
								title={
									s.fileValue
										? `Use the env file value: ${s.fileValue}`
										: "Remove the value set here"
								}
								onClick={() => void save({ [s.key]: null })}
							>
								Reset
							</button>
						) : null}
					</div>
					<small className="mdb-muted">{s.help}</small>
				</div>
			))}
			{keySetting ? (
				<div className="mdb-field">
					<span>
						{keySetting.label} {sourceBadge(keySetting)}
					</span>
					<div className="mdb-settings-row">
						<input
							className="mdb-input"
							type="password"
							autoComplete="off"
							aria-label={keySetting.label}
							value={keyDraft}
							placeholder={keySetting.isSet ? "•••••••• (unchanged)" : "none"}
							onChange={(e) => setKeyDraft(e.target.value)}
						/>
						{keySetting.source === "console" ? (
							<button
								type="button"
								className="mdb-btn mdb-btn-ghost mdb-btn-sm"
								disabled={busy}
								title="Remove the key set here"
								onClick={() => void save({ [KEY]: null })}
							>
								Clear
							</button>
						) : null}
					</div>
					<small className="mdb-muted">{keySetting.help}</small>
				</div>
			) : null}

			<div className="mdb-toolbar" style={{ marginTop: 4 }}>
				<button
					type="button"
					className="mdb-btn mdb-btn-primary"
					disabled={busy || !dirty}
					onClick={() => void save(changed)}
				>
					Save
				</button>
				<button
					type="button"
					className="mdb-btn"
					disabled={busy}
					onClick={() => void runTest()}
				>
					{testing ? "Testing…" : "Test endpoint"}
				</button>
				{saved && !dirty ? (
					<span className="mdb-badge mdb-badge-ok">
						{group === "llm"
							? "Saved · in use now"
							: "Saved · applies on the next sync"}
					</span>
				) : null}
			</div>
			{test ? (
				<p
					className={`mdb-settings-result ${test.ok ? "is-ok" : "is-bad"}`}
					role="status"
				>
					{test.ok
						? `Endpoint answered in ${(test.latencyMs / 1000).toFixed(1)} s.${test.reply ? ` ${group === "vision" ? "The model says the test image is" : "The model replied"}: “${test.reply}”.` : ""}`
						: `Failed${test.status ? ` (HTTP ${test.status})` : ""}: ${test.error ?? "no answer"}`}
					{test.usedKey === "none" && !test.ok
						? " No key was sent: the saved key only goes to the saved endpoint, so type the key to test a new URL."
						: ""}
				</p>
			) : null}
			{error ? (
				<p className="mdb-settings-result is-bad" role="alert">
					{error}
				</p>
			) : null}
		</div>
	)
}
