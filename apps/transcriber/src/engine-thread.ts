// An Engine that runs on its own worker thread.
//
// ONNX Runtime runs inference on native threads, but transformers.js does the
// rest of a job in JavaScript: the log-mel spectrogram, the token-by-token
// decode loop, logits processing and timestamp stitching. With every engine in
// one process those all share the main thread, so on the 6-vCPU VM three
// "concurrent" jobs pinned the main thread at 100%, left the machine ~60% idle,
// and finished no sooner than the same three run back to back. One thread per
// engine gives each its own event loop, so the pool actually runs in parallel.

import { Worker } from "node:worker_threads"
import type { Engine, Transcript } from "./engine.js"

export type WorkerRequest =
	| {
			type: "run"
			id: number
			audio: Float32Array
			opts: { language?: string }
	  }
	/** Stop job `id` at its next decoder step. The thread is never killed
	 *  mid-job: onnxruntime-node aborts the whole process if a worker is
	 *  terminated during a run (see engine.ts). */
	| { type: "cancel"; id: number }
export type WorkerReply =
	| { type: "ready" }
	| { type: "load-failed"; message: string }
	| { type: "done"; id: number; transcript: Transcript }
	| { type: "failed"; id: number; message: string; aborted?: boolean }

/** The parts of a Worker this module uses; tests substitute a fake. */
export type EngineWorker = Pick<Worker, "on" | "postMessage" | "terminate">

// Built, the entry is plain .js. Run from source under tsx, `--import tsx` in
// the inherited execArgv does not take effect in the worker: Node 22's own
// type stripping loads the .ts entry, then fails on its ".js" imports. So the
// worker registers tsx itself before importing the entry.
function spawnEngineWorker(workerData: unknown): Worker {
	if (!import.meta.url.endsWith(".ts")) {
		return new Worker(new URL("./engine-worker.js", import.meta.url), {
			workerData,
		})
	}
	const tsx = import.meta.resolve("tsx/esm/api")
	const entry = new URL("./engine-worker.ts", import.meta.url).href
	const boot = `import(${JSON.stringify(tsx)}).then((m) => { m.register(); return import(${JSON.stringify(entry)}) })`
	return new Worker(boot, { eval: true, workerData })
}

type Pending = {
	resolve: (t: Transcript) => void
	reject: (e: unknown) => void
	signal?: AbortSignal
}

export function loadWhisperThread(
	opts: {
		modelId: string
		dtype: string
		cacheDir: string
		threads: number
	},
	onCrash?: (err: Error) => void,
	spawn: (workerData: unknown) => EngineWorker = spawnEngineWorker,
): Promise<Engine> {
	// Shared with the worker: the id + 1 of a job to stop. See engine-worker.ts.
	const cancel = new Int32Array(new SharedArrayBuffer(4))
	const worker = spawn({ ...opts, cancel })
	const pending = new Map<number, Pending>()
	let nextId = 0
	let dead: Error | undefined

	return new Promise<Engine>((resolveLoad, rejectLoad) => {
		let loaded = false
		const fail = (err: Error) => {
			if (dead) return
			dead = err
			rejectLoad(err)
			for (const p of pending.values()) p.reject(err)
			pending.clear()
			void worker.terminate()
			if (loaded) onCrash?.(err)
		}
		worker.on("error", fail)
		worker.on("exit", (code) =>
			fail(new Error(`transcription worker exited (code ${code})`)),
		)
		worker.on("message", (msg: WorkerReply) => {
			if (msg.type === "ready") {
				loaded = true
				resolveLoad(engine)
			} else if (msg.type === "load-failed") {
				fail(new Error(msg.message))
			} else {
				const p = pending.get(msg.id)
				pending.delete(msg.id)
				if (!p) return
				// A job whose caller gave up rejects with the caller's reason,
				// even if it happened to finish first.
				if (p.signal?.aborted) p.reject(p.signal.reason)
				else if (msg.type === "done") p.resolve(msg.transcript)
				else p.reject(new Error(msg.message))
			}
		})

		const post = (msg: WorkerRequest, transfer?: ArrayBuffer[]) =>
			worker.postMessage(msg, transfer)
		const engine: Engine = {
			modelId: opts.modelId,
			transcribe(audio, { signal, ...transcribeOpts }) {
				if (dead) return Promise.reject(dead)
				if (signal?.aborted) return Promise.reject(signal.reason)
				const id = nextId++
				return new Promise<Transcript>((resolve, reject) => {
					// The promise settles only when the thread replies, so the
					// queue slot stays leased until the engine is really free.
					const onAbort = () => {
						if (!pending.has(id)) return
						Atomics.store(cancel, 0, id + 1)
						post({ type: "cancel", id })
					}
					const settle =
						<T>(fn: (v: T) => void) =>
						(v: T) => {
							signal?.removeEventListener("abort", onAbort)
							fn(v)
						}
					pending.set(id, {
						resolve: settle(resolve),
						reject: settle(reject),
						signal,
					})
					signal?.addEventListener("abort", onAbort, { once: true })
					// Transfer, not copy: the caller is done with the samples.
					post({ type: "run", id, audio, opts: transcribeOpts }, [
						audio.buffer as ArrayBuffer,
					])
				})
			},
		}
	})
}
