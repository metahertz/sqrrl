// Probes for cross-request contamination on shared inference nodes.
//
// A node serving several apps (or several requests at once) must answer
// each request from that request's input alone. These probes send inputs
// whose correct answers are known and unique, and check that each answer
// belongs to its own request:
//
//   vision  a synthetic image with a random shape, color and stamped code.
//           Wrong content and code = the answer came from another image.
//           Right code, wrong content = the image was only partly this one.
//           Right content, wrong code = a misread stamp, which is common on
//           this model and is not evidence of contamination. Content is the
//           signal: the model identified shape and color correctly on 8 of
//           8 clean PNG probes.
//   text    concurrent requests, each carrying its own secret phrase to
//           echo. An answer carrying another request's phrase = text state
//           leaked between requests.
//
// Every result names the backend that served it (LiteLLM's
// x-litellm-model-id), so a bad node can be told apart from a good one.

import { randomInt } from "node:crypto"
import {
	checkVerification,
	newVerificationCode,
	stampImage,
	VERIFICATION_INSTRUCTION,
} from "@sqrrl/connector-nextcloud"

export type Fetch = typeof globalThis.fetch

export interface Endpoint {
	baseUrl: string
	apiKey: string
	fetchFn?: Fetch
	/** Merged into every request body (e.g. disabling reasoning). */
	extraBody?: Record<string, unknown>
	timeoutMs?: number
}

export type Verdict =
	| "ok"
	/** The answer was about another request's input. */
	| "cross-request"
	/** The image was described correctly but its stamp was misread: the
	 *  model saw this image, so this is not evidence of contamination. */
	| "stamp-misread"
	/** The stamp was read correctly but the content was wrong: the model
	 *  was given an image that was partly this one and partly another.
	 *  Seen on 2026-09-16 for 8 of 8 2048 px images, where the stamp at the
	 *  bottom came back right and the shape and color above it did not. */
	| "partial-image"
	/** The call failed; says nothing about isolation. */
	| "error"

export interface ProbeResult {
	kind: "vision" | "text"
	model: string
	variant: string
	backend: string
	verdict: Verdict
	detail: string
	ms: number
	/** llama.cpp's count of prompt tokens served from its cache. */
	cacheN?: number
}

export const COLORS = {
	red: "#d01010",
	green: "#10a010",
	blue: "#1030d0",
	yellow: "#e8d010",
	orange: "#f07810",
	purple: "#8020c0",
} as const
export const SHAPES = ["circle", "square", "triangle"] as const
export type Color = keyof typeof COLORS
export type Shape = (typeof SHAPES)[number]

const SHAPE_WORDS: Record<Shape, RegExp> = {
	circle: /\b(circle|circular|round|disc|disk|oval|ellipse)\b/i,
	square: /\b(square|rectangle|rectangular)\b/i,
	triangle: /\b(triangle|triangular)\b/i,
}
const COLOR_WORDS: Record<Color, RegExp> = {
	red: /\b(red|crimson|scarlet)\b/i,
	green: /\bgreen\b/i,
	blue: /\b(blue|navy|royal)\b/i,
	yellow: /\b(yellow|gold|golden)\b/i,
	orange: /\borange\b/i,
	purple: /\b(purple|violet|magenta|indigo)\b/i,
}

export const VISION_TASK =
	"Then answer with exactly one line in this form, and nothing else: Shape: <circle, square or triangle>; Color: <one color name>"

function pick<T>(items: readonly T[]): T {
	return items[randomInt(items.length)]
}

async function drawShape(
	shape: Shape,
	color: Color,
	width: number,
	height: number,
): Promise<Uint8Array> {
	const { createCanvas } = await import("@napi-rs/canvas")
	const canvas = createCanvas(width, height)
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, width, height)
	ctx.fillStyle = COLORS[color]
	const r = Math.min(width, height) * 0.35
	const cx = width / 2
	const cy = height / 2
	ctx.beginPath()
	if (shape === "circle") ctx.arc(cx, cy, r, 0, Math.PI * 2)
	else if (shape === "square") ctx.rect(cx - r, cy - r, 2 * r, 2 * r)
	else {
		ctx.moveTo(cx, cy - r)
		ctx.lineTo(cx + r, cy + r)
		ctx.lineTo(cx - r, cy + r)
		ctx.closePath()
	}
	ctx.fill()
	return new Uint8Array(await canvas.encode("png"))
}

async function post(
	ep: Endpoint,
	body: Record<string, unknown>,
): Promise<{ content: string; backend: string; cacheN?: number; ms: number }> {
	const started = Date.now()
	const res = await (ep.fetchFn ?? globalThis.fetch)(
		`${ep.baseUrl}/chat/completions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ep.apiKey}`,
			},
			body: JSON.stringify({ ...body, ...(ep.extraBody ?? {}) }),
			signal: AbortSignal.timeout(ep.timeoutMs ?? 300_000),
		},
	)
	const backend =
		res.headers.get("x-litellm-model-id") ??
		res.headers.get("x-litellm-model-api-base") ??
		"unknown"
	if (!res.ok) {
		throw Object.assign(
			new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`),
			{ backend },
		)
	}
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string | null } }>
		timings?: { cache_n?: number }
	}
	return {
		content: json.choices?.[0]?.message?.content ?? "",
		backend,
		cacheN: json.timings?.cache_n,
		ms: Date.now() - started,
	}
}

/** The code an answer gives on its "Verification:" line, if any. */
export function readVerificationCode(answer: string): string | null {
	const line = answer
		.split("\n")
		.slice(0, 3)
		.find((l) => /^\W*verification\W*:/i.test(l.trim()))
	if (!line) return null
	const read = line
		.replace(/^\W*verification\W*:/i, "")
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
	return read || null
}

const PLACEHOLDERS = new Set(["ABC123", "A1B2C3", "XXXXXX", "QWERTY"])

/** Codes a model writes when it cannot read the stamp ("123456", "ABCDEF",
 *  "AAAAAA"). Two requests giving one is chance, not a leak. */
export function isPlaceholderCode(code: string): boolean {
	if (PLACEHOLDERS.has(code) || /^(.)\1+$/.test(code)) return true
	const steps = new Set(
		[...code].slice(1).map((c, i) => c.charCodeAt(0) - code.charCodeAt(i)),
	)
	return steps.size === 1 && [...steps].every((d) => Math.abs(d) === 1)
}

/** Judges one vision answer against what the image really showed.
 *
 *  Content is the primary signal: the chance that another request's image
 *  happens to have this request's shape and color is 1 in 18, while stamp
 *  reading on its own misfires on small or busy images.
 *
 *  `previous` holds the codes stamped on, and read back from, the previous
 *  probe served by the same backend. An answer that gives one of them
 *  carries that request's input or output: seen 2026-09-16 on 1536x768
 *  probes, which described their own shape and color but repeated, exactly,
 *  the code the model had invented for the request before on that node (4
 *  of 4 non-placeholder misreads). Only the immediately previous request on
 *  the same node counts, because the model has favorite invented codes:
 *  "7X9K2M" came back three times from both nodes, non-adjacent, on
 *  512-token probes. */
export function judgeVision(
	answer: string,
	code: string,
	shape: Shape,
	color: Color,
	previous: ReadonlySet<string> = new Set(),
): { verdict: Verdict; detail: string } {
	const read = readVerificationCode(answer)
	if (
		read &&
		read !== code.toUpperCase() &&
		previous.has(read) &&
		!isPlaceholderCode(read)
	) {
		return {
			verdict: "cross-request",
			detail: `stamp ${code} answered with ${read} from the previous request on this backend: ${answer.replace(/\s+/g, " ").slice(0, 120)}`,
		}
	}
	const verified = checkVerification(answer, code)
	const body = verified ?? answer
	const contentOk =
		SHAPE_WORDS[shape].test(body) && COLOR_WORDS[color].test(body)
	const flat = answer.replace(/\s+/g, " ").slice(0, 120)
	if (verified !== null) {
		return { verdict: contentOk ? "ok" : "partial-image", detail: flat }
	}
	return contentOk
		? { verdict: "stamp-misread", detail: `stamp ${code} misread: ${flat}` }
		: {
				verdict: "cross-request",
				detail: `expected ${color} ${shape} with stamp ${code}: ${flat}`,
			}
}

export interface VisionSize {
	/** Size of the drawn shape; the stamp band is added below it. */
	width: number
	height: number
	format?: "png" | "jpeg"
}

/** 1024x416 plus the 96 px stamp band is 1024x512: 512 image tokens, one
 *  default llama.cpp micro-batch. Images larger than a micro-batch were
 *  answered with the previous request's state until the qwen3.5-122b nodes
 *  got --ubatch-size 2048 on 2026-09-16, so also probe a larger size (e.g.
 *  2048x928) to catch that coming back. */
export const DEFAULT_VISION_SIZE: VisionSize = { width: 1024, height: 416 }

export function parseSizes(raw: string): VisionSize[] {
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.map((s) => {
			const m = /^(\d+)x(\d+)(?::(png|jpeg))?$/.exec(s)
			if (!m) throw new Error(`bad size "${s}": expected WxH or WxH:jpeg`)
			return {
				width: Number(m[1]),
				height: Number(m[2]),
				format: (m[3] ?? "png") as "png" | "jpeg",
			}
		})
}

function pngDimensions(png: Uint8Array): { width: number; height: number } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** One vision probe, sent at the requested size plus the stamp band. */
export async function visionProbe(
	ep: Endpoint,
	model: string,
	size: VisionSize = DEFAULT_VISION_SIZE,
	/** Per backend, the codes stamped on and read back from the last probe
	 *  it served; updated by this probe. */
	history: Map<string, Set<string>> = new Map(),
): Promise<ProbeResult> {
	const { width, height } = size
	const format = size.format ?? "png"
	const shape = pick(SHAPES)
	const color = pick(Object.keys(COLORS) as Color[])
	const code = newVerificationCode()
	// The stamp is drawn on the PNG; the JPEG variant re-encodes the stamped
	// result, so both variants carry the code.
	let image = await stampImage(
		await drawShape(shape, color, width, height),
		code,
	)
	const sent = pngDimensions(image)
	let mime = "image/png"
	if (format === "jpeg") {
		const { loadImage, createCanvas } = await import("@napi-rs/canvas")
		const img = await loadImage(Buffer.from(image))
		const canvas = createCanvas(img.width, img.height)
		canvas.getContext("2d").drawImage(img, 0, 0)
		image = new Uint8Array(await canvas.encode("jpeg", 85))
		mime = "image/jpeg"
	}
	// llama.cpp spends one image token per 32x32 px on this model family.
	const tokens = Math.round((sent.width * sent.height) / 1024)
	const variant = `${format} ${sent.width}x${sent.height} ~${tokens}tok ${color} ${shape}`
	const base = { kind: "vision" as const, model, variant }
	try {
		const r = await post(ep, {
			model,
			max_tokens: 120,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `${VERIFICATION_INSTRUCTION}\n${VISION_TASK}`,
						},
						{
							type: "image_url",
							image_url: {
								url: `data:${mime};base64,${Buffer.from(image).toString("base64")}`,
							},
						},
					],
				},
			],
		})
		const judged = judgeVision(
			r.content,
			code,
			shape,
			color,
			history.get(r.backend),
		)
		const read = readVerificationCode(r.content)
		history.set(r.backend, new Set(read ? [code, read] : [code]))
		return {
			...base,
			backend: r.backend,
			ms: r.ms,
			cacheN: r.cacheN,
			...judged,
		}
	} catch (err) {
		return {
			...base,
			backend: (err as { backend?: string }).backend ?? "unknown",
			verdict: "error",
			detail: err instanceof Error ? err.message : String(err),
			ms: 0,
		}
	}
}

const WORDS = [
	"amber",
	"basalt",
	"cobalt",
	"delta",
	"ember",
	"fjord",
	"garnet",
	"harbor",
	"indigo",
	"juniper",
	"kelp",
	"lichen",
	"maple",
	"nimbus",
	"onyx",
	"pollen",
	"quartz",
	"raven",
	"saffron",
	"tundra",
]

export function secretPhrase(): string {
	return `${pick(WORDS)}-${pick(WORDS)}-${randomInt(1000, 10000)}`
}

/** Fires `concurrency` text requests at once, each with its own secret, and
 *  checks every answer echoes only its own. */
export async function textProbe(
	ep: Endpoint,
	model: string,
	concurrency: number,
): Promise<ProbeResult[]> {
	const secrets = Array.from({ length: concurrency }, () => secretPhrase())
	return Promise.all(
		secrets.map(async (secret) => {
			const base = {
				kind: "text" as const,
				model,
				variant: `concurrent x${concurrency}`,
			}
			try {
				const r = await post(ep, {
					model,
					max_tokens: 30,
					messages: [
						{
							role: "system",
							content:
								"You repeat codes exactly. Output only the code you are given, with no other words.",
						},
						{ role: "user", content: `Code: ${secret}\nRepeat the code.` },
					],
				})
				const common = {
					...base,
					backend: r.backend,
					ms: r.ms,
					cacheN: r.cacheN,
				}
				const others = secrets.filter(
					(s) => s !== secret && r.content.includes(s),
				)
				if (others.length > 0) {
					return {
						...common,
						verdict: "cross-request" as const,
						detail: `answer carried another request's code: ${others.join(", ")}`,
					}
				}
				return r.content.includes(secret)
					? { ...common, verdict: "ok" as const, detail: secret }
					: {
							...common,
							verdict: "error" as const,
							detail: `answer did not contain the code: expected ${secret}, got ${r.content.trim().slice(0, 80)}`,
						}
			} catch (err) {
				return {
					...base,
					backend: (err as { backend?: string }).backend ?? "unknown",
					verdict: "error" as const,
					detail: err instanceof Error ? err.message : String(err),
					ms: 0,
				}
			}
		}),
	)
}

export interface Summary {
	at: string
	results: ProbeResult[]
	byBackend: Record<string, Record<Verdict, number>>
	/** True when any answer was built, wholly or partly, from another
	 *  request's input. */
	contaminated: boolean
}

export function summarize(results: ProbeResult[], at = new Date()): Summary {
	const byBackend: Summary["byBackend"] = {}
	for (const r of results) {
		const key = `${r.model} @ ${r.backend}`
		byBackend[key] ??= {
			ok: 0,
			"cross-request": 0,
			"stamp-misread": 0,
			"partial-image": 0,
			error: 0,
		}
		byBackend[key][r.verdict]++
	}
	return {
		at: at.toISOString(),
		results,
		byBackend,
		contaminated: results.some(
			(r) => r.verdict === "cross-request" || r.verdict === "partial-image",
		),
	}
}
