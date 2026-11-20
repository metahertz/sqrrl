// Worker-thread entry: owns one Whisper engine and runs jobs posted to it.
// See engine-thread.ts for why each engine lives on its own thread.

import { parentPort, workerData } from "node:worker_threads"
import { loadWhisper } from "./engine.js"
import type { WorkerReply, WorkerRequest } from "./engine-thread.js"

const port = parentPort
if (!port) throw new Error("engine-worker must run in a worker thread")

const reply = (msg: WorkerReply) => port.postMessage(msg)

// Written by the main thread when it cancels a job: that job's id + 1. Read
// synchronously at each checkpoint, because a cancel MESSAGE cannot arrive
// while feature extraction is hogging this thread's event loop.
const cancelled: Int32Array = workerData.cancel

loadWhisper(workerData).then(
	(engine) => {
		reply({ type: "ready" })
		const running = new Map<number, AbortController>()
		port.on("message", (req: WorkerRequest) => {
			if (req.type === "cancel") {
				running.get(req.id)?.abort(new Error("cancelled"))
				return
			}
			const ac = new AbortController()
			running.set(req.id, ac)
			engine
				.transcribe(req.audio, {
					...req.opts,
					signal: ac.signal,
					checkpoint: () => {
						if (Atomics.load(cancelled, 0) === req.id + 1) {
							ac.abort(new Error("cancelled"))
						}
					},
				})
				.then(
					(transcript) => reply({ type: "done", id: req.id, transcript }),
					(err: unknown) =>
						reply({
							type: "failed",
							id: req.id,
							message: err instanceof Error ? err.message : String(err),
							aborted: ac.signal.aborted,
						}),
				)
				.finally(() => running.delete(req.id))
		})
	},
	(err: unknown) =>
		reply({
			type: "load-failed",
			message: err instanceof Error ? err.message : String(err),
		}),
)
