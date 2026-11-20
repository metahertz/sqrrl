// Whisper via transformers.js on ONNX Runtime (CPU).
//
// Chosen because it ships prebuilt for this kind of host: no compiler, no
// Python, and a CPU without AVX. Measured on the sqrrl VM (1 vCPU, QEMU,
// SSE4.2 only) against an 11 s speech clip:
//
//   whisper-tiny.en  q8   2.6x realtime   543 MB
//   whisper-base.en  q8   1.4x realtime   726 MB   (default)
//   whisper-small.en q8   0.45x realtime  1.2 GB

import { SAMPLE_RATE } from "./decode.js"

export interface Segment {
	start: number
	end: number
	text: string
}

export interface Transcript {
	text: string
	segments: Segment[]
	/** Seconds of audio transcribed. */
	duration: number
}

export interface TranscribeOptions {
	language?: string
	/** Aborting stops the job at the next decoder step (or before it starts)
	 *  and rejects with the signal's reason. */
	signal?: AbortSignal
	/** Called at every cancellation point just before `signal` is checked.
	 *  For a caller that cannot receive the abort as an event in time: the
	 *  engine worker's event loop is starved while features are extracted,
	 *  so it polls shared memory here and aborts the signal itself. */
	checkpoint?: () => void
}

export interface Engine {
	readonly modelId: string
	transcribe(audio: Float32Array, opts: TranscribeOptions): Promise<Transcript>
}

type AsrOutput = {
	text: string
	chunks?: Array<{ timestamp: [number, number | null]; text: string }>
}
type Asr = (
	audio: Float32Array,
	opts: Record<string, unknown>,
) => Promise<AsrOutput | AsrOutput[]>

export async function loadWhisper(opts: {
	modelId: string
	dtype: string
	cacheDir: string
	threads: number
}): Promise<Engine> {
	const tf = await import("@huggingface/transformers")
	// Weights are fetched into cacheDir on first start and read from there
	// afterwards. This runs once at startup, so no request triggers a download.
	tf.env.cacheDir = opts.cacheDir
	const asr = (await tf.pipeline("automatic-speech-recognition", opts.modelId, {
		dtype: opts.dtype as "q8",
		device: "cpu",
		session_options: {
			intraOpNumThreads: opts.threads,
			interOpNumThreads: 1,
		},
	})) as unknown as Asr
	const englishOnly = opts.modelId.endsWith(".en")
	// Cancellation is cooperative. Killing the thread mid-inference is not an
	// option: onnxruntime-node aborts the whole process when a worker is
	// terminated during a run. generate() hands every decoded token to the
	// streamer, in JS, between ONNX runs; throwing from there once the signal
	// aborts stops the job within one encoder pass plus one decoder step,
	// with no run in flight, and leaves the pipeline usable. (A stopping
	// criterion would be the obvious hook, but Whisper's generate() drops
	// user stopping criteria in transformers.js 4.3.)
	//
	// The second hook covers feature extraction, which transformers.js runs
	// for EVERY 30 s chunk before decoding any of them, without yielding to
	// the event loop: about 57 s for 78 minutes of audio on the VM, which a
	// streamer check alone cannot interrupt. The pipeline calls its
	// processor once per chunk, so wrapping it adds a checkpoint there.
	let checkpoint: (() => void) | undefined
	// A Proxy, not a plain wrapper: the pipeline also reads properties off
	// its processor (feature_extractor.config), which must stay reachable.
	const pipe = asr as unknown as { processor: (...args: unknown[]) => unknown }
	pipe.processor = new Proxy(pipe.processor, {
		apply(target, self, args) {
			checkpoint?.()
			return Reflect.apply(target, self, args)
		},
	})
	const abortStreamer = () => ({
		put() {
			checkpoint?.()
		},
		end() {},
	})
	return {
		modelId: opts.modelId,
		async transcribe(audio, { language, signal, checkpoint: poll }) {
			// One job at a time per engine (the queue leases it whole), so
			// one checkpoint slot is enough.
			checkpoint = () => {
				poll?.()
				signal?.throwIfAborted()
			}
			try {
				return await run(audio, language, signal)
			} finally {
				checkpoint = undefined
			}
		},
	}

	async function run(
		audio: Float32Array,
		language: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<Transcript> {
		checkpoint?.()
		const raw = await asr(audio, {
			...(signal ? { streamer: abortStreamer() } : {}),
			// Whisper's window is 30 s; longer audio is chunked with overlap.
			chunk_length_s: 30,
			stride_length_s: 5,
			return_timestamps: true,
			// English-only checkpoints reject language/task arguments.
			...(englishOnly
				? {}
				: { task: "transcribe", ...(language ? { language } : {}) }),
		})
		// Aborted during the last decoder step: the work is done, but the
		// caller has given up on it, so honor the abort consistently.
		checkpoint?.()
		const out = Array.isArray(raw) ? raw[0] : raw
		const duration = audio.length / SAMPLE_RATE
		const segments = (out.chunks ?? [])
			.map((c) => ({
				start: c.timestamp[0] ?? 0,
				end: c.timestamp[1] ?? duration,
				text: c.text.trim(),
			}))
			.filter((s) => s.text)
		return { text: out.text.trim(), segments, duration }
	}
}
