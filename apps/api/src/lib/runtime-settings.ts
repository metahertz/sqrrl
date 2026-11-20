// Settings changed from the console instead of by editing env files.
//
// They live in one env-format file (SQRRL_SETTINGS_FILE, mode 600) that
// the jobs reading them source after env/common.env and the secrets files,
// so a value set here overrides the file default on the job's next run.
// Nothing restarts: the Nextcloud sync is a fresh process every 15 minutes,
// and the API applies "live" settings (the language model) to its own
// environment at startup and on every save, since it builds its LLM client
// per request.
//
// Only the keys in SETTINGS can be written, each validated, so nothing typed
// in the console can inject shell into the sourcing script. Secrets are
// write-only: they are stored, never returned.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export type SettingKind = "url" | "model" | "seconds" | "secret"

export interface SettingDef {
	key: string
	group: "llm" | "transcription" | "vision" | "slack"
	label: string
	kind: SettingKind
	help: string
	/** Env vars consulted, in order, when the console has not set a value. */
	fallback?: string[]
	/** Label for a value inherited from a fallback other than `key`
	 *  itself, e.g. "local transcriber key". */
	fallbackLabel?: string
	/** Applied to the API's own process.env, so a save takes effect on the
	 *  next request without a restart. */
	live?: boolean
}

export const SETTINGS: SettingDef[] = [
	{
		key: "SQRRL_LLM_BASE_URL",
		group: "llm",
		label: "Endpoint",
		kind: "url",
		help: "OpenAI-compatible base URL for distilling sources, answers and task review (<endpoint>/chat/completions). Also the vision endpoint's fallback.",
		fallback: ["SQRRL_LLM_BASE_URL"],
		live: true,
	},
	{
		key: "SQRRL_LLM_MODEL",
		group: "llm",
		label: "Model",
		kind: "model",
		help: "Model name the endpoint expects.",
		fallback: ["SQRRL_LLM_MODEL"],
		live: true,
	},
	{
		key: "SQRRL_LLM_API_KEY",
		group: "llm",
		label: "API key",
		kind: "secret",
		help: "Sent as a Bearer token. Also the vision key's fallback.",
		fallback: ["SQRRL_LLM_API_KEY"],
		live: true,
	},
	{
		key: "NEXTCLOUD_AI_BASE_URL",
		group: "vision",
		label: "Endpoint",
		kind: "url",
		help: "OpenAI-compatible base URL; images and scanned pages are sent to <endpoint>/chat/completions. Leave unset to use the wiki LLM proxy. Also the transcription endpoint's fallback.",
		fallback: ["NEXTCLOUD_AI_BASE_URL", "SQRRL_LLM_BASE_URL"],
		fallbackLabel: "wiki LLM proxy",
	},
	{
		key: "NEXTCLOUD_VISION_MODEL",
		group: "vision",
		label: "Model",
		kind: "model",
		help: "A model that accepts images. Unset parks images and scanned pages until one is set.",
		fallback: ["NEXTCLOUD_VISION_MODEL"],
	},
	{
		key: "NEXTCLOUD_AI_API_KEY",
		group: "vision",
		label: "API key",
		kind: "secret",
		help: "Sent as a Bearer token. Leave unset to use the wiki LLM key.",
		fallback: ["NEXTCLOUD_AI_API_KEY", "SQRRL_LLM_API_KEY"],
		fallbackLabel: "wiki LLM key",
	},
	{
		key: "NEXTCLOUD_TRANSCRIPTION_BASE_URL",
		group: "transcription",
		label: "Endpoint",
		kind: "url",
		help: "OpenAI-compatible base URL; recordings are POSTed to <endpoint>/audio/transcriptions.",
		fallback: ["NEXTCLOUD_TRANSCRIPTION_BASE_URL"],
	},
	{
		key: "NEXTCLOUD_TRANSCRIPTION_MODEL",
		group: "transcription",
		label: "Model",
		kind: "model",
		help: "Model name the endpoint expects, e.g. whisper-large-v3.",
		fallback: ["NEXTCLOUD_TRANSCRIPTION_MODEL"],
	},
	{
		key: "NEXTCLOUD_TRANSCRIPTION_API_KEY",
		group: "transcription",
		label: "API key",
		kind: "secret",
		help: "Sent as a Bearer token. Leave unset to use the local transcriber's key.",
		fallback: ["NEXTCLOUD_TRANSCRIPTION_API_KEY", "TRANSCRIBER_API_KEY"],
		fallbackLabel: "local transcriber key",
	},
	{
		key: "SLACK_USER_TOKEN",
		group: "slack",
		label: "User OAuth token",
		kind: "secret",
		help: "The xoxp- token from the Slack app's OAuth & Permissions page. Read by bin/slack-sync.sh on its next run.",
		fallback: ["SLACK_USER_TOKEN"],
	},
	{
		key: "NEXTCLOUD_AUDIO_SEGMENT_SECONDS",
		group: "transcription",
		label: "Chunk length (seconds)",
		kind: "seconds",
		help: "Recordings are cut into chunks of this length before upload. A GPU endpoint can take longer chunks; the limit is its upload size.",
		fallback: ["NEXTCLOUD_AUDIO_SEGMENT_SECONDS"],
	},
]

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]))

export class SettingsNotConfiguredError extends Error {
	constructor() {
		super("SQRRL_SETTINGS_FILE is not set")
	}
}

export class SettingValidationError extends Error {}

export function settingsFilePath(env = process.env): string {
	const path = env.SQRRL_SETTINGS_FILE?.trim()
	if (!path) throw new SettingsNotConfiguredError()
	return path
}

/** Returns the normalized value, or throws SettingValidationError. */
export function validateSetting(key: string, raw: string): string {
	const def = BY_KEY.get(key)
	if (!def) throw new SettingValidationError(`unknown setting ${key}`)
	const value = raw.trim()
	if ([...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\x7f"))
		throw new SettingValidationError(`${def.label}: control characters`)
	switch (def.kind) {
		case "url": {
			let url: URL
			try {
				url = new URL(value)
			} catch {
				throw new SettingValidationError(`${def.label}: not a URL`)
			}
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new SettingValidationError(`${def.label}: must be http or https`)
			if (url.username || url.password)
				throw new SettingValidationError(
					`${def.label}: put credentials in the API key, not the URL`,
				)
			return value.replace(/\/+$/, "")
		}
		case "model":
			if (!/^[\w.:/@+-]{1,200}$/.test(value))
				throw new SettingValidationError(
					`${def.label}: letters, digits and . _ : / @ + - only`,
				)
			return value
		case "seconds": {
			const n = Number(value)
			if (!Number.isInteger(n) || n < 30 || n > 3600)
				throw new SettingValidationError(
					`${def.label}: a whole number from 30 to 3600`,
				)
			return String(n)
		}
		case "secret":
			if (value.length < 1 || value.length > 4096)
				throw new SettingValidationError(`${def.label}: 1 to 4096 characters`)
			if (key === "SLACK_USER_TOKEN") {
				// A bot token cannot read the user's DMs; say so rather than
				// letting the first sync find out.
				if (value.startsWith("xoxb-"))
					throw new SettingValidationError(
						`${def.label}: that is a bot token (xoxb-); use the User OAuth Token (xoxp-)`,
					)
				if (!/^xoxp-[A-Za-z0-9-]+$/.test(value))
					throw new SettingValidationError(
						`${def.label}: expected a User OAuth Token starting xoxp-`,
					)
			}
			return value
	}
}

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

function unquote(value: string): string {
	if (value.startsWith("'") && value.endsWith("'"))
		return value.slice(1, -1).replace(/'\\''/g, "'")
	return value
}

export async function readSettings(
	path: string,
): Promise<Record<string, string>> {
	let text: string
	try {
		text = await readFile(path, "utf8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
		throw err
	}
	const out: Record<string, string> = {}
	for (const line of text.split("\n")) {
		const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
		if (!m) continue
		// Files written before the SQRRL rename name LLM keys MDBRAIN_*.
		const key = m[1].replace(/^MDBRAIN_/, "SQRRL_")
		if (BY_KEY.has(key) && out[key] === undefined) out[key] = unquote(m[2])
	}
	return out
}

export async function writeSettings(
	path: string,
	values: Record<string, string>,
): Promise<void> {
	const lines = [
		"# Written by the SQRRL console (Settings). Edit there, not here.",
		"# Sourced by bin/nextcloud-sync.sh after env/common.env and the secrets;",
		"# the API applies the SQRRL_LLM_* values itself.",
		...SETTINGS.filter((s) => values[s.key] !== undefined).map(
			(s) => `${s.key}=${quote(values[s.key])}`,
		),
		"",
	]
	await mkdir(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	await writeFile(tmp, lines.join("\n"), { mode: 0o600 })
	await chmod(tmp, 0o600)
	await rename(tmp, path)
}

export type SettingSource = "console" | "file" | "unset"

export interface SettingView {
	key: string
	group: SettingDef["group"]
	label: string
	kind: SettingKind
	help: string
	/** Effective value; always null for secrets. */
	value: string | null
	isSet: boolean
	source: SettingSource
	/** What applies when the console value is cleared (null for secrets). */
	fileValue: string | null
	fileLabel?: string
}

/** The environment as the env files set it, before any console value was
 *  applied to process.env: the "file" side of every setting. Captured on
 *  first use, which applyLiveSettings guarantees happens before it writes. */
let fileEnv: Record<string, string | undefined> | null = null
export function fileEnvironment(): Record<string, string | undefined> {
	if (!fileEnv) fileEnv = { ...process.env }
	return fileEnv
}

/** First non-empty fallback. A console value for another setting counts
 *  (the vision endpoint falls back to the LLM endpoint as the sync job sees
 *  it, console value included); the setting's own key reads the file. */
function resolveFallback(
	def: SettingDef,
	stored: Record<string, string>,
	env: Record<string, string | undefined>,
): { key: string; value: string } | null {
	for (const k of def.fallback ?? []) {
		const v = (k !== def.key ? stored[k] : undefined) ?? env[k]?.trim()
		if (v) return { key: k, value: v }
	}
	return null
}

export function describeSettings(
	stored: Record<string, string>,
	env: Record<string, string | undefined> = fileEnvironment(),
): SettingView[] {
	return SETTINGS.map((def) => {
		const fb = resolveFallback(def, stored, env)
		const fromFile = fb?.value ?? null
		const console = stored[def.key] ?? null
		const secret = def.kind === "secret"
		return {
			key: def.key,
			group: def.group,
			label: def.label,
			kind: def.kind,
			help: def.help,
			value: secret ? null : (console ?? fromFile),
			isSet: Boolean(console ?? fromFile),
			source: console ? "console" : fromFile ? "file" : "unset",
			fileValue: secret ? null : fromFile,
			...(fb && fb.key !== def.key && def.fallbackLabel
				? { fileLabel: def.fallbackLabel }
				: {}),
		}
	})
}

/** The value a job would use: console override, else the env fallback. */
export function effectiveSetting(
	key: string,
	stored: Record<string, string>,
	env: Record<string, string | undefined> = fileEnvironment(),
): string | undefined {
	const def = BY_KEY.get(key)
	if (!def) return undefined
	return stored[key] ?? resolveFallback(def, stored, env)?.value ?? undefined
}

/** SQRRL_ENRICHMENT_* (what the API's LLM client reads) mirror
 *  SQRRL_LLM_* when bin/sqrrl-api.sh derived them from it, which it does
 *  unless an operator pinned them separately. */
const MIRRORS: Array<[string, string]> = [
	["SQRRL_LLM_BASE_URL", "SQRRL_ENRICHMENT_BASE_URL"],
	["SQRRL_LLM_MODEL", "SQRRL_ENRICHMENT_MODEL"],
	["SQRRL_LLM_API_KEY", "SQRRL_ENRICHMENT_API_KEY"],
]

/** Puts the live settings into process.env: the console value, else the
 *  env file's. Returns the keys it changed (names only). */
export function applyLiveSettings(
	stored: Record<string, string>,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const file = fileEnvironment()
	const changed: string[] = []
	const set = (k: string, v: string | undefined) => {
		if (env[k] === v) return
		if (v === undefined) delete env[k]
		else env[k] = v
		changed.push(k)
	}
	for (const def of SETTINGS) {
		if (!def.live) continue
		const v = stored[def.key] ?? file[def.key]
		set(def.key, v)
		for (const [from, to] of MIRRORS) {
			if (from === def.key && file[to] === file[from]) set(to, v)
		}
	}
	return changed
}

/** Startup: apply the stored live settings, if a settings file is set. */
export async function loadLiveSettings(): Promise<string[]> {
	const path = process.env.SQRRL_SETTINGS_FILE?.trim()
	if (!path) return []
	return applyLiveSettings(await readSettings(path))
}
