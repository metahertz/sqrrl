"use client"

import type {
	SqrrlApiKey,
	SqrrlApiKeyWithSecret,
	SqrrlClient,
} from "@sqrrl/client"
import { useCallback, useEffect, useState } from "react"
import { buttonStyle, fieldStyle, palette } from "./shared.js"

const CAPABILITIES = [
	"read",
	"write",
	"write-trusted",
	"administer",
	"change-permissions",
	"hard-delete",
	"export",
	"manage-connectors",
] as const

// Mirrors WIKI_SCOPE_VALUES in @sqrrl/wiki-engine, plus the wildcard.
const SCOPES = ["*", "workspace", "user"] as const

/** Presets, because the failure mode this panel exists to prevent is handing
 *  someone the master key for a job that needed read access. The point is that
 *  the safe choice is one click, not an exercise in capability modelling. */
const PRESETS: Record<string, { capabilities: string[]; trustTier: string }> = {
	"read-only": { capabilities: ["read"], trustTier: "restricted" },
	"read + write": {
		capabilities: ["read", "write"],
		trustTier: "standard",
	},
	"read + export": {
		capabilities: ["read", "export"],
		trustTier: "restricted",
	},
}

function expiryLabel(key: SqrrlApiKey): string {
	if (key.revokedAt) return `revoked ${key.revokedAt.slice(0, 10)}`
	if (!key.expiresAt) return "no expiry"
	const when = new Date(key.expiresAt)
	if (when.getTime() <= Date.now())
		return `EXPIRED ${key.expiresAt.slice(0, 10)}`
	return `expires ${key.expiresAt.slice(0, 10)}`
}

/** Issue and withdraw scoped API keys. Rendered only for a master-key session
 *  (see whoami), because the endpoints behind it reject anything else. */
export function ApiKeysPanel({ client }: { client: SqrrlClient }) {
	const [keys, setKeys] = useState<SqrrlApiKey[]>([])
	const [includeRevoked, setIncludeRevoked] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	// Held in state only so it can be shown once; never persisted anywhere.
	const [minted, setMinted] = useState<SqrrlApiKeyWithSecret | null>(null)

	const [subjectId, setSubjectId] = useState("")
	const [displayName, setDisplayName] = useState("")
	const [preset, setPreset] = useState<string>("read-only")
	const [capabilities, setCapabilities] = useState<string[]>(["read"])
	const [scope, setScope] = useState<string>("workspace")
	const [scopeRef, setScopeRef] = useState("default")
	const [expiresAt, setExpiresAt] = useState("")

	const load = useCallback(async () => {
		setError(null)
		try {
			const res = await client.listApiKeys({ includeRevoked })
			setKeys(res.keys)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}, [client, includeRevoked])

	useEffect(() => {
		void load()
	}, [load])

	async function run(label: string, fn: () => Promise<unknown>) {
		setBusy(true)
		setError(null)
		try {
			await fn()
			await load()
		} catch (err) {
			setError(`${label}: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			setBusy(false)
		}
	}

	function applyPreset(name: string) {
		setPreset(name)
		const p = PRESETS[name]
		if (p) setCapabilities(p.capabilities)
	}

	const label = { fontSize: 12, color: palette.muted, marginBottom: 4 }

	return (
		<div>
			<h3 style={{ fontSize: 12, color: palette.muted, margin: "0 0 4px" }}>
				SCOPED API KEYS
			</h3>
			<p
				style={{
					fontSize: 12.5,
					color: palette.muted,
					margin: "0 0 12px",
					lineHeight: 1.5,
					maxWidth: "72ch",
				}}
			>
				Keys for handing out instead of the master key. Each carries only the
				capabilities and scopes you grant here. The secret is shown once when
				the key is created and is not recoverable — only its hash is stored.
			</p>

			{error ? (
				<div
					style={{
						color: palette.error,
						fontSize: 12.5,
						marginBottom: 10,
						fontFamily: "ui-monospace, monospace",
					}}
				>
					{error}
				</div>
			) : null}

			{minted ? (
				<div
					style={{
						border: `2px solid ${palette.accentDark}`,
						borderRadius: 8,
						padding: 12,
						marginBottom: 14,
						background: "#fffdf5",
					}}
				>
					<div style={{ fontSize: 12.5, marginBottom: 6 }}>
						<strong>Copy this now.</strong> It will not be shown again.
					</div>
					<code
						style={{
							display: "block",
							fontFamily: "ui-monospace, monospace",
							fontSize: 12.5,
							wordBreak: "break-all",
							background: "#fff",
							border: `1px solid ${palette.border}`,
							borderRadius: 6,
							padding: "8px 10px",
						}}
					>
						{minted.token}
					</code>
					<div style={{ display: "flex", gap: 6, marginTop: 8 }}>
						<button
							type="button"
							style={buttonStyle("primary")}
							onClick={() => {
								void navigator.clipboard?.writeText(minted.token)
							}}
						>
							copy
						</button>
						<button
							type="button"
							style={buttonStyle()}
							onClick={() => setMinted(null)}
						>
							done
						</button>
					</div>
				</div>
			) : null}

			<details style={{ marginBottom: 14 }}>
				<summary style={{ cursor: "pointer", fontSize: 12.5 }}>
					Issue a new key
				</summary>
				<div style={{ marginTop: 10, display: "grid", gap: 10 }}>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						<div>
							<div style={label}>subject id (unique)</div>
							<input
								aria-label="subject id"
								value={subjectId}
								onChange={(e) => setSubjectId(e.target.value)}
								placeholder="laptop-readonly"
								style={{ ...fieldStyle, width: 190 }}
							/>
						</div>
						<div>
							<div style={label}>label</div>
							<input
								aria-label="display name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="Read-only browsing"
								style={{ ...fieldStyle, width: 190 }}
							/>
						</div>
						<div>
							<div style={label}>expires (optional)</div>
							<input
								aria-label="expires at"
								type="date"
								value={expiresAt}
								onChange={(e) => setExpiresAt(e.target.value)}
								style={{ ...fieldStyle, width: 150 }}
							/>
						</div>
					</div>

					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						<div>
							<div style={label}>preset</div>
							<select
								aria-label="preset"
								value={preset}
								onChange={(e) => applyPreset(e.target.value)}
								style={{ ...fieldStyle, width: 150 }}
							>
								{Object.keys(PRESETS).map((k) => (
									<option key={k}>{k}</option>
								))}
								<option value="custom">custom</option>
							</select>
						</div>
						<div>
							<div style={label}>scope</div>
							<select
								aria-label="scope"
								value={scope}
								onChange={(e) => setScope(e.target.value)}
								style={{ ...fieldStyle, width: 120 }}
							>
								{SCOPES.map((s) => (
									<option key={s}>{s}</option>
								))}
							</select>
						</div>
						<div>
							<div style={label}>scopeRef (* = any)</div>
							<input
								aria-label="scopeRef"
								value={scopeRef}
								onChange={(e) => setScopeRef(e.target.value)}
								style={{ ...fieldStyle, width: 130 }}
							/>
						</div>
					</div>

					<div>
						<div style={label}>capabilities</div>
						<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
							{CAPABILITIES.map((cap) => (
								<label
									key={cap}
									style={{
										fontSize: 12.5,
										display: "flex",
										alignItems: "center",
										gap: 4,
									}}
								>
									<input
										type="checkbox"
										checked={capabilities.includes(cap)}
										onChange={(e) => {
											setPreset("custom")
											setCapabilities((prev) =>
												e.target.checked
													? [...prev, cap]
													: prev.filter((x) => x !== cap),
											)
										}}
									/>
									{cap}
								</label>
							))}
						</div>
						{capabilities.includes("hard-delete") ? (
							<div
								style={{
									fontSize: 12,
									color: palette.error,
									marginTop: 6,
								}}
							>
								hard-delete allows permanent purge, which has no undo.
							</div>
						) : null}
					</div>

					<div>
						<button
							type="button"
							disabled={
								busy ||
								!subjectId.trim() ||
								capabilities.length === 0 ||
								!scopeRef
							}
							style={buttonStyle("primary")}
							onClick={() =>
								run("create", async () => {
									const created = await client.createApiKey({
										subjectId: subjectId.trim(),
										...(displayName.trim()
											? { displayName: displayName.trim() }
											: {}),
										capabilities,
										allowedScopes: [{ scope, scopeRef }],
										trustTier: capabilities.includes("write-trusted")
											? "admin"
											: capabilities.includes("write")
												? "standard"
												: "restricted",
										// The date input yields a bare day; send end of that
										// day UTC so a key dated today is still usable today.
										...(expiresAt
											? { expiresAt: `${expiresAt}T23:59:59.000Z` }
											: {}),
									})
									setMinted(created)
									setSubjectId("")
									setDisplayName("")
									setExpiresAt("")
								})
							}
						>
							create key
						</button>
					</div>
				</div>
			</details>

			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 8,
				}}
			>
				<label style={{ fontSize: 12, color: palette.muted }}>
					<input
						type="checkbox"
						checked={includeRevoked}
						onChange={(e) => setIncludeRevoked(e.target.checked)}
					/>{" "}
					show revoked
				</label>
				<button type="button" style={buttonStyle()} onClick={() => void load()}>
					refresh
				</button>
			</div>

			{keys.length === 0 ? (
				<div style={{ fontSize: 12.5, color: palette.muted }}>
					No scoped keys yet — everything is using the master key.
				</div>
			) : (
				<div style={{ display: "grid", gap: 6 }}>
					{keys.map((k) => (
						<div
							key={k.keyId}
							style={{
								border: `1px solid ${palette.border}`,
								borderRadius: 8,
								padding: "8px 10px",
								fontSize: 12.5,
								opacity: k.revokedAt ? 0.55 : 1,
							}}
						>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<strong>{k.displayName || k.subjectId}</strong>
								<code
									style={{
										fontFamily: "ui-monospace, monospace",
										color: palette.muted,
									}}
								>
									{k.prefix}…
								</code>
								<span style={{ flex: 1 }} />
								<span style={{ color: palette.muted }}>{expiryLabel(k)}</span>
								{k.revokedAt ? null : (
									<button
										type="button"
										disabled={busy}
										style={buttonStyle("danger")}
										onClick={() => {
											if (
												!window.confirm(
													`Revoke "${k.displayName || k.subjectId}"?\n\n` +
														"It stops working immediately. The record is kept, " +
														"but the key itself cannot be recovered.",
												)
											) {
												return
											}
											void run("revoke", () =>
												client.revokeApiKey({ keyId: k.keyId }),
											)
										}}
									>
										revoke
									</button>
								)}
							</div>
							<div style={{ color: palette.muted, marginTop: 4 }}>
								{k.subjectId} · {k.trustTier} ·{" "}
								{k.allowedScopes
									.map(
										(g: { scope: string; scopeRef: string }) =>
											`${g.scope}:${g.scopeRef}`,
									)
									.join(", ")}{" "}
								·{" "}
								{k.lastUsedAt
									? `last used ${k.lastUsedAt.slice(0, 10)}`
									: "never used"}
							</div>
							<div
								style={{
									marginTop: 6,
									display: "flex",
									gap: 6,
									flexWrap: "wrap",
								}}
							>
								{CAPABILITIES.map((cap) => {
									const on = k.capabilities.includes(cap)
									return (
										<button
											key={cap}
											type="button"
											disabled={busy || Boolean(k.revokedAt)}
											title={
												k.revokedAt
													? "revoked keys cannot be edited"
													: on
														? `remove ${cap}`
														: `grant ${cap}`
											}
											style={{
												...buttonStyle(on ? "primary" : undefined),
												padding: "1px 7px",
												fontSize: 11.5,
												opacity: on ? 1 : 0.45,
											}}
											onClick={() => {
												const next = on
													? k.capabilities.filter((x: string) => x !== cap)
													: [...k.capabilities, cap]
												if (next.length === 0) {
													setError(
														"a key needs at least one capability — revoke it instead",
													)
													return
												}
												void run("update", () =>
													client.updateApiKey({
														keyId: k.keyId,
														capabilities: next,
													}),
												)
											}}
										>
											{cap}
										</button>
									)
								})}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
