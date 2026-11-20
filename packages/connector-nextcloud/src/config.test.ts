import { describe, expect, it } from "vitest"
import { ConfigError, loadConfigFromEnv } from "./config.js"

const base = {
	NEXTCLOUD_URL: "https://cloud.example.com/",
	NEXTCLOUD_USER: "bot",
	NEXTCLOUD_APP_PASSWORD: "secret",
	NEXTCLOUD_FOLDERS: " Company/Policies/ , Meetings ",
}

describe("loadConfigFromEnv", () => {
	it("reads a minimal config with defaults", () => {
		const c = loadConfigFromEnv(base)
		expect(c).toMatchObject({
			baseUrl: "https://cloud.example.com",
			folders: ["Company/Policies", "Meetings"],
			tags: [],
			noteCategories: [],
			scope: "workspace",
			scopeRef: "nextcloud",
			privacyTier: "internal",
			maxFileBytes: 50 * 1024 * 1024,
		})
	})

	it.each([
		"NEXTCLOUD_URL",
		"NEXTCLOUD_USER",
		"NEXTCLOUD_APP_PASSWORD",
	])("requires %s", (name) => {
		expect(() => loadConfigFromEnv({ ...base, [name]: "" })).toThrow(
			ConfigError,
		)
	})

	it("refuses to run with nothing selected, which would mark everything stale", () => {
		expect(() => loadConfigFromEnv({ ...base, NEXTCLOUD_FOLDERS: "" })).toThrow(
			"nothing to sync",
		)
	})

	it("accepts notes alone", () => {
		const c = loadConfigFromEnv({
			...base,
			NEXTCLOUD_FOLDERS: "",
			NEXTCLOUD_NOTES_CATEGORIES: "*",
		})
		expect(c.noteCategories).toEqual(["*"])
	})

	it("rejects an unknown privacy tier and a bad number", () => {
		expect(() =>
			loadConfigFromEnv({ ...base, NEXTCLOUD_PRIVACY_TIER: "secret" }),
		).toThrow(ConfigError)
		expect(() =>
			loadConfigFromEnv({ ...base, NEXTCLOUD_MAX_FILE_BYTES: "-1" }),
		).toThrow(ConfigError)
	})

	it("falls back to the sqrrl LLM endpoint for AI calls", () => {
		const c = loadConfigFromEnv({
			...base,
			SQRRL_LLM_BASE_URL: "http://192.0.2.10:4000/v1/",
			SQRRL_LLM_API_KEY: "sk-x",
		})
		expect(c.aiBaseUrl).toBe("http://192.0.2.10:4000/v1")
		expect(c.aiApiKey).toBe("sk-x")
	})

	it("lets transcription use its own endpoint, falling back to the AI one", () => {
		const shared = loadConfigFromEnv({
			...base,
			SQRRL_LLM_BASE_URL: "http://proxy/v1",
			SQRRL_LLM_API_KEY: "sk-proxy",
		})
		expect(shared.transcriptionBaseUrl).toBe("http://proxy/v1")
		expect(shared.transcriptionApiKey).toBe("sk-proxy")
		const local = loadConfigFromEnv({
			...base,
			SQRRL_LLM_BASE_URL: "http://proxy/v1",
			NEXTCLOUD_TRANSCRIPTION_BASE_URL: "http://127.0.0.1:3960/v1/",
			NEXTCLOUD_TRANSCRIPTION_API_KEY: "tx",
		})
		expect(local.transcriptionBaseUrl).toBe("http://127.0.0.1:3960/v1")
		expect(local.transcriptionApiKey).toBe("tx")
		expect(local.aiBaseUrl).toBe("http://proxy/v1")
	})

	it("drops response_format from the shared extra body — a caption is prose", () => {
		const c = loadConfigFromEnv({
			...base,
			SQRRL_ENRICHMENT_EXTRA_BODY:
				'{"chat_template_kwargs":{"enable_thinking":false},"response_format":{"type":"json_schema"}}',
		})
		expect(c.visionExtraBody).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		})
	})
})
