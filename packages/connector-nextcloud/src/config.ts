// Connector configuration, read from the environment so the runner can be
// driven by the same env/secrets files as the other sqrrl services.

export type PrivacyTier = "public" | "internal" | "confidential" | "restricted"

export interface NextcloudConnectorConfig {
	/** Nextcloud origin, e.g. https://cloud.example.com (no trailing path). */
	baseUrl: string
	/** Account the connector reads as. Everything this account can see in the
	 *  configured folders/tags becomes readable to wiki readers of the target
	 *  scope — Nextcloud's own share rules are not carried across. Use a
	 *  dedicated account that only has the intended folders shared to it. */
	user: string
	/** App password (Settings → Security), never the login password. */
	appPassword: string
	/** Folders to sync, relative to the account's file root. Recursive. */
	folders: string[]
	/** System tag names; any file carrying one is synced wherever it lives. */
	tags: string[]
	/** Notes app categories to sync. ["*"] = every note; [] = notes disabled.
	 *  A category matches itself and its subcategories ("Work" ⊇ "Work/1:1s"). */
	noteCategories: string[]
	scope: string
	scopeRef: string
	trustTier: string
	/** privacyTier stamped on every page this connector writes. */
	privacyTier: PrivacyTier
	/** Files larger than this are skipped rather than downloaded. */
	maxFileBytes: number
	/** Extracted text above this length is split into part pages. The API
	 *  caps request bodies at 2 MiB and one enormous page summarizes badly. */
	maxPartChars: number
	/** Where sync state (etags, slugs) is persisted between runs. */
	stateFile: string
	/** OpenAI-compatible endpoint serving the vision and transcription models. */
	aiBaseUrl: string
	aiApiKey: string
	/** Chat model that accepts image input. Empty disables image extraction. */
	visionModel: string
	/** Model served at /audio/transcriptions. Empty disables audio/video. */
	transcriptionModel: string
	/** Transcription can live on a different endpoint from vision (e.g. the
	 *  local CPU transcriber). Defaults to aiBaseUrl / aiApiKey. */
	transcriptionBaseUrl: string
	transcriptionApiKey: string
	/** Per-request timeout for AI calls; local models are slow. */
	aiTimeoutMs: number
	/** Timeout for one wiki maintenance call (two LLM calls per part). */
	wikiTimeoutMs: number
	/** Extra body merged into vision requests (e.g. disabling reasoning). */
	visionExtraBody: Record<string, unknown>
	/** ffmpeg binary. Empty = the one bundled by ffmpeg-static; "none"
	 *  disables re-encoding, and recordings are then sent whole. */
	ffmpegPath: string
	/** Recordings are transcribed in segments of this many seconds. */
	audioSegmentSeconds: number
	/** Audio and video are streamed to disk, not memory, so they get their
	 *  own, much larger, size limit than documents. */
	maxMediaBytes: number
	/** Recordings over this size are refused when ffmpeg is unavailable,
	 *  because they would be uploaded whole. */
	maxRawUploadBytes: number
	/** Scanned PDF pages captioned per document; the rest are noted. */
	maxScannedPages: number
	/** PDF render scale for scanned pages (1 = 72 dpi). */
	pdfRenderScale: number
	/** Images are downscaled so their longest edge fits this before captioning. */
	maxImageEdge: number
	/** Stamp images with a one-time code and reject answers that do not
	 *  read it back. Off unless NEXTCLOUD_VERIFY_IMAGES=1: measured on
	 *  qwen3.5-122b, the stamp was read exactly on 0 of 8 clean 1024 px PNGs
	 *  (the images themselves were described correctly), so verification
	 *  would reject good captions. It also cannot catch the corruption
	 *  actually seen, where the stamp came back right and the picture above
	 *  it was partly another image. The inference canary is the guard. */
	verifyImages: boolean
	/** Extra attempts after an answer fails verification. */
	verifyRetries: number
}

export class ConfigError extends Error {}

function list(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
}

function num(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined || raw.trim() === "") return fallback
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) {
		throw new ConfigError(`${name} must be a positive number, got "${raw}"`)
	}
	return Math.floor(n)
}

const PRIVACY_TIERS: PrivacyTier[] = [
	"public",
	"internal",
	"confidential",
	"restricted",
]

export function loadConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): NextcloudConnectorConfig {
	const required = (name: string): string => {
		const v = env[name]?.trim()
		if (!v) throw new ConfigError(`${name} is required`)
		return v
	}
	const baseUrl = required("NEXTCLOUD_URL").replace(/\/+$/, "")
	if (!/^https?:\/\//.test(baseUrl)) {
		throw new ConfigError("NEXTCLOUD_URL must start with http:// or https://")
	}
	const folders = list(env.NEXTCLOUD_FOLDERS)
	const tags = list(env.NEXTCLOUD_TAGS)
	const noteCategories = list(env.NEXTCLOUD_NOTES_CATEGORIES)
	if (folders.length + tags.length + noteCategories.length === 0) {
		// A run with nothing selected would "discover" an empty world and mark
		// every previously synced page stale.
		throw new ConfigError(
			"nothing to sync: set NEXTCLOUD_FOLDERS, NEXTCLOUD_TAGS and/or NEXTCLOUD_NOTES_CATEGORIES",
		)
	}
	const privacyTier = (env.NEXTCLOUD_PRIVACY_TIER?.trim() ||
		"internal") as PrivacyTier
	if (!PRIVACY_TIERS.includes(privacyTier)) {
		throw new ConfigError(
			`NEXTCLOUD_PRIVACY_TIER must be one of ${PRIVACY_TIERS.join("|")}`,
		)
	}
	let visionExtraBody: Record<string, unknown> = {}
	const rawExtra =
		env.NEXTCLOUD_VISION_EXTRA_BODY?.trim() ||
		env.SQRRL_ENRICHMENT_EXTRA_BODY?.trim()
	if (rawExtra) {
		try {
			const parsed: unknown = JSON.parse(rawExtra)
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				// response_format is meant for the wiki's JSON calls; a caption is
				// prose, and a grammar-constrained caption comes back as {"...":"..."}.
				const { response_format: _rf, ...rest } = parsed as Record<
					string,
					unknown
				>
				void _rf
				visionExtraBody = rest
			}
		} catch {
			throw new ConfigError("vision extra body must be a JSON object")
		}
	}
	return {
		baseUrl,
		user: required("NEXTCLOUD_USER"),
		appPassword: required("NEXTCLOUD_APP_PASSWORD"),
		folders: folders.map((f) => f.replace(/^\/+|\/+$/g, "")),
		tags,
		noteCategories,
		scope: env.NEXTCLOUD_SCOPE?.trim() || "workspace",
		scopeRef: env.NEXTCLOUD_SCOPE_REF?.trim() || "nextcloud",
		trustTier: env.NEXTCLOUD_TRUST_TIER?.trim() || "standard",
		privacyTier,
		maxFileBytes: num(
			env.NEXTCLOUD_MAX_FILE_BYTES,
			50 * 1024 * 1024,
			"NEXTCLOUD_MAX_FILE_BYTES",
		),
		maxPartChars: num(
			env.NEXTCLOUD_MAX_PART_CHARS,
			60_000,
			"NEXTCLOUD_MAX_PART_CHARS",
		),
		stateFile: env.NEXTCLOUD_STATE_FILE?.trim() || "nextcloud-sync-state.json",
		aiBaseUrl: (
			env.NEXTCLOUD_AI_BASE_URL?.trim() ||
			env.SQRRL_LLM_BASE_URL?.trim() ||
			""
		).replace(/\/+$/, ""),
		aiApiKey:
			env.NEXTCLOUD_AI_API_KEY?.trim() || env.SQRRL_LLM_API_KEY?.trim() || "",
		visionModel: env.NEXTCLOUD_VISION_MODEL?.trim() ?? "",
		transcriptionModel: env.NEXTCLOUD_TRANSCRIPTION_MODEL?.trim() ?? "",
		transcriptionBaseUrl: (
			env.NEXTCLOUD_TRANSCRIPTION_BASE_URL?.trim() ||
			env.NEXTCLOUD_AI_BASE_URL?.trim() ||
			env.SQRRL_LLM_BASE_URL?.trim() ||
			""
		).replace(/\/+$/, ""),
		transcriptionApiKey:
			env.NEXTCLOUD_TRANSCRIPTION_API_KEY?.trim() ||
			env.NEXTCLOUD_AI_API_KEY?.trim() ||
			env.SQRRL_LLM_API_KEY?.trim() ||
			"",
		aiTimeoutMs: num(
			env.NEXTCLOUD_AI_TIMEOUT_MS,
			600_000,
			"NEXTCLOUD_AI_TIMEOUT_MS",
		),
		wikiTimeoutMs: num(
			env.NEXTCLOUD_WIKI_TIMEOUT_MS,
			900_000,
			"NEXTCLOUD_WIKI_TIMEOUT_MS",
		),
		visionExtraBody,
		ffmpegPath: env.NEXTCLOUD_FFMPEG_PATH?.trim() ?? "",
		audioSegmentSeconds: num(
			env.NEXTCLOUD_AUDIO_SEGMENT_SECONDS,
			600,
			"NEXTCLOUD_AUDIO_SEGMENT_SECONDS",
		),
		maxMediaBytes: num(
			env.NEXTCLOUD_MAX_MEDIA_BYTES,
			2 * 1024 * 1024 * 1024,
			"NEXTCLOUD_MAX_MEDIA_BYTES",
		),
		maxRawUploadBytes: num(
			env.NEXTCLOUD_MAX_RAW_UPLOAD_BYTES,
			25 * 1024 * 1024,
			"NEXTCLOUD_MAX_RAW_UPLOAD_BYTES",
		),
		maxScannedPages: num(
			env.NEXTCLOUD_MAX_SCANNED_PAGES,
			100,
			"NEXTCLOUD_MAX_SCANNED_PAGES",
		),
		pdfRenderScale: num(
			env.NEXTCLOUD_PDF_RENDER_SCALE,
			2,
			"NEXTCLOUD_PDF_RENDER_SCALE",
		),
		maxImageEdge: num(
			env.NEXTCLOUD_MAX_IMAGE_EDGE,
			1600,
			"NEXTCLOUD_MAX_IMAGE_EDGE",
		),
		verifyImages: env.NEXTCLOUD_VERIFY_IMAGES?.trim() === "1",
		verifyRetries:
			env.NEXTCLOUD_VERIFY_RETRIES?.trim() === "0"
				? 0
				: num(env.NEXTCLOUD_VERIFY_RETRIES, 2, "NEXTCLOUD_VERIFY_RETRIES"),
	}
}
