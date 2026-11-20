import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type { Transcript } from "./engine.js"
import {
	type EngineWorker,
	loadWhisperThread,
	type WorkerReply,
	type WorkerRequest,
} from "./engine-thread.js"

// A stand-in for the engine thread: records what it is sent and replies only
// when the test says so, so every step is explicit.
class FakeWorker extends EventEmitter {
	sent: WorkerRequest[] = []
	terminated = false
	postMessage(msg: WorkerRequest) {
		this.sent.push(msg)
	}
	async terminate() {
		this.terminated = true
		return 0
	}
	reply(msg: WorkerReply) {
		this.emit("message", msg)
	}
}

const opts = { modelId: "m", dtype: "q8", cacheDir: "/tmp", threads: 1 }
const transcript: Transcript = { text: "hi", segments: [], duration: 1 }

async function load(onCrash?: (err: Error) => void) {
	const worker = new FakeWorker()
	let data: { cancel: Int32Array } | undefined
	const loading = loadWhisperThread(opts, onCrash, (workerData) => {
		data = workerData as { cancel: Int32Array }
		return worker as unknown as EngineWorker
	})
	worker.reply({ type: "ready" })
	const engine = await loading
	return { worker, engine, cancelFlag: data?.cancel as Int32Array }
}

const runs = (w: FakeWorker) => w.sent.filter((m) => m.type === "run")
const cancels = (w: FakeWorker) => w.sent.filter((m) => m.type === "cancel")

describe("engine thread", () => {
	it("runs a job and resolves with the thread's transcript", async () => {
		const { worker, engine } = await load()
		const job = engine.transcribe(new Float32Array(4), { language: "en" })
		const [run] = runs(worker)
		expect(run).toMatchObject({ type: "run", opts: { language: "en" } })
		worker.reply({ type: "done", id: run.id, transcript })
		await expect(job).resolves.toEqual(transcript)
	})

	it("asks the thread to cancel on abort, and settles only when it confirms", async () => {
		const { worker, engine } = await load()
		const ac = new AbortController()
		let settled = false
		const job = engine.transcribe(new Float32Array(4), { signal: ac.signal })
		job
			.catch(() => {})
			.finally(() => {
				settled = true
			})
		const [run] = runs(worker)
		ac.abort(new Error("client gone"))
		expect(cancels(worker)).toEqual([{ type: "cancel", id: run.id }])
		// Still pending: the thread is still busy until it says otherwise, so
		// the queue slot must stay leased.
		await new Promise<void>((r) => setImmediate(r))
		expect(settled).toBe(false)
		worker.reply({
			type: "failed",
			id: run.id,
			message: "cancelled",
			aborted: true,
		})
		await expect(job).rejects.toThrow("client gone")
		// Never killed: terminating mid-run takes the whole process down.
		expect(worker.terminated).toBe(false)
	})

	it("also flags the cancel in shared memory, for a thread too busy for messages", async () => {
		const { worker, engine, cancelFlag } = await load()
		expect(cancelFlag.buffer).toBeInstanceOf(SharedArrayBuffer)
		const first = engine.transcribe(new Float32Array(4), {})
		worker.reply({ type: "done", id: runs(worker)[0].id, transcript })
		await first
		const ac = new AbortController()
		const job = engine.transcribe(new Float32Array(4), { signal: ac.signal })
		const { id } = runs(worker)[1]
		expect(Atomics.load(cancelFlag, 0)).toBe(0)
		ac.abort(new Error("gone"))
		// id + 1, so job 0 is distinguishable from "nothing cancelled".
		expect(Atomics.load(cancelFlag, 0)).toBe(id + 1)
		worker.reply({ type: "failed", id, message: "cancelled", aborted: true })
		await expect(job).rejects.toThrow("gone")
	})

	it("stays usable after a cancelled job", async () => {
		const { worker, engine } = await load()
		const ac = new AbortController()
		const first = engine.transcribe(new Float32Array(4), { signal: ac.signal })
		ac.abort(new Error("timeout"))
		worker.reply({
			type: "failed",
			id: runs(worker)[0].id,
			message: "cancelled",
			aborted: true,
		})
		await expect(first).rejects.toThrow("timeout")
		const second = engine.transcribe(new Float32Array(4), {})
		worker.reply({ type: "done", id: runs(worker)[1].id, transcript })
		await expect(second).resolves.toEqual(transcript)
	})

	it("rejects with the abort reason even if the job finished first", async () => {
		const { worker, engine } = await load()
		const ac = new AbortController()
		const job = engine.transcribe(new Float32Array(4), { signal: ac.signal })
		ac.abort(new Error("gone"))
		worker.reply({ type: "done", id: runs(worker)[0].id, transcript })
		await expect(job).rejects.toThrow("gone")
	})

	it("never posts a job whose signal is already aborted", async () => {
		const { worker, engine } = await load()
		const ac = new AbortController()
		ac.abort(new Error("gone"))
		await expect(
			engine.transcribe(new Float32Array(4), { signal: ac.signal }),
		).rejects.toThrow("gone")
		expect(worker.sent).toEqual([])
	})

	it("does not send a cancel for a job that already finished", async () => {
		const { worker, engine } = await load()
		const ac = new AbortController()
		const job = engine.transcribe(new Float32Array(4), { signal: ac.signal })
		worker.reply({ type: "done", id: runs(worker)[0].id, transcript })
		await job
		ac.abort(new Error("late"))
		expect(cancels(worker)).toEqual([])
	})

	it("still reports a crash after load", async () => {
		const crashes: Error[] = []
		const { worker, engine } = await load((err) => crashes.push(err))
		const job = engine.transcribe(new Float32Array(4), {})
		worker.emit("exit", 1)
		await expect(job).rejects.toThrow("exited (code 1)")
		expect(crashes).toHaveLength(1)
	})
})
