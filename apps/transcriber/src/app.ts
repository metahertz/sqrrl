// OpenAI-compatible transcription API, the subset speech clients use:
//
//   POST /v1/audio/transcriptions   multipart: file, model, response_format,
//                                   language
//   GET  /v1/models
//   GET  /health                    unauthenticated liveness + queue depth
//
// Shaped like OpenAI's endpoint so any client that can talk to Whisper-as-
// a-service (the Nextcloud connector, LiteLLM) can point at this unchanged.

import { timingSafeEqual } from "node:crypto"
import { type Context, Hono } from "hono"
import type { TranscriberConfig } from "./config.js"
import { Backlog } from "./backlog.js"
import { type Decoder, DecodeError, SAMPLE_RATE } from "./decode.js"
import type { Engine, Transcript } from "./engine.js"
import { type JobQueue, QueueFullError, type Reservation } from "./queue.js"
import {
	InvalidBodyError,
	type StagedUpload,
	stageUpload,
	UploadTooLargeError,
} from "./upload.js"

export interface AppDeps {
	config: Pick<
		TranscriberConfig,
		"apiKey" | "modelAliases" | "maxUploadBytes" | "maxJobSeconds" | "tmpDir"
	>
	/** Resolves once the model is loaded; requests wait for it. */
	/** One per worker slot; the queue leases the index. */
	engines: Promise<Engine>[]
	decode: Decoder
	/** Audio seconds from a staged file's header, for the backlog estimate;
	 *  undefined when unknown. Optional: without it lengths are learned only
	 *  once a job is decoded. */
	probe?: (path: string, signal?: AbortSignal) => Promise<number | undefined>
	queue: JobQueue
	log?: (line: string) => void
	/** Clock for job timing; tests substitute their own. */
	now?: () => number
}

/** The job outran TRANSCRIBER_MAX_JOB_SECONDS and was cancelled. */
export class JobTimeoutError extends Error {}
/** The caller disconnected; the job was dropped or cancelled. */
export class ClientGoneError extends Error {}
// Multipart framing around the file part: boundaries, part headers and the
// small form fields. Only used to refuse a declared Content-Length early;
// the file itself is held to maxUploadBytes exactly while it streams in.
const MULTIPART_SLACK = 64 * 1024

const RESPONSE_FORMATS = ["json", "text", "verbose_json", "srt", "vtt"] as const
type ResponseFormat = (typeof RESPONSE_FORMATS)[number]

function error(message: string, type: string, code: string) {
	return { error: { message, type, code } }
}

function bearerMatches(header: string | undefined, key: string): boolean {
	if (!key) return true
	const given = header?.startsWith("Bearer ") ? header.slice(7).trim() : ""
	const a = Buffer.from(given)
	const b = Buffer.from(key)
	return a.length === b.length && timingSafeEqual(a, b)
}

function stamp(seconds: number, sep: "," | "."): string {
	const ms = Math.max(0, Math.round(seconds * 1000))
	const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0")
	const m = String(Math.floor(ms / 60_000) % 60).padStart(2, "0")
	const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0")
	return `${h}:${m}:${s}${sep}${String(ms % 1000).padStart(3, "0")}`
}

export function formatTranscript(
	t: Transcript,
	format: ResponseFormat,
	language: string,
): { body: string; type: string } {
	switch (format) {
		case "text":
			return { body: t.text, type: "text/plain; charset=utf-8" }
		case "verbose_json":
			return {
				body: JSON.stringify({
					task: "transcribe",
					language,
					duration: t.duration,
					text: t.text,
					segments: t.segments.map((s, id) => ({ id, ...s })),
				}),
				type: "application/json",
			}
		case "srt":
			return {
				body: t.segments
					.map(
						(s, i) =>
							`${i + 1}\n${stamp(s.start, ",")} --> ${stamp(s.end, ",")}\n${s.text}\n`,
					)
					.join("\n"),
				type: "text/plain; charset=utf-8",
			}
		case "vtt":
			return {
				body: `WEBVTT\n\n${t.segments
					.map(
						(s) =>
							`${stamp(s.start, ".")} --> ${stamp(s.end, ".")}\n${s.text}\n`,
					)
					.join("\n")}`,
				type: "text/vtt; charset=utf-8",
			}
		default:
			return {
				body: JSON.stringify({ text: t.text }),
				type: "application/json",
			}
	}
}

export function createApp(deps: AppDeps): Hono {
	const { config, queue } = deps
	const log = deps.log ?? ((line: string) => console.error(line))
	const now = deps.now ?? Date.now
	const backlog = new Backlog(now)
	const queueFull = (c: Context, message: string) => {
		c.header("Retry-After", String(backlog.retryAfter()))
		return c.json(error(message, "server_error", "queue_full"), 503)
	}
	const tooLarge = (c: Context) =>
		c.json(
			error(
				`upload exceeds ${config.maxUploadBytes} bytes`,
				"invalid_request_error",
				"file_too_large",
			),
			413,
		)
	const app = new Hono()
	// Ready when every worker is loaded: reporting ready while some are still
	// loading would let a request lease a slot whose engine is not there yet
	// and simply block, which looks like a hang rather than a cold start.
	let ready = false
	Promise.all(deps.engines).then(
		() => {
			ready = true
		},
		() => {},
	)

	app.get("/health", (c) =>
		c.json({
			ok: true,
			service: "sqrrl-transcriber",
			modelReady: ready,
			busy: queue.busy,
			queued: queue.depth,
			workers: queue.concurrency,
			running: queue.running,
			saturated: queue.saturated,
			queueLimit: queue.maxWaiting,
		}),
	)

	app.use("/v1/*", async (c, next) => {
		if (!bearerMatches(c.req.header("Authorization"), config.apiKey)) {
			return c.json(
				error("invalid API key", "invalid_request_error", "invalid_api_key"),
				401,
			)
		}
		await next()
	})

	app.get("/v1/models", (c) =>
		c.json({
			object: "list",
			data: [
				{ id: config.modelAliases[0], object: "model", owned_by: "sqrrl" },
			],
		}),
	)

	app.post("/v1/audio/transcriptions", async (c) => {
		const declared = Number(c.req.header("Content-Length") ?? 0)
		if (declared > config.maxUploadBytes + MULTIPART_SLACK) return tooLarge(c)
		// Take a place in the queue BEFORE reading the body, so an upload the
		// queue could not take anyway is refused without buffering it.
		let reservation: Reservation
		try {
			reservation = queue.reserve()
		} catch (err) {
			if (err instanceof QueueFullError) return queueFull(c, err.message)
			throw err
		}
		try {
			return await transcribe(c, reservation)
		} finally {
			// No-op once the job has used it; frees the place on every early
			// return (bad request, oversize upload, client gone mid-upload).
			reservation.cancel()
		}
	})

	async function transcribe(c: Context, reservation: Reservation) {
		const clientSignal = c.req.raw.signal
		let upload: StagedUpload
		try {
			upload = await stageUpload(c.req.raw, {
				maxFileBytes: config.maxUploadBytes,
				tmpDir: config.tmpDir,
				signal: clientSignal,
			})
		} catch (err) {
			if (err instanceof UploadTooLargeError) return tooLarge(c)
			if (clientSignal.aborted) return clientGone(c, "during upload")
			if (err instanceof InvalidBodyError) {
				return c.json(
					error(
						"expected multipart/form-data",
						"invalid_request_error",
						"invalid_body",
					),
					400,
				)
			}
			throw err
		}
		try {
			return await run(c, reservation, upload)
		} finally {
			// The staged file goes on every path: success, 4xx, 504, abort.
			await upload.cleanup()
		}
	}

	async function run(
		c: Context,
		reservation: Reservation,
		upload: StagedUpload,
	) {
		const clientSignal = c.req.raw.signal
		const { file } = upload
		if (!file) {
			return c.json(
				error("file is required", "invalid_request_error", "missing_file"),
				400,
			)
		}
		const field = (name: string) => upload.fields[name]?.trim() ?? ""
		const model = field("model")
		if (model && !config.modelAliases.includes(model)) {
			// Say so, rather than silently transcribing with a different model
			// than the caller believes it asked for.
			return c.json(
				error(
					`model "${model}" is not served here; use ${config.modelAliases[0]}`,
					"invalid_request_error",
					"model_not_found",
				),
				404,
			)
		}
		const format = (field("response_format") || "json") as ResponseFormat
		if (!RESPONSE_FORMATS.includes(format)) {
			return c.json(
				error(
					`response_format must be one of ${RESPONSE_FORMATS.join(", ")}`,
					"invalid_request_error",
					"invalid_format",
				),
				400,
			)
		}
		const language = field("language")

		// One signal for the whole job: the caller disconnecting, or the job
		// outrunning maxJobSeconds once it has a worker.
		const job = new AbortController()
		const onClientGone = () => job.abort(new ClientGoneError("client gone"))
		if (clientSignal.aborted) onClientGone()
		clientSignal.addEventListener("abort", onClientGone, { once: true })
		const accepted = now()
		let started: number | undefined
		const entry = backlog.add(
			await deps.probe?.(file.path, job.signal).catch(() => undefined),
		)
		let decodedSeconds: number | undefined
		try {
			const transcript = await queue.run(
				async (slot) => {
					started = now()
					backlog.start(entry)
					const timer = setTimeout(
						() =>
							job.abort(
								new JobTimeoutError(
									`transcription exceeded ${config.maxJobSeconds}s and was stopped`,
								),
							),
						config.maxJobSeconds * 1000,
					)
					try {
						const engine = await deps.engines[slot]
						const audio = await deps.decode(file.path, job.signal)
						// The real length, which the header may have misstated.
						decodedSeconds = audio.length / SAMPLE_RATE
						entry.audioSeconds = decodedSeconds
						return await engine.transcribe(audio, {
							...(language ? { language } : {}),
							signal: job.signal,
						})
					} finally {
						clearTimeout(timer)
					}
				},
				{ signal: job.signal, reservation },
			)
			backlog.finish(entry, { audioSeconds: decodedSeconds ?? 0 })
			const ran = now() - (started ?? accepted)
			const secs = ran / 1000
			const waited = ((started ?? accepted) - accepted) / 1000
			log(
				`transcribed ${transcript.duration.toFixed(1)}s of "${file.name}" in ${secs.toFixed(1)}s (${(transcript.duration / Math.max(secs, 0.001)).toFixed(2)}x) after ${waited.toFixed(1)}s queued`,
			)
			const out = formatTranscript(transcript, format, language || "en")
			return c.body(out.body, 200, { "Content-Type": out.type })
		} catch (err) {
			if (job.signal.aborted) {
				const reason = job.signal.reason
				if (reason instanceof JobTimeoutError) {
					log(`"${file.name}": ${reason.message}`)
					return c.json(
						error(reason.message, "server_error", "job_timeout"),
						504,
					)
				}
				return clientGone(
					c,
					`for "${file.name}" ${started === undefined ? "while queued; dropped" : "while running; stopped"}`,
				)
			}
			if (err instanceof QueueFullError) return queueFull(c, err.message)
			if (err instanceof DecodeError) {
				return c.json(
					error(err.message, "invalid_request_error", "invalid_audio"),
					400,
				)
			}
			const message = err instanceof Error ? err.message : String(err)
			log(`transcription failed for "${file.name}": ${message}`)
			return c.json(error(message, "server_error", "transcription_failed"), 500)
		} finally {
			backlog.finish(entry)
			clientSignal.removeEventListener("abort", onClientGone)
		}
	}

	/** Nobody is listening for this response; log and close quietly. 499 is
	 *  nginx's "client closed request", for the access log's sake. */
	function clientGone(_c: Context, detail: string) {
		log(`client went away ${detail}`)
		return new Response(null, { status: 499 })
	}

	return app
}
