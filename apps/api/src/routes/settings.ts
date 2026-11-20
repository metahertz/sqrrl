// Console-editable settings (master key only), stored by lib/runtime-settings.
//
//   GET  /v1/admin/settings                     every setting, secrets masked
//   PUT  /v1/admin/settings                     {values: {KEY: string|null}}
//   POST /v1/admin/settings/transcription/test  try an endpoint before saving
//   POST /v1/admin/settings/vision/test
//   POST /v1/admin/settings/llm/test
//   POST /v1/admin/settings/slack/test         {token?}: whose token, which
//                                               scopes, how many conversations
//   GET  /v1/admin/settings/slack/manifest     the Slack app manifest
//
// The tests send the same request shapes the Nextcloud connector uses:
// one second of silence to <endpoint>/audio/transcriptions, a small orange
// square to <endpoint>/chat/completions asking for its color, and for the
// language model a one-word reply. Saving a language model setting applies
// it to this process at once (applyLiveSettings). The
// stored key only ever goes to the saved endpoint: testing an unsaved URL
// sends the key typed alongside it, or none, so the console cannot be used
// to post the stored key to an arbitrary host.

import { type Context, Hono } from "hono"
import { type ApiEnvironment, isMasterKeyRequest } from "../api-context.js"
import { readFile } from "node:fs/promises"
import { jsonError } from "../lib/errors.js"
import { checkSlackToken } from "../lib/slack-check.js"
import {
	applyLiveSettings,
	describeSettings,
	effectiveSetting,
	readSettings,
	SETTINGS,
	SettingsNotConfiguredError,
	SettingValidationError,
	settingsFilePath,
	validateSetting,
	writeSettings,
} from "../lib/runtime-settings.js"

const TEST_TIMEOUT_MS = 90_000

function requireMaster(c: Context<ApiEnvironment>) {
	return isMasterKeyRequest(c)
		? null
		: jsonError(
				c,
				403,
				"FORBIDDEN",
				"settings require the master SQRRL_API_KEY",
			)
}

function notConfigured(c: Context<ApiEnvironment>, err: unknown) {
	if (err instanceof SettingsNotConfiguredError)
		return jsonError(c, 503, "SETTINGS_NOT_CONFIGURED", err.message)
	return jsonError(
		c,
		500,
		"SETTINGS_FAILED",
		err instanceof Error ? err.message : String(err),
	)
}

async function view() {
	const path = settingsFilePath()
	return { settings: describeSettings(await readSettings(path)) }
}

const TRANSCRIPTION_KEYS = {
	url: "NEXTCLOUD_TRANSCRIPTION_BASE_URL",
	model: "NEXTCLOUD_TRANSCRIPTION_MODEL",
	key: "NEXTCLOUD_TRANSCRIPTION_API_KEY",
}
const LLM_KEYS = {
	url: "SQRRL_LLM_BASE_URL",
	model: "SQRRL_LLM_MODEL",
	key: "SQRRL_LLM_API_KEY",
}
const VISION_KEYS = {
	url: "NEXTCLOUD_AI_BASE_URL",
	model: "NEXTCLOUD_VISION_MODEL",
	key: "NEXTCLOUD_AI_API_KEY",
}

/** A 32x32 orange square. */
const TEST_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mN4FiVCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULADeGUEyfoej+AAAAAElFTkSuQmCC"

/** The configured extra body (e.g. turning thinking off), without
 *  response_format, which is meant for the wiki's JSON calls; the vision
 *  test prefers the connector's own. */
function extraBody(
	vision: boolean,
	env = process.env,
): Record<string, unknown> {
	const raw =
		(vision ? env.NEXTCLOUD_VISION_EXTRA_BODY?.trim() : undefined) ||
		env.SQRRL_ENRICHMENT_EXTRA_BODY?.trim()
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {}
		const { response_format: _rf, ...rest } = parsed as Record<string, unknown>
		void _rf
		return rest
	} catch {
		return {}
	}
}

interface Target {
	baseUrl: string
	model: string
	apiKey?: string
	usedKey: "typed" | "saved" | "none"
}

/** Endpoint, model and key for a test: typed values win, else the saved
 *  ones; the saved key only goes with the saved endpoint. */
async function resolveTarget(
	c: Context<ApiEnvironment>,
	keys: { url: string; model: string; key: string },
): Promise<Target | Response> {
	const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<
		string,
		unknown
	>
	let stored: Record<string, string>
	try {
		stored = await readSettings(settingsFilePath())
	} catch (err) {
		return notConfigured(c, err)
	}
	const savedUrl = effectiveSetting(keys.url, stored)
	const typed = (k: string) =>
		typeof body[k] === "string" && (body[k] as string).trim()
			? (body[k] as string)
			: undefined
	let baseUrl: string
	let model: string
	try {
		const url = typed("baseUrl")
		baseUrl = url ? validateSetting(keys.url, url) : (savedUrl ?? "")
		const m = typed("model")
		model = m
			? validateSetting(keys.model, m)
			: (effectiveSetting(keys.model, stored) ?? "")
	} catch (err) {
		return jsonError(c, 400, "VALIDATION_ERROR", (err as Error).message)
	}
	if (!baseUrl || !model)
		return jsonError(
			c,
			400,
			"VALIDATION_ERROR",
			"an endpoint and a model are required",
		)
	const typedKey = typed("apiKey")?.trim()
	const apiKey =
		typedKey ??
		(baseUrl === savedUrl ? effectiveSetting(keys.key, stored) : undefined)
	return {
		baseUrl,
		model,
		...(apiKey ? { apiKey } : {}),
		usedKey: apiKey ? (typedKey ? "typed" : "saved") : "none",
	}
}

/** fetch() reports every network failure as "fetch failed"; the reason
 *  (refused, timed out, DNS) is on its cause. */
function networkError(err: unknown): string {
	if (!(err instanceof Error)) return String(err)
	const cause = (err as { cause?: { message?: string; code?: string } }).cause
	const why = cause?.message || cause?.code
	return why && why !== err.message ? `${err.message}: ${why}` : err.message
}

function chatReply(text: string): Record<string, unknown> {
	try {
		const reply = (
			JSON.parse(text) as {
				choices?: Array<{ message?: { content?: string | null } }>
			}
		).choices?.[0]?.message?.content?.trim()
		return reply ? { reply: reply.slice(0, 200) } : {}
	} catch {
		return {}
	}
}

async function probe(
	target: Target,
	path: string,
	init: { body: FormData | string; headers?: Record<string, string> },
	read: (text: string) => Record<string, unknown>,
) {
	const started = Date.now()
	try {
		const res = await fetch(`${target.baseUrl}${path}`, {
			method: "POST",
			body: init.body,
			headers: {
				...(init.headers ?? {}),
				...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
			},
			signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
		})
		const text = await res.text()
		return {
			ok: res.ok,
			status: res.status,
			latencyMs: Date.now() - started,
			usedKey: target.usedKey,
			...(res.ok ? read(text) : { error: text.slice(0, 300) }),
		}
	} catch (err) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - started,
			usedKey: target.usedKey,
			error: networkError(err),
		}
	}
}

/** One second of 16 kHz mono 16-bit silence as a WAV file. */
export function silentWav(seconds = 1, rate = 16_000): Uint8Array {
	const samples = seconds * rate
	const buf = Buffer.alloc(44 + samples * 2)
	buf.write("RIFF", 0)
	buf.writeUInt32LE(36 + samples * 2, 4)
	buf.write("WAVE", 8)
	buf.write("fmt ", 12)
	buf.writeUInt32LE(16, 16)
	buf.writeUInt16LE(1, 20)
	buf.writeUInt16LE(1, 22)
	buf.writeUInt32LE(rate, 24)
	buf.writeUInt32LE(rate * 2, 28)
	buf.writeUInt16LE(2, 32)
	buf.writeUInt16LE(16, 34)
	buf.write("data", 36)
	buf.writeUInt32LE(samples * 2, 40)
	return new Uint8Array(buf)
}

export function createSettingsRouter(): Hono<ApiEnvironment> {
	const router = new Hono<ApiEnvironment>()

	router.get("/", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		try {
			return c.json(await view())
		} catch (err) {
			return notConfigured(c, err)
		}
	})

	router.put("/", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const body = (await c.req.json().catch(() => null)) as {
			values?: Record<string, unknown>
		} | null
		const values = body?.values
		if (!values || typeof values !== "object" || Array.isArray(values))
			return jsonError(c, 400, "VALIDATION_ERROR", "values must be an object")
		try {
			const path = settingsFilePath()
			const stored = await readSettings(path)
			for (const [key, raw] of Object.entries(values)) {
				if (!SETTINGS.some((s) => s.key === key))
					throw new SettingValidationError(`unknown setting ${key}`)
				if (raw === null || raw === "") delete stored[key]
				else if (typeof raw === "string")
					stored[key] = validateSetting(key, raw)
				else throw new SettingValidationError(`${key} must be a string or null`)
			}
			await writeSettings(path, stored)
			applyLiveSettings(stored)
			return c.json(await view())
		} catch (err) {
			if (err instanceof SettingValidationError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			return notConfigured(c, err)
		}
	})

	router.post("/transcription/test", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const target = await resolveTarget(c, TRANSCRIPTION_KEYS)
		if (target instanceof Response) return target
		const form = new FormData()
		form.set("model", target.model)
		form.set("response_format", "json")
		form.set("file", new Blob([silentWav()], { type: "audio/wav" }), "test.wav")
		return c.json(
			await probe(target, "/audio/transcriptions", { body: form }, () => ({})),
		)
	})

	router.post("/vision/test", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const target = await resolveTarget(c, VISION_KEYS)
		if (target instanceof Response) return target
		const body = JSON.stringify({
			model: target.model,
			max_tokens: 512,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "What color is this square? Answer with one word.",
						},
						{ type: "image_url", image_url: { url: TEST_PNG } },
					],
				},
			],
			...extraBody(true),
		})
		return c.json(
			await probe(
				target,
				"/chat/completions",
				{ body, headers: { "content-type": "application/json" } },
				chatReply,
			),
		)
	})

	router.post("/llm/test", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const target = await resolveTarget(c, LLM_KEYS)
		if (target instanceof Response) return target
		const body = JSON.stringify({
			model: target.model,
			max_tokens: 256,
			messages: [
				{ role: "user", content: "Reply with exactly one word: pong" },
			],
			...extraBody(false),
		})
		return c.json(
			await probe(
				target,
				"/chat/completions",
				{ body, headers: { "content-type": "application/json" } },
				chatReply,
			),
		)
	})

	router.post("/slack/test", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const body = ((await c.req.json().catch(() => null)) ?? {}) as {
			token?: unknown
		}
		let token = typeof body.token === "string" ? body.token.trim() : ""
		try {
			if (token) token = validateSetting("SLACK_USER_TOKEN", token)
			else
				token =
					effectiveSetting(
						"SLACK_USER_TOKEN",
						await readSettings(settingsFilePath()),
					) ?? ""
		} catch (err) {
			if (err instanceof SettingValidationError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			return notConfigured(c, err)
		}
		if (!token)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"no token: paste one, or save one first",
			)
		return c.json(
			await checkSlackToken(token, {
				...(process.env.SLACK_API_BASE_URL
					? { baseUrl: process.env.SLACK_API_BASE_URL }
					: {}),
			}),
		)
	})

	router.get("/slack/manifest", async (c) => {
		const denied = requireMaster(c)
		if (denied) return denied
		const path = new URL(
			"../../../../packages/connector-slack/slack-app-manifest.json",
			import.meta.url,
		)
		try {
			return c.json(JSON.parse(await readFile(path, "utf8")))
		} catch {
			return jsonError(c, 404, "NOT_FOUND", "the Slack app manifest is missing")
		}
	})

	return router
}
