// Shared fixtures for the app tests: an app wired to fake engines and
// decoders, upload builders, and gate/flush helpers so tests wait on
// conditions they control rather than on the clock.

import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app.js"
import type { Decoder } from "./decode.js"
import type { Engine } from "./engine.js"
import { JobQueue } from "./queue.js"

export const KEY = "tx-test-key"

/** Default scratch directory for apps built here, so tests can check that
 *  nothing is left behind. */
export const scratch = mkdtempSync(join(tmpdir(), "tx-app-test-"))

/** "Decodes" by turning the upload's bytes into samples, so every request's
 *  audio is distinguishable. */
export const echoDecode: Decoder = async (input) =>
	Float32Array.from(
		typeof input === "string" ? new Uint8Array(await readFile(input)) : input,
		(b) => b / 255,
	)

/** Transcribes by fingerprinting the samples it was given. */
export function fingerprintEngine(delayMs = 0): Engine {
	return {
		modelId: "onnx-community/whisper-base.en",
		async transcribe(audio) {
			await new Promise((r) => setTimeout(r, delayMs))
			const digest = createHash("sha256")
				.update(new Uint8Array(audio.buffer))
				.digest("hex")
				.slice(0, 12)
			return {
				text: `heard ${digest}`,
				duration: audio.length / 16000,
				segments: [{ start: 0, end: 1.5, text: `heard ${digest}` }],
			}
		},
	}
}

export function app(
	over: {
		engine?: Engine
		decode?: Decoder
		queue?: JobQueue
		log?: (line: string) => void
		now?: () => number
		maxJobSeconds?: number
		probe?: (path: string) => Promise<number | undefined>
		tmpDir?: string
	} = {},
) {
	const queue = over.queue ?? new JobQueue(4)
	const engine = Promise.resolve(over.engine ?? fingerprintEngine())
	return createApp({
		config: {
			apiKey: KEY,
			modelAliases: [
				"whisper-base.en",
				"onnx-community/whisper-base.en",
				"whisper-1",
			],
			maxUploadBytes: 1024,
			maxJobSeconds: over.maxJobSeconds ?? 600,
			tmpDir: over.tmpDir ?? scratch,
		},
		engines: Array.from({ length: queue.concurrency }, () => engine),
		decode: over.decode ?? echoDecode,
		queue,
		log: over.log ?? (() => {}),
		now: over.now,
		probe: over.probe,
	})
}

export interface Gate<T = void> {
	promise: Promise<T>
	open: (value: T) => void
}

export function gate<T = void>(): Gate<T> {
	let open!: (value: T) => void
	const promise = new Promise<T>((r) => {
		open = r
	})
	return { promise, open }
}

/** Lets every pending callback run; no wall-clock wait involved. */
export const flush = () => new Promise<void>((r) => setImmediate(r))

/** Yields until `cond` holds. Bounded by the test timeout, not a clock. */
export async function until(cond: () => boolean) {
	while (!cond()) await flush()
}

/** An engine that announces each job and holds it until released, or until
 *  the job's signal aborts (then rejects with the reason, as the real
 *  engine does). */
export function heldEngine() {
	const started: Array<{ release: () => void; signal?: AbortSignal }> = []
	const engine: Engine = {
		modelId: "m",
		transcribe(audio, { signal }) {
			return new Promise((resolve, reject) => {
				const done = () =>
					resolve({ text: "done", duration: audio.length, segments: [] })
				started.push({ release: done, signal })
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				})
			})
		},
	}
	return { engine, started }
}

/** A multipart upload streamed with no Content-Length, `total` bytes of
 *  file content in 16 KiB chunks, counting how much was actually pulled. */
export function chunkedUpload(total: number): {
	req: Request
	readonly pulls: number
	readonly sent: number
} {
	const boundary = "----tx-test"
	const enc = new TextEncoder()
	const head = enc.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
	)
	const tail = enc.encode(`\r\n--${boundary}--\r\n`)
	let sent = 0
	let headSent = false
	let pulls = 0
	const body = new ReadableStream<Uint8Array>(
		{
			pull(ctl) {
				pulls++
				if (!headSent) {
					headSent = true
					ctl.enqueue(head)
				} else if (sent < total) {
					const n = Math.min(16 * 1024, total - sent)
					sent += n
					ctl.enqueue(new Uint8Array(n).fill(7))
				} else {
					ctl.enqueue(tail)
					ctl.close()
				}
			},
		},
		{ highWaterMark: 0 },
	)
	const req = new Request("http://t/v1/audio/transcriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${KEY}`,
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		},
		body,
		duplex: "half",
	} as RequestInit)
	return {
		req,
		get pulls() {
			return pulls
		},
		get sent() {
			return sent
		},
	}
}

export function upload(
	bytes: Uint8Array,
	fields: Record<string, string> = {},
	key = KEY,
): Request {
	const form = new FormData()
	form.set("file", new Blob([bytes], { type: "audio/mpeg" }), "clip.mp3")
	for (const [k, v] of Object.entries(fields)) form.set(k, v)
	return new Request("http://t/v1/audio/transcriptions", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}` },
		body: form,
	})
}

export const fingerprint = (bytes: Uint8Array) =>
	createHash("sha256")
		.update(new Uint8Array(Float32Array.from(bytes, (b) => b / 255).buffer))
		.digest("hex")
		.slice(0, 12)
