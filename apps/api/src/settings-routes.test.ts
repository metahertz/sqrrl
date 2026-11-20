// Console settings: master-only, validated, stored mode 600 in an env file
// the sync job sources, secrets never echoed, and the endpoint test never
// sends the saved key anywhere but the saved endpoint.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	describeSettings,
	readSettings,
	validateSetting,
	writeSettings,
} from "./lib/runtime-settings.js"
import { silentWav } from "./routes/settings.js"

const MASTER = "master-token"
const ADMIN = "admin-token"
const ENV_KEYS = [
	"SQRRL_API_KEY",
	"SQRRL_API_SCOPED_KEYS",
	"SQRRL_SETTINGS_FILE",
	"NEXTCLOUD_TRANSCRIPTION_BASE_URL",
	"NEXTCLOUD_TRANSCRIPTION_MODEL",
	"NEXTCLOUD_AUDIO_SEGMENT_SECONDS",
	"TRANSCRIBER_API_KEY",
	"SQRRL_LLM_BASE_URL",
	"SQRRL_LLM_API_KEY",
	"SQRRL_LLM_MODEL",
	"SQRRL_ENRICHMENT_BASE_URL",
	"SQRRL_ENRICHMENT_API_KEY",
	"SQRRL_ENRICHMENT_MODEL",
	"NEXTCLOUD_VISION_MODEL",
	"SQRRL_ENRICHMENT_EXTRA_BODY",
]

let dir: string
let file: string
let createApp: typeof import("./app.js").createApp

beforeEach(async () => {
	vi.resetModules()
	dir = await mkdtemp(join(tmpdir(), "settings-"))
	file = join(dir, "console-settings.env")
	process.env.SQRRL_API_KEY = MASTER
	process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
		{
			token: ADMIN,
			subjectId: "admin",
			trustTier: "standard",
			capabilities: ["read", "write", "administer"],
			scopes: ["workspace"],
			scopeRefs: ["*"],
			agentIds: ["*"],
		},
	])
	process.env.SQRRL_SETTINGS_FILE = file
	process.env.NEXTCLOUD_TRANSCRIPTION_BASE_URL = "http://127.0.0.1:3960/v1"
	process.env.NEXTCLOUD_TRANSCRIPTION_MODEL = "whisper-small.en"
	process.env.NEXTCLOUD_AUDIO_SEGMENT_SECONDS = "300"
	process.env.TRANSCRIBER_API_KEY = "local-key"
	process.env.SQRRL_LLM_BASE_URL = "http://litellm:4000/v1"
	process.env.SQRRL_LLM_API_KEY = "llm-key"
	process.env.SQRRL_LLM_MODEL = "qwen3.5-122b"
	// bin/sqrrl-api.sh derives these from SQRRL_LLM_*.
	process.env.SQRRL_ENRICHMENT_BASE_URL = "http://litellm:4000/v1"
	process.env.SQRRL_ENRICHMENT_API_KEY = "llm-key"
	process.env.SQRRL_ENRICHMENT_MODEL = "qwen3.5-122b"
	process.env.NEXTCLOUD_VISION_MODEL = "qwen3.5-122b"
	process.env.SQRRL_ENRICHMENT_EXTRA_BODY = JSON.stringify({
		response_format: { type: "json_object" },
		chat_template_kwargs: { enable_thinking: false },
	})
	;({ createApp } = await import("./app.js"))
})

afterEach(async () => {
	for (const k of ENV_KEYS) delete process.env[k]
	vi.restoreAllMocks()
	await rm(dir, { recursive: true, force: true })
})

const req = (token: string, path: string, init: RequestInit = {}) =>
	createApp().request(path, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	})

const put = (values: Record<string, string | null>, token = MASTER) =>
	req(token, "/v1/admin/settings", {
		method: "PUT",
		body: JSON.stringify({ values }),
	})

describe("validateSetting", () => {
	it("normalizes URLs and rejects other schemes and embedded credentials", () => {
		expect(
			validateSetting(
				"NEXTCLOUD_TRANSCRIPTION_BASE_URL",
				" http://gpu:8000/v1/ ",
			),
		).toBe("http://gpu:8000/v1")
		expect(() =>
			validateSetting("NEXTCLOUD_TRANSCRIPTION_BASE_URL", "file:///etc/passwd"),
		).toThrow(/http or https/)
		expect(() =>
			validateSetting("NEXTCLOUD_TRANSCRIPTION_BASE_URL", "http://u:p@gpu/v1"),
		).toThrow(/API key/)
	})

	it("refuses shell metacharacters in model names and out-of-range chunks", () => {
		expect(() =>
			validateSetting("NEXTCLOUD_TRANSCRIPTION_MODEL", "x; rm -rf ~"),
		).toThrow()
		expect(() =>
			validateSetting("NEXTCLOUD_AUDIO_SEGMENT_SECONDS", "10"),
		).toThrow(/30 to 3600/)
		expect(validateSetting("NEXTCLOUD_AUDIO_SEGMENT_SECONDS", "900")).toBe(
			"900",
		)
		expect(() =>
			validateSetting("NEXTCLOUD_TRANSCRIPTION_API_KEY", "a\nb"),
		).toThrow()
	})
})

describe("Slack token", () => {
	it("takes a user token and refuses a bot token with the reason", () => {
		expect(validateSetting("SLACK_USER_TOKEN", " xoxp-123-abc ")).toBe(
			"xoxp-123-abc",
		)
		expect(() => validateSetting("SLACK_USER_TOKEN", "xoxb-1")).toThrow(
			/bot token/,
		)
		expect(() => validateSetting("SLACK_USER_TOKEN", "hello")).toThrow(
			/starting xoxp-/,
		)
	})
})

describe("settings file", () => {
	it("round-trips values with quotes and is written mode 600", async () => {
		await writeSettings(file, {
			NEXTCLOUD_TRANSCRIPTION_API_KEY: "it's $(secret)",
			NEXTCLOUD_TRANSCRIPTION_MODEL: "whisper-large-v3",
		})
		expect((await stat(file)).mode & 0o777).toBe(0o600)
		expect(await readSettings(file)).toEqual({
			NEXTCLOUD_TRANSCRIPTION_API_KEY: "it's $(secret)",
			NEXTCLOUD_TRANSCRIPTION_MODEL: "whisper-large-v3",
		})
		// Single-quoted, so the sourcing shell expands nothing.
		expect(await readFile(file, "utf8")).toContain(
			`NEXTCLOUD_TRANSCRIPTION_API_KEY='it'\\''s $(secret)'`,
		)
	})

	it("ignores keys it does not manage", async () => {
		await writeFile(file, "PATH='/tmp'\nNEXTCLOUD_TRANSCRIPTION_MODEL='m'\n")
		expect(await readSettings(file)).toEqual({
			NEXTCLOUD_TRANSCRIPTION_MODEL: "m",
		})
	})

	it("describes sources and never returns a secret", () => {
		const view = describeSettings(
			{ NEXTCLOUD_TRANSCRIPTION_API_KEY: "gpu-key" },
			{
				NEXTCLOUD_TRANSCRIPTION_MODEL: "whisper-small.en",
				TRANSCRIBER_API_KEY: "x",
			},
		)
		const byKey = Object.fromEntries(view.map((s) => [s.key, s]))
		expect(byKey.NEXTCLOUD_TRANSCRIPTION_MODEL).toMatchObject({
			value: "whisper-small.en",
			source: "file",
		})
		expect(byKey.NEXTCLOUD_TRANSCRIPTION_API_KEY).toMatchObject({
			value: null,
			isSet: true,
			source: "console",
		})
		expect(byKey.NEXTCLOUD_TRANSCRIPTION_BASE_URL.source).toBe("unset")
		expect(JSON.stringify(view)).not.toContain("gpu-key")
	})
})

describe("/v1/admin/settings", () => {
	it("is master-key only, even for a key with administer", async () => {
		expect((await req(ADMIN, "/v1/admin/settings")).status).toBe(403)
		expect(
			(await put({ NEXTCLOUD_TRANSCRIPTION_MODEL: "m" }, ADMIN)).status,
		).toBe(403)
		expect((await req(MASTER, "/v1/admin/settings")).status).toBe(200)
	})

	it("saves overrides, masks the key, and clears back to the file value", async () => {
		const res = await put({
			NEXTCLOUD_TRANSCRIPTION_BASE_URL: "http://gpu.lan:8000/v1/",
			NEXTCLOUD_TRANSCRIPTION_API_KEY: "gpu-secret",
			NEXTCLOUD_AUDIO_SEGMENT_SECONDS: "1200",
		})
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain("gpu-secret")
		const byKey = Object.fromEntries(
			(JSON.parse(text).settings as Array<{ key: string }>).map((s) => [
				s.key,
				s,
			]),
		)
		expect(byKey.NEXTCLOUD_TRANSCRIPTION_BASE_URL).toMatchObject({
			value: "http://gpu.lan:8000/v1",
			source: "console",
			fileValue: "http://127.0.0.1:3960/v1",
		})
		expect(byKey.NEXTCLOUD_TRANSCRIPTION_API_KEY).toMatchObject({
			isSet: true,
			source: "console",
		})
		expect(await readSettings(file)).toMatchObject({
			NEXTCLOUD_TRANSCRIPTION_API_KEY: "gpu-secret",
		})

		await put({ NEXTCLOUD_TRANSCRIPTION_BASE_URL: null })
		const after = (await (await req(MASTER, "/v1/admin/settings")).json()) as {
			settings: Array<{ key: string }>
		}
		const url = after.settings.find(
			(s) => s.key === "NEXTCLOUD_TRANSCRIPTION_BASE_URL",
		)
		expect(url).toMatchObject({
			value: "http://127.0.0.1:3960/v1",
			source: "file",
		})
	})

	it("rejects unknown keys and invalid values without writing", async () => {
		expect((await put({ PATH: "/tmp" })).status).toBe(400)
		const bad = await put({ NEXTCLOUD_TRANSCRIPTION_MODEL: "a b" })
		expect(bad.status).toBe(400)
		expect(await readSettings(file)).toEqual({})
	})

	it("answers 503 when no settings file is configured", async () => {
		delete process.env.SQRRL_SETTINGS_FILE
		expect((await req(MASTER, "/v1/admin/settings")).status).toBe(503)
	})
})

describe("POST /v1/admin/settings/transcription/test", () => {
	const test = (body: Record<string, string>) =>
		req(MASTER, "/v1/admin/settings/transcription/test", {
			method: "POST",
			body: JSON.stringify(body),
		})

	it("posts a silent WAV with the saved model and key to the saved endpoint", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response('{"text":""}', { status: 200 }))
		const out = await (await test({})).json()
		expect(out).toMatchObject({ ok: true, status: 200, usedKey: "saved" })
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe("http://127.0.0.1:3960/v1/audio/transcriptions")
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer local-key",
		)
		expect((init.body as FormData).get("model")).toBe("whisper-small.en")
	})

	it("never sends the saved key to an unsaved endpoint", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("unauthorized", { status: 401 }))
		const out = await (
			await test({ baseUrl: "http://elsewhere:9000/v1" })
		).json()
		expect(out).toMatchObject({ ok: false, status: 401, usedKey: "none" })
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(
			(init.headers as Record<string, string>).authorization,
		).toBeUndefined()

		await test({ baseUrl: "http://elsewhere:9000/v1", apiKey: "typed" })
		const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit]
		expect((init2.headers as Record<string, string>).authorization).toBe(
			"Bearer typed",
		)
	})

	it("reports network failures, with their cause, instead of throwing", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError("fetch failed", {
				cause: new Error("connect ECONNREFUSED 10.0.0.1:4000"),
			}),
		)
		const out = await (await test({})).json()
		expect(out).toMatchObject({
			ok: false,
			status: 0,
			error: "fetch failed: connect ECONNREFUSED 10.0.0.1:4000",
		})
	})

	it("builds a valid one-second 16 kHz WAV", () => {
		const wav = Buffer.from(silentWav())
		expect(wav.toString("ascii", 0, 4)).toBe("RIFF")
		expect(wav.readUInt32LE(24)).toBe(16_000)
		expect(wav.length).toBe(44 + 32_000)
	})
})

describe("vision settings", () => {
	it("inherits the wiki LLM proxy and key, labelled as such", async () => {
		const out = (await (await req(MASTER, "/v1/admin/settings")).json()) as {
			settings: Array<{ key: string; group: string; fileLabel?: string }>
		}
		const byKey = Object.fromEntries(out.settings.map((s) => [s.key, s]))
		expect(byKey.NEXTCLOUD_AI_BASE_URL).toMatchObject({
			group: "vision",
			value: "http://litellm:4000/v1",
			source: "file",
			fileLabel: "wiki LLM proxy",
		})
		expect(byKey.NEXTCLOUD_AI_API_KEY).toMatchObject({
			value: null,
			isSet: true,
			fileLabel: "wiki LLM key",
		})
		// A value named by the setting itself is just "from env file".
		expect(byKey.NEXTCLOUD_VISION_MODEL.fileLabel).toBeUndefined()
		expect(JSON.stringify(out)).not.toContain("llm-key")
	})

	it("tests with an image, the connector's extra body, and returns the reply", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					JSON.stringify({ choices: [{ message: { content: "Orange" } }] }),
					{ status: 200 },
				),
			)
		const out = await (
			await req(MASTER, "/v1/admin/settings/vision/test", {
				method: "POST",
				body: "{}",
			})
		).json()
		expect(out).toMatchObject({ ok: true, reply: "Orange", usedKey: "saved" })
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe("http://litellm:4000/v1/chat/completions")
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer llm-key",
		)
		const sent = JSON.parse(init.body as string)
		expect(sent.model).toBe("qwen3.5-122b")
		expect(sent.messages[0].content[1].image_url.url).toMatch(
			/^data:image\/png;base64,/,
		)
		expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false })
		expect(sent.response_format).toBeUndefined()
	})

	it("never sends the saved vision key to another endpoint", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("no", { status: 401 }))
		const out = await (
			await req(MASTER, "/v1/admin/settings/vision/test", {
				method: "POST",
				body: JSON.stringify({ baseUrl: "http://gpu:8000/v1" }),
			})
		).json()
		expect(out).toMatchObject({ ok: false, usedKey: "none" })
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(
			(init.headers as Record<string, string>).authorization,
		).toBeUndefined()
	})
})

describe("language model settings", () => {
	const settingsOf = async () =>
		Object.fromEntries(
			(
				(await (await req(MASTER, "/v1/admin/settings")).json()) as {
					settings: Array<{ key: string; value: string | null }>
				}
			).settings.map((s) => [s.key, s]),
		)

	it("applies a save to the API's own environment at once, and reset restores it", async () => {
		expect(
			(
				await put({
					SQRRL_LLM_MODEL: "llama-4",
					SQRRL_LLM_BASE_URL: "http://gpu:8000/v1",
				})
			).status,
		).toBe(200)
		expect(process.env.SQRRL_LLM_MODEL).toBe("llama-4")
		expect(process.env.SQRRL_ENRICHMENT_MODEL).toBe("llama-4")
		expect(process.env.SQRRL_ENRICHMENT_BASE_URL).toBe("http://gpu:8000/v1")
		// The env file side is still what the files said.
		expect((await settingsOf()).SQRRL_LLM_MODEL).toMatchObject({
			value: "llama-4",
			source: "console",
			fileValue: "qwen3.5-122b",
		})
		// Vision follows the LLM endpoint as the sync job will see it.
		expect((await settingsOf()).NEXTCLOUD_AI_BASE_URL).toMatchObject({
			value: "http://gpu:8000/v1",
			fileLabel: "wiki LLM proxy",
		})

		await put({ SQRRL_LLM_MODEL: null, SQRRL_LLM_BASE_URL: null })
		expect(process.env.SQRRL_LLM_MODEL).toBe("qwen3.5-122b")
		expect(process.env.SQRRL_ENRICHMENT_MODEL).toBe("qwen3.5-122b")
		expect(process.env.SQRRL_ENRICHMENT_BASE_URL).toBe("http://litellm:4000/v1")
	})

	it("leaves an enrichment value pinned separately alone", async () => {
		process.env.SQRRL_ENRICHMENT_MODEL = "pinned-model"
		vi.resetModules()
		;({ createApp } = await import("./app.js"))
		await put({ SQRRL_LLM_MODEL: "llama-4" })
		expect(process.env.SQRRL_LLM_MODEL).toBe("llama-4")
		expect(process.env.SQRRL_ENRICHMENT_MODEL).toBe("pinned-model")
	})

	it("tests the LLM with a one-word prompt and the saved key", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
					{ status: 200 },
				),
			)
		const out = await (
			await req(MASTER, "/v1/admin/settings/llm/test", {
				method: "POST",
				body: "{}",
			})
		).json()
		expect(out).toMatchObject({ ok: true, reply: "pong", usedKey: "saved" })
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe("http://litellm:4000/v1/chat/completions")
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer llm-key",
		)
		const sent = JSON.parse(init.body as string)
		expect(sent.model).toBe("qwen3.5-122b")
		expect(sent.response_format).toBeUndefined()
	})
})
