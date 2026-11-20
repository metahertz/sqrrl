// Local media tooling: everything that turns a format the AI endpoint cannot
// take into one it can. All of it ships as npm dependencies, so the host
// needs no system packages (and no root) to run the connector:
//
//   ffmpeg-static    recordings → 16 kHz mono MP3 segments
//   heic-decode      HEIC/HEIF photos → pixels (libheif compiled to wasm)
//   @napi-rs/canvas  pixels → PNG, image downscaling, PDF page rendering

import { execFile } from "node:child_process"
import { randomInt } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import type { getDocumentProxy } from "unpdf"

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>

const run = promisify(execFile)
const require = createRequire(import.meta.url)

/** Resolves the ffmpeg binary: an explicit path wins, "none" disables it,
 *  otherwise the one ffmpeg-static downloaded at install time. */
export function resolveFfmpeg(configured: string): string | null {
	const value = configured.trim()
	if (value.toLowerCase() === "none") return null
	if (value) return existsSync(value) ? value : null
	try {
		const bundled = require("ffmpeg-static") as string | null
		return bundled && existsSync(bundled) ? bundled : null
	} catch {
		return null
	}
}

/** Makes a private temporary directory and always removes it afterwards. */
export async function withTempDir<T>(
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "sqrrl-nextcloud-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

export interface AudioSegment {
	/** Offset of this segment from the start of the recording, in seconds. */
	startSeconds: number
	bytes: Uint8Array
}

/** Re-encodes a recording (audio, or the audio track of a video) to 16 kHz
 *  mono MP3 and cuts it into fixed-length segments.
 *
 *  16 kHz mono is what speech models resample to anyway, so nothing
 *  audible to them is lost; it shrinks an hour of meeting to ~14 MB and a
 *  video to its sound alone. Segmenting keeps every upload under the
 *  transcription endpoint's size limit, however long the recording. */
export async function splitRecording(
	ffmpeg: string,
	inputPath: string,
	segmentSeconds: number,
	timeoutMs: number,
): Promise<AudioSegment[]> {
	return withTempDir(async (dir) => {
		try {
			await run(
				ffmpeg,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-nostdin",
					"-i",
					inputPath,
					"-vn",
					"-ac",
					"1",
					"-ar",
					"16000",
					"-c:a",
					"libmp3lame",
					"-b:a",
					"32k",
					"-f",
					"segment",
					"-segment_time",
					String(segmentSeconds),
					"-reset_timestamps",
					"1",
					join(dir, "part-%04d.mp3"),
				],
				{ timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			)
		} catch (err) {
			const stderr = (err as { stderr?: string }).stderr?.trim()
			throw new Error(
				`ffmpeg could not read the recording${stderr ? `: ${stderr.split("\n").slice(-2).join(" ")}` : ""}`,
			)
		}
		const names = (await readdir(dir)).filter((n) => n.endsWith(".mp3")).sort()
		if (names.length === 0) {
			throw new Error("ffmpeg produced no audio: the file has no audio track")
		}
		const segments: AudioSegment[] = []
		for (const [i, name] of names.entries()) {
			segments.push({
				startSeconds: i * segmentSeconds,
				bytes: new Uint8Array(await readFile(join(dir, name))),
			})
		}
		return segments
	})
}

/** hh:mm:ss, for transcript section markers. */
export function timestamp(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds))
	const hh = String(Math.floor(s / 3600)).padStart(2, "0")
	const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0")
	const ss = String(s % 60).padStart(2, "0")
	return `${hh}:${mm}:${ss}`
}

type Canvas = typeof import("@napi-rs/canvas")

let canvasModule: Promise<Canvas> | null = null
export function loadCanvas(): Promise<Canvas> {
	canvasModule ??= import("@napi-rs/canvas")
	return canvasModule
}

/** Why every image is sent to the vision model as PNG.
 *
 *  Measured 2026-09-16 against qwen3.5-122b (two llama.cpp backends behind
 *  LiteLLM). A solid-red 2048x492 JPEG was described as an unrelated
 *  earlier image ("a solid magenta circle", "a green square") in 3 of 3
 *  requests, and a yellow one in 1 of 3. The same pixels as PNG, or as a
 *  1024-wide JPEG, were correct every time. Each backend returned its own
 *  stale image, which looks like a failed JPEG decode that falls back to the
 *  previous image buffer. Re-encoding a downscaled photo and the banner as
 *  PNG gave 10 of 10 correct. PNG is also the one format every llama.cpp
 *  build decodes (it does not read WebP), so all images are normalized. */
async function encodePng(
	draw: (
		ctx: import("@napi-rs/canvas").SKRSContext2D,
		w: number,
		h: number,
	) => void,
	width: number,
	height: number,
	maxEdge: number,
): Promise<Uint8Array> {
	const { createCanvas } = await loadCanvas()
	const scale = Math.min(1, maxEdge / Math.max(width, height))
	const w = Math.max(1, Math.round(width * scale))
	const h = Math.max(1, Math.round(height * scale))
	const canvas = createCanvas(w, h)
	draw(canvas.getContext("2d"), w, h)
	return new Uint8Array(await canvas.encode("png"))
}

/** Re-encodes any image canvas can decode (JPEG, PNG, WebP, GIF's first
 *  frame) as PNG no larger than maxEdge on its longest side. */
export async function toVisionPng(
	bytes: Uint8Array,
	maxEdge: number,
): Promise<Uint8Array> {
	const { loadImage } = await loadCanvas()
	const img = await loadImage(Buffer.from(bytes))
	return encodePng(
		(ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
		img.width,
		img.height,
		maxEdge,
	)
}

/** Decodes the primary image of a HEIC/HEIF file to PNG no larger than
 *  maxEdge. iPhones save HEIC by default and vision endpoints reject it. */
export async function heicToPng(
	bytes: Uint8Array,
	maxEdge: number,
): Promise<Uint8Array> {
	const decode = require("heic-decode") as (opts: {
		buffer: Uint8Array
	}) => Promise<{
		width: number
		height: number
		data: Uint8ClampedArray | Uint8Array
	}>
	const { width, height, data } = await decode({ buffer: bytes })
	const { createCanvas, ImageData } = await loadCanvas()
	const full = createCanvas(width, height)
	full
		.getContext("2d")
		.putImageData(
			new ImageData(
				new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
				width,
				height,
			),
			0,
			0,
		)
	return encodePng(
		(ctx, w, h) => ctx.drawImage(full, 0, 0, w, h),
		width,
		height,
		maxEdge,
	)
}

// ---------------------------------------------------------------------------
// Verification stamps
// ---------------------------------------------------------------------------

/** Characters a vision model cannot confuse with each other (no 0/O, 1/I,
 *  2/Z, 5/S, 6/G, 8/B). */
const STAMP_ALPHABET = "ACDEFHJKLMNPRTUVWXY3479"
const STAMP_FONT = "SqrrlStamp"
let stampFontReady: boolean | null = null

/** A fresh one-time code to print on an image. */
export function newVerificationCode(length = 6): string {
	return Array.from(
		{ length },
		() => STAMP_ALPHABET[randomInt(STAMP_ALPHABET.length)],
	).join("")
}

/** Registers the bold sans that pdfjs-dist ships, once. This host has no
 *  fonts, and a stamp drawn in a missing font is a blank band. */
export async function ensureStampFont(): Promise<boolean> {
	if (stampFontReady !== null) return stampFontReady
	try {
		const { GlobalFonts } = await loadCanvas()
		const dir = join(
			dirname(require.resolve("pdfjs-dist/package.json")),
			"standard_fonts",
		)
		stampFontReady = Boolean(
			GlobalFonts.registerFromPath(
				join(dir, "LiberationSans-Bold.ttf"),
				STAMP_FONT,
			),
		)
	} catch {
		stampFontReady = false
	}
	return stampFontReady
}

/** Smallest width a stamped image is sent at. Measured on qwen3.5-122b: at
 *  640 px the stamp was read as fragments ("R3MMC" for KR3MMC) because the
 *  vision encoder gives each glyph about one token; the same stamp at 1024 px
 *  and above, or on a small image the server upscales, read back fully. */
export const MIN_STAMPED_WIDTH = 1024

/** Appends a black band reading "VERIFY X X X X X X" below a PNG image,
 *  first scaling the image up to MIN_STAMPED_WIDTH if it is narrower.
 *
 *  The code is the proof that a caption describes this image. On a shared
 *  inference node an answer can be generated from another request's image;
 *  such an answer cannot read this code back. Letters are spaced so they
 *  are read one by one. */
export async function stampImage(
	png: Uint8Array,
	code: string,
): Promise<Uint8Array> {
	if (!(await ensureStampFont())) {
		throw new Error("no font available to draw a verification stamp")
	}
	const { loadImage, createCanvas } = await loadCanvas()
	const img = await loadImage(Buffer.from(png))
	const scale = Math.max(1, MIN_STAMPED_WIDTH / img.width)
	const width = Math.round(img.width * scale)
	const height = Math.round(img.height * scale)
	const band = Math.max(96, Math.round(width * 0.06))
	const canvas = createCanvas(width, height + band)
	const ctx = canvas.getContext("2d")
	ctx.drawImage(img, 0, 0, width, height)
	ctx.fillStyle = "#000"
	ctx.fillRect(0, height, width, band)
	ctx.fillStyle = "#fff"
	ctx.font = `${Math.round(band * 0.6)}px ${STAMP_FONT}`
	ctx.textBaseline = "middle"
	ctx.fillText(
		`VERIFY ${code.split("").join(" ")}`,
		Math.round(band * 0.3),
		height + band / 2,
	)
	return new Uint8Array(await canvas.encode("png"))
}

/** pdf.js options that make rendering work on a host with no system fonts.
 *
 *  Without them pdf.js treats the 14 standard PDF fonts (Helvetica, Times,
 *  Courier, …) as "system" fonts and asks the canvas to draw them by name;
 *  a server with no fonts installed then renders that text as nothing. The
 *  replacement fonts pdfjs-dist ships (Liberation, Foxit) are loaded from
 *  disk instead, so a rendered page keeps any vector text that is not
 *  embedded in the file. */
export function pdfDocumentOptions(): Record<string, unknown> {
	try {
		const dir = dirname(require.resolve("pdfjs-dist/package.json"))
		const fonts = join(dir, "standard_fonts")
		if (!existsSync(fonts)) return {}
		return {
			standardFontDataUrl: `${fonts}/`,
			useSystemFonts: false,
			disableFontFace: true,
		}
	} catch {
		return {}
	}
}

/** Renders one PDF page to PNG, for pages that have no text layer. */
export async function renderPdfPage(
	doc: PDFDocumentProxy,
	pageNumber: number,
	scale: number,
): Promise<Uint8Array> {
	const { renderPageAsImage } = await import("unpdf")
	const png = await renderPageAsImage(doc, pageNumber, {
		canvasImport: loadCanvas,
		scale,
	})
	return new Uint8Array(png)
}

export interface ToolStatus {
	ffmpeg: string | null
	canvas: boolean
	heic: boolean
	/** Standard PDF fonts available for rendering. */
	pdfFonts: boolean
	/** A font to draw verification stamps with. */
	stamps: boolean
}

/** What is actually usable on this host, for the CLI banner and for
 *  deciding which gaps remain. */
export async function probeTools(ffmpegSetting: string): Promise<ToolStatus> {
	let canvas = false
	try {
		const { createCanvas } = await loadCanvas()
		canvas = typeof createCanvas(1, 1).encode === "function"
	} catch {
		canvas = false
	}
	let heic = false
	try {
		require.resolve("heic-decode")
		heic = canvas
	} catch {
		heic = false
	}
	return {
		ffmpeg: resolveFfmpeg(ffmpegSetting),
		canvas,
		heic,
		pdfFonts: "standardFontDataUrl" in pdfDocumentOptions(),
		stamps: canvas && (await ensureStampFont()),
	}
}
