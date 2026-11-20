// Turns a file into text the wiki can ingest.
//
// Phase 1 of the multimodal plan: everything becomes text before it reaches
// sqrrl, so Atlas autoEmbed (text-only, voyage-4-large) embeds it like any
// other note and ADR 0006's single embedding path stays intact. Phase 2 adds
// locally computed image vectors alongside; the provenance recorded here
// (extractor, byte hash) is what lets phase 2 find what to embed.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { extractText as pdfText, getDocumentProxy } from "unpdf"
import {
	type AiClient,
	AiUnavailableError,
	NO_TEXT_MARKER,
	ResponseMismatchError,
} from "./ai.js"
import {
	baseMime,
	ext,
	htmlToText,
	OFFICE_EXT,
	OFFICE_MIME,
	officeText,
	tidy,
} from "./markup.js"
import { transcribeRecording } from "./media.js"
import {
	heicToPng,
	newVerificationCode,
	pdfDocumentOptions,
	renderPdfPage,
	stampImage,
	toVisionPng,
	withTempDir,
} from "./tools.js"

/** Bump when extraction output changes, so already-synced files are
 *  re-extracted on the next run instead of keeping the old text.
 *  v2: scanned PDF pages captioned, HEIC converted, recordings segmented. */
export const EXTRACTOR_VERSION = 2

export type ExtractKind =
	| "text"
	| "pdf"
	| "office"
	| "image"
	| "audio"
	| "video"

/** A capability a file is waiting on. The item is parked rather than
 *  retried every pass, and picked up once the capability is configured. */
export type WaitingFor = "vision" | "transcription"

export type ExtractResult =
	| {
			ok: true
			kind: ExtractKind
			extractor: string
			text: string
			notes: string[]
			/** Set when part of the file (scanned pages) still needs a model. */
			waitingFor?: WaitingFor
	  }
	| {
			ok: false
			kind: ExtractKind | "unsupported"
			reason: string
			/** True when a later pass could succeed without the file changing
			 *  (endpoint down, timeout). */
			retryable: boolean
			waitingFor?: WaitingFor
	  }

export interface ExtractOptions {
	/** What this host can actually run — see probeTools(). */
	tools: {
		canvas: boolean
		heic: boolean
		ffmpeg: string | null
		/** A font is available to draw verification stamps. */
		stamps?: boolean
	}
	/** Stamp every image with a one-time code the model must read back. */
	verifyImages?: boolean
	maxScannedPages: number
	pdfRenderScale: number
	maxImageEdge: number
	audioSegmentSeconds: number
	maxRawUploadBytes: number
	mediaTimeoutMs: number
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
	tools: { canvas: false, heic: false, ffmpeg: null },
	maxScannedPages: 100,
	pdfRenderScale: 2,
	maxImageEdge: 1600,
	audioSegmentSeconds: 600,
	maxRawUploadBytes: 25 * 1024 * 1024,
	mediaTimeoutMs: 60 * 60 * 1000,
}

const TEXT_EXT = new Set([
	"md",
	"markdown",
	"txt",
	"csv",
	"tsv",
	"json",
	"log",
	"vtt",
	"srt",
	"html",
	"htm",
	"xml",
	"yaml",
	"yml",
])

/** Formats vision models reliably accept as base64 data URLs. */
const VISION_MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
])

function isHeic(mime: string, name: string): boolean {
	return (
		/^image\/hei[cf](-sequence)?$/.test(mime) ||
		["heic", "heif"].includes(ext(name))
	)
}

export function classify(
	mimeType: string,
	name: string,
): ExtractKind | "unsupported" {
	const mime = baseMime(mimeType)
	const e = ext(name)
	if (mime === "application/pdf" || e === "pdf") return "pdf"
	if (OFFICE_MIME[mime] || OFFICE_EXT[e]) return "office"
	if (mime.startsWith("image/") || isHeic(mime, name)) return "image"
	if (mime.startsWith("audio/")) return "audio"
	if (mime.startsWith("video/")) return "video"
	if (
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/xml" ||
		TEXT_EXT.has(e)
	) {
		return "text"
	}
	return "unsupported"
}

/** Stamps a PNG when verification is on, returning the code to check. */
async function prepareForVision(
	png: Uint8Array,
	opts: ExtractOptions,
): Promise<{ image: Uint8Array; code?: string }> {
	if (!opts.verifyImages || !opts.tools.stamps) return { image: png }
	const code = newVerificationCode()
	return { image: await stampImage(png, code), code }
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

const tag = (x: string) => `${x}@${EXTRACTOR_VERSION}`

async function extractPdf(
	bytes: Uint8Array,
	name: string,
	ai: AiClient,
	opts: ExtractOptions,
): Promise<ExtractResult> {
	// pdf.js detaches the buffer it is given; hand it a copy so the caller's
	// bytes stay usable (they are hashed afterwards).
	const doc = await getDocumentProxy(
		new Uint8Array(bytes),
		pdfDocumentOptions() as Parameters<typeof getDocumentProxy>[1],
	)
	const { totalPages, text } = await pdfText(doc)
	const pages = (text as string[]).map((t) => t.trim())
	const scanned = pages.flatMap((t, i) => (t ? [] : [i]))
	const notes: string[] = []
	let waitingFor: WaitingFor | undefined
	let captioned = 0

	if (scanned.length > 0 && !opts.tools.canvas) {
		notes.push(
			`${scanned.length} of ${totalPages} page(s) are scanned and could not be rendered (canvas unavailable)`,
		)
	} else if (scanned.length > 0) {
		for (const index of scanned.slice(0, opts.maxScannedPages)) {
			const png = await renderPdfPage(doc, index + 1, opts.pdfRenderScale)
			const { image, code } = await prepareForVision(png, opts)
			try {
				const caption = await ai.caption(
					image,
					"image/png",
					`${name} page ${index + 1}`,
					"document-page",
					code,
				)
				captioned++
				if (caption.trim() !== NO_TEXT_MARKER) {
					pages[index] = `(Scanned page, read by a vision model.)\n${caption}`
				}
			} catch (err) {
				if (err instanceof AiUnavailableError) {
					waitingFor = "vision"
					break
				}
				// A mismatch means the node answered about some other image; like
				// an endpoint failure, it is worth another pass.
				return {
					ok: false,
					kind: "pdf",
					reason: `${err instanceof ResponseMismatchError ? "unverifiable vision answer" : "vision model failed"} on page ${index + 1}: ${message(err)}`,
					retryable: true,
				}
			}
		}
		const unread = Math.min(scanned.length, opts.maxScannedPages) - captioned
		if (waitingFor) {
			notes.push(`${unread} scanned page(s) are waiting for a vision model`)
		}
		if (scanned.length > opts.maxScannedPages) {
			notes.push(
				`${scanned.length - opts.maxScannedPages} further scanned page(s) were not read (NEXTCLOUD_MAX_SCANNED_PAGES=${opts.maxScannedPages})`,
			)
		}
	}

	const body = tidy(
		pages
			.map((t, i) => (t ? `## Page ${i + 1}\n${t}` : ""))
			.filter(Boolean)
			.join("\n\n"),
	)
	if (!body) {
		return waitingFor
			? {
					ok: false,
					kind: "pdf",
					reason: "PDF is entirely scanned and no vision model is configured",
					retryable: false,
					waitingFor,
				}
			: {
					ok: false,
					kind: "pdf",
					reason: notes[0] ?? "PDF contains no text",
					retryable: false,
				}
	}
	return {
		ok: true,
		kind: "pdf",
		extractor: tag(captioned > 0 ? "pdf-text+vision" : "pdf-text"),
		text: body,
		notes,
		...(waitingFor ? { waitingFor } : {}),
	}
}

async function extractImage(
	bytes: Uint8Array,
	mimeType: string,
	name: string,
	ai: AiClient,
	opts: ExtractOptions,
): Promise<ExtractResult> {
	const mime = baseMime(mimeType)
	let image = bytes
	let imageMime = mime
	const notes: string[] = []
	// Conversion problems are properties of the file; they fail the same way
	// every pass, so they are not retryable.
	try {
		if (isHeic(mime, name)) {
			if (!opts.tools.heic) {
				return {
					ok: false,
					kind: "image",
					reason:
						"HEIC needs heic-decode and @napi-rs/canvas, which are unavailable",
					retryable: false,
				}
			}
			image = await heicToPng(bytes, opts.maxImageEdge)
			imageMime = "image/png"
			notes.push("converted from HEIC")
		} else if (!VISION_MIME.has(mime)) {
			return {
				ok: false,
				kind: "image",
				reason: `${mime} is not an image format the vision model accepts`,
				retryable: false,
			}
		} else if (opts.tools.canvas) {
			// See toVisionPng: large JPEGs are misread by the model server.
			image = await toVisionPng(bytes, opts.maxImageEdge)
			imageMime = "image/png"
		}
	} catch (err) {
		return {
			ok: false,
			kind: "image",
			reason: `could not decode image: ${message(err)}`,
			retryable: false,
		}
	}
	try {
		const prepared =
			imageMime === "image/png"
				? await prepareForVision(image, opts)
				: { image, code: undefined }
		const text = await ai.caption(
			prepared.image,
			imageMime,
			name,
			"picture",
			prepared.code,
		)
		return {
			ok: true,
			kind: "image",
			extractor: tag("vision-caption"),
			text,
			notes,
		}
	} catch (err) {
		if (err instanceof AiUnavailableError) {
			return {
				ok: false,
				kind: "image",
				reason: err.message,
				retryable: false,
				waitingFor: "vision",
			}
		}
		return { ok: false, kind: "image", reason: message(err), retryable: true }
	}
}

/** Extracts text from an in-memory file. Recordings are better handed to
 *  transcribeRecording() as a path; given bytes, they are spooled to disk. */
export async function extract(
	bytes: Uint8Array,
	mimeType: string,
	name: string,
	ai: AiClient,
	opts: ExtractOptions = DEFAULT_EXTRACT_OPTIONS,
): Promise<ExtractResult> {
	const kind = classify(mimeType, name)
	const fail = (reason: string, retryable = false): ExtractResult => ({
		ok: false,
		kind,
		reason,
		retryable,
	})
	try {
		switch (kind) {
			case "text": {
				const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
				const isHtml = /html?$/.test(ext(name)) || mimeType.includes("html")
				const text = tidy(isHtml ? htmlToText(raw) : raw)
				return text
					? { ok: true, kind, extractor: tag("text"), text, notes: [] }
					: fail("file is empty")
			}
			case "pdf":
				return await extractPdf(bytes, name, ai, opts)
			case "office": {
				const format = OFFICE_MIME[baseMime(mimeType)] ?? OFFICE_EXT[ext(name)]
				const text = tidy(officeText(bytes, format))
				return text
					? {
							ok: true,
							kind,
							extractor: tag(`office-${format}`),
							text,
							notes: [],
						}
					: fail(`no text found in ${format}`)
			}
			case "image":
				return await extractImage(bytes, mimeType, name, ai, opts)
			case "audio":
			case "video":
				return await withTempDir(async (dir) => {
					const path = join(dir, "recording")
					await writeFile(path, bytes)
					return transcribeRecording(
						path,
						bytes.byteLength,
						mimeType,
						name,
						kind,
						ai,
						{
							ffmpeg: opts.tools.ffmpeg,
							segmentSeconds: opts.audioSegmentSeconds,
							maxRawUploadBytes: opts.maxRawUploadBytes,
							timeoutMs: opts.mediaTimeoutMs,
							extractorTag: tag("transcription"),
						},
					)
				})
			default:
				return fail(`unsupported file type ${mimeType}`)
		}
	} catch (err) {
		// Anything that escapes the per-type handlers is a malformed file.
		return fail(message(err), false)
	}
}

/** Splits long text on paragraph boundaries into parts no longer than max. */
export function splitText(text: string, max: number): string[] {
	if (text.length <= max) return [text]
	const parts: string[] = []
	let current = ""
	for (const para of text.split(/\n{2,}/)) {
		const block = para.length > max ? chunkHard(para, max) : [para]
		for (const piece of block) {
			if (current && current.length + piece.length + 2 > max) {
				parts.push(current)
				current = ""
			}
			current = current ? `${current}\n\n${piece}` : piece
		}
	}
	if (current) parts.push(current)
	return parts
}

function chunkHard(s: string, max: number): string[] {
	const out: string[] = []
	for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max))
	return out
}
