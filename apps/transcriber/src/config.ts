// Transcriber configuration from the environment.

import { statSync } from "node:fs"
import { tmpdir } from "node:os"

export interface TranscriberConfig {
	host: string
	port: number
	/** Bearer token callers must present. Required unless bound to loopback
	 *  and TRANSCRIBER_ALLOW_NO_AUTH=1. */
	apiKey: string
	/** Hugging Face model id of an ONNX Whisper export. */
	modelId: string
	/** Weight precision; q8 is the practical choice on CPU. */
	dtype: "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4"
	/** Names callers may send as `model`. The first is the advertised id. */
	modelAliases: string[]
	/** Where model files are downloaded and cached. */
	cacheDir: string
	/** Largest upload accepted. */
	maxUploadBytes: number
	/** Requests waiting behind the one in progress before new ones get 503. */
	maxQueue: number
	/** Longest decoded audio accepted, in seconds. */
	maxAudioSeconds: number
	/** Longest a job may run once it has a worker (decode + transcription),
	 *  in seconds. A job past it is cancelled and its caller gets 504. Queue
	 *  wait does not count. */
	maxJobSeconds: number
	ffmpegPath: string
	/** Scratch space for staged uploads and decoded samples. Must be
	 *  disk-backed: on a tmpfs /tmp, scratch files are RAM charged to the
	 *  service's own memory limit, which is what streaming uploads to disk
	 *  is meant to avoid. */
	tmpDir: string
	/** ONNX Runtime intra-op threads PER WORKER; defaults to the cores each
	 *  worker gets, so the pool partitions the CPU instead of oversubscribing
	 *  it. */
	threads: number
	/** Concurrent transcription workers.
	 *
	 *  Defaults to half the cores, capped at 4 — half because Whisper still
	 *  scales somewhat within a job, so two threads per worker beats one, and
	 *  capped because each worker holds its OWN copy of the model weights
	 *  (~726 MB for whisper-base.en q8, ~1.2 GB for small.en). Four workers is
	 *  already ~3 GB resident, so raising this means raising MemoryMax on the
	 *  unit to match or the pool gets OOM-killed mid-job.
	 *
	 *  On a single-core host this is 1, which is exactly the old serial
	 *  behaviour — a pool cannot conjure parallelism out of one core. */
	workers: number
}

export class ConfigError extends Error {}

/** /var/tmp where it exists: by convention disk-backed, where /tmp is often
 *  tmpfs (it is on the sqrrl VM). */
function defaultTmpDir(): string {
	try {
		if (statSync("/var/tmp").isDirectory()) return "/var/tmp"
	} catch {}
	return tmpdir()
}

function num(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined || raw.trim() === "") return fallback
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) {
		throw new ConfigError(`${name} must be a positive number, got "${raw}"`)
	}
	return Math.floor(n)
}

const DTYPES = ["fp32", "fp16", "q8", "int8", "uint8", "q4"] as const

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	cpus = 1,
): TranscriberConfig {
	const host = env.TRANSCRIBER_HOST?.trim() || "127.0.0.1"
	const apiKey = env.TRANSCRIBER_API_KEY?.trim() ?? ""
	const loopback =
		host === "127.0.0.1" || host === "::1" || host === "localhost"
	if (!apiKey && !(loopback && env.TRANSCRIBER_ALLOW_NO_AUTH === "1")) {
		throw new ConfigError(
			"TRANSCRIBER_API_KEY is required (TRANSCRIBER_ALLOW_NO_AUTH=1 is accepted only on a loopback host)",
		)
	}
	const modelId =
		env.TRANSCRIBER_MODEL?.trim() || "onnx-community/whisper-base.en"
	const dtype = (env.TRANSCRIBER_DTYPE?.trim() ||
		"q8") as TranscriberConfig["dtype"]
	if (!DTYPES.includes(dtype)) {
		throw new ConfigError(
			`TRANSCRIBER_DTYPE must be one of ${DTYPES.join("|")}`,
		)
	}
	// Resolved before threads, which is expressed per worker.
	const workers = num(
		env.TRANSCRIBER_WORKERS,
		Math.max(1, Math.min(4, Math.floor(cpus / 2))),
		"TRANSCRIBER_WORKERS",
	)
	const shortName = modelId.split("/").pop() ?? modelId
	const aliases = (env.TRANSCRIBER_MODEL_ALIASES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
	return {
		host,
		port: num(env.TRANSCRIBER_PORT, 3960, "TRANSCRIBER_PORT"),
		apiKey,
		modelId,
		dtype,
		modelAliases: [...new Set([shortName, modelId, ...aliases])],
		cacheDir: env.TRANSCRIBER_CACHE_DIR?.trim() || "./models",
		maxUploadBytes: num(
			env.TRANSCRIBER_MAX_UPLOAD_BYTES,
			200 * 1024 * 1024,
			"TRANSCRIBER_MAX_UPLOAD_BYTES",
		),
		maxQueue: num(env.TRANSCRIBER_MAX_QUEUE, 8, "TRANSCRIBER_MAX_QUEUE"),
		maxAudioSeconds: num(
			env.TRANSCRIBER_MAX_AUDIO_SECONDS,
			3 * 60 * 60,
			"TRANSCRIBER_MAX_AUDIO_SECONDS",
		),
		// 30 minutes: well past a normal job (the Nextcloud connector gives a
		// segment 10 minutes end to end) but bounding a runaway one.
		maxJobSeconds: num(
			env.TRANSCRIBER_MAX_JOB_SECONDS,
			30 * 60,
			"TRANSCRIBER_MAX_JOB_SECONDS",
		),
		tmpDir: env.TRANSCRIBER_TMP_DIR?.trim() || defaultTmpDir(),
		ffmpegPath: env.TRANSCRIBER_FFMPEG_PATH?.trim() ?? "",
		threads: num(
			env.TRANSCRIBER_THREADS,
			Math.max(1, Math.floor(cpus / workers)),
			"TRANSCRIBER_THREADS",
		),
		workers,
	}
}
