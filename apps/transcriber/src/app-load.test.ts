// Load shedding, cancellation and timing: the request paths that decide
// what happens when the service is busy or a caller stops waiting.

import { readdir, readFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import {
	app,
	chunkedUpload,
	flush,
	gate,
	heldEngine,
	KEY,
	scratch,
	upload,
	until,
} from "./app.testkit.js"
import { SCRATCH_PREFIX } from "./decode.js"
import { JobQueue } from "./queue.js"

describe("admission before the body is read", () => {
	it("answers 503 without reading the body when the queue is full", async () => {
		const queue = new JobQueue(0, 1)
		const g = gate()
		const holding = queue.run(() => g.promise)
		const up = chunkedUpload(512)
		const res = await app({ queue }).fetch(up.req)
		expect(res.status).toBe(503)
		expect(await res.json()).toMatchObject({ error: { code: "queue_full" } })
		expect(up.pulls).toBe(0)
		g.open()
		await holding
	})

	it("stops a chunked upload at the size limit with 413", async () => {
		const queue = new JobQueue(1)
		const up = chunkedUpload(4 * 1024 * 1024)
		const res = await app({ queue }).fetch(up.req)
		expect(res.status).toBe(413)
		expect(await res.json()).toMatchObject({
			error: { code: "file_too_large" },
		})
		// Stopped near the limit (1 KiB plus multipart slack), far short of
		// the 4 MiB on offer.
		expect(up.sent).toBeLessThan(128 * 1024)
		// And its reserved place was given back.
		expect(queue.depth).toBe(0)
		expect(queue.full).toBe(false)
	})

	it("still accepts a chunked upload within the limit", async () => {
		const up = chunkedUpload(512)
		const res = await app().fetch(up.req)
		expect(res.status).toBe(200)
	})

	it("gives the reserved place back after a rejected request", async () => {
		const queue = new JobQueue(0, 1)
		const server = app({ queue })
		for (let i = 0; i < 3; i++) {
			const res = await server.fetch(
				upload(new Uint8Array([1]), { response_format: "docx" }),
			)
			expect(res.status).toBe(400)
		}
		expect(queue.full).toBe(false)
		expect((await server.fetch(upload(new Uint8Array([1])))).status).toBe(200)
	})
})

describe("abandoned and runaway jobs", () => {
	function abortable(bytes: Uint8Array) {
		const ac = new AbortController()
		const base = upload(bytes)
		return {
			ac,
			req: new Request(base, { signal: ac.signal }),
		}
	}

	it("drops a queued job whose client went away; it never runs", async () => {
		const { engine, started } = heldEngine()
		const queue = new JobQueue(4)
		const logs: string[] = []
		const server = app({ engine, queue, log: (l) => logs.push(l) })
		const first = server.fetch(upload(new Uint8Array([1])))
		await until(() => started.length === 1)
		const waiting = abortable(new Uint8Array([2]))
		const gone = server.fetch(waiting.req)
		await until(() => queue.depth === 1)
		waiting.ac.abort()
		expect((await gone).status).toBe(499)
		// Its place is free at once; the running job is untouched.
		expect(queue.depth).toBe(0)
		expect(logs.some((l) => l.includes("while queued; dropped"))).toBe(true)
		started[0].release()
		expect((await first).status).toBe(200)
		await flush()
		expect(started).toHaveLength(1)
		expect(queue.busy).toBe(false)
	})

	it("stops a running job whose client went away and frees the slot", async () => {
		const { engine, started } = heldEngine()
		const queue = new JobQueue(4)
		const logs: string[] = []
		const server = app({ engine, queue, log: (l) => logs.push(l) })
		const running = abortable(new Uint8Array([1]))
		const res = server.fetch(running.req)
		await until(() => started.length === 1)
		running.ac.abort()
		expect(started[0].signal?.aborted).toBe(true)
		expect((await res).status).toBe(499)
		expect(logs.some((l) => l.includes("while running; stopped"))).toBe(true)
		expect(queue.busy).toBe(false)
		// The slot is usable again.
		const next = server.fetch(upload(new Uint8Array([2])))
		await until(() => started.length === 2)
		started[1].release()
		expect((await next).status).toBe(200)
	})

	it("stops a job that runs past maxJobSeconds with 504", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const { engine, started } = heldEngine()
			const queue = new JobQueue(4)
			const server = app({ engine, queue, maxJobSeconds: 30 })
			const res = server.fetch(upload(new Uint8Array([1])))
			await until(() => started.length === 1)
			await vi.advanceTimersByTimeAsync(29_999)
			expect(started[0].signal?.aborted).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			expect(started[0].signal?.aborted).toBe(true)
			const out = await res
			expect(out.status).toBe(504)
			expect(await out.json()).toMatchObject({
				error: {
					code: "job_timeout",
					message: expect.stringContaining("exceeded 30s"),
				},
			})
			expect(queue.busy).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not count queue wait toward maxJobSeconds", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const { engine, started } = heldEngine()
			const queue = new JobQueue(4)
			const server = app({ engine, queue, maxJobSeconds: 30 })
			const first = server.fetch(upload(new Uint8Array([1])))
			await until(() => started.length === 1)
			const second = server.fetch(upload(new Uint8Array([2])))
			await until(() => queue.depth === 1)
			await vi.advanceTimersByTimeAsync(20_000)
			started[0].release()
			expect((await first).status).toBe(200)
			await until(() => started.length === 2)
			// 20 s queued + 20 s running: over 30 s in total, but not running.
			await vi.advanceTimersByTimeAsync(20_000)
			expect(started[1].signal?.aborted).toBe(false)
			started[1].release()
			expect((await second).status).toBe(200)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("timing and backlog reporting", () => {
	it("logs speed from when the job started, not when it was queued", async () => {
		let clock = 0
		const { engine, started } = heldEngine()
		const logs: string[] = []
		let probed = 0
		const server = app({
			engine,
			queue: new JobQueue(4),
			now: () => clock,
			log: (l) => logs.push(l),
			// Called right before a job is queued: a deterministic marker.
			probe: async () => {
				probed++
				return undefined
			},
		})
		const first = server.fetch(upload(new Uint8Array([1])))
		await until(() => started.length === 1)
		const second = server.fetch(upload(new Uint8Array([2])))
		await until(() => probed === 2)
		await flush()
		clock += 50_000
		started[0].release()
		await first
		await until(() => started.length === 2)
		clock += 2_000
		started[1].release()
		await second
		expect(logs[1]).toContain("in 2.0s")
		expect(logs[1]).toContain("after 50.0s queued")
	})

	it("sets Retry-After to when the running job should finish", async () => {
		// The live case: after a restart the only history is a 1 s clip,
		// then long recordings fill the queue. The first byte of each upload
		// is its length in seconds, both to the probe and to the decoder.
		let clock = 0
		const { engine, started } = heldEngine()
		const queue = new JobQueue(2, 1)
		let probed = 0
		const server = app({
			engine,
			queue,
			now: () => clock,
			probe: async (path) => {
				probed++
				return (await readFile(path))[0]
			},
			decode: async (input) =>
				new Float32Array(
					(typeof input === "string" ? (await readFile(input))[0] : 1) * 16000,
				),
		})
		// History: a 1 s clip that took 13 s, i.e. one 30 s window at ~2.3x.
		const short = server.fetch(upload(new Uint8Array([1])))
		await until(() => started.length === 1)
		clock += 13_000
		started[0].release()
		expect((await short).status).toBe(200)
		// Now three 120 s recordings: one running, two queued.
		const long = [0, 1, 2].map(() =>
			server.fetch(upload(new Uint8Array([120]))),
		)
		await until(() => started.length === 2 && probed === 4)
		clock += 10_000
		const refused = await server.fetch(upload(new Uint8Array([1])))
		expect(refused.status).toBe(503)
		// 4 windows at 30/13 per second is 52 s, 10 s of it done: a place
		// opens in 42 s. Speed in raw audio seconds (1/13 x) said 600.
		expect(refused.headers.get("retry-after")).toBe("42")
		for (let i = 1; i <= 3; i++) {
			await until(() => started.length > i)
			started[i].release()
		}
		await Promise.all(long)
	})

	it("reports saturation and the queue limit in /health", async () => {
		const { engine, started } = heldEngine()
		const queue = new JobQueue(3, 1)
		const server = app({ engine, queue })
		const health = async () =>
			(await server.fetch(new Request("http://t/health"))).json()
		expect(await health()).toMatchObject({
			ok: true,
			busy: false,
			saturated: false,
			queued: 0,
			running: 0,
			workers: 1,
			queueLimit: 3,
		})
		const job = server.fetch(upload(new Uint8Array([1])))
		await until(() => started.length === 1)
		const res = await server.fetch(new Request("http://t/health"))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			busy: true,
			saturated: true,
			running: 1,
		})
		started[0].release()
		await job
	})
})

describe("staged uploads", () => {
	const post = (body: BodyInitLike, type?: string) =>
		new Request("http://t/v1/audio/transcriptions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${KEY}`,
				...(type ? { "Content-Type": type } : {}),
			},
			body,
		})
	type BodyInitLike = string | FormData | null
	const leftovers = async () =>
		(await readdir(scratch)).filter((n) => n.startsWith(SCRATCH_PREFIX))

	it("hands the decoder a file on disk and removes it after success", async () => {
		const seen: string[] = []
		const server = app({
			decode: async (input) => {
				expect(typeof input).toBe("string")
				seen.push(input as string)
				return Float32Array.from(
					await readFile(input as string),
					(b) => b / 255,
				)
			},
		})
		const res = await server.fetch(
			upload(new Uint8Array([1, 2, 3]), { language: "en" }),
		)
		expect(res.status).toBe(200)
		expect(seen).toHaveLength(1)
		expect(await leftovers()).toEqual([])
	})

	it("removes the staged file after a 400, a 413, a 500 and an abort", async () => {
		const server = app()
		expect(
			(
				await server.fetch(
					upload(new Uint8Array([1]), { response_format: "docx" }),
				)
			).status,
		).toBe(400)
		expect((await server.fetch(upload(new Uint8Array(2048)))).status).toBe(413)
		expect(
			(await server.fetch(chunkedUpload(4 * 1024 * 1024).req)).status,
		).toBe(413)
		const failing = app({
			decode: async () => {
				throw new Error("boom")
			},
		})
		expect((await failing.fetch(upload(new Uint8Array([1])))).status).toBe(500)
		const { engine, started } = heldEngine()
		const held = app({ engine })
		const ac = new AbortController()
		const res = held.fetch(
			new Request(upload(new Uint8Array([1])), { signal: ac.signal }),
		)
		await until(() => started.length === 1)
		ac.abort()
		expect((await res).status).toBe(499)
		expect(await leftovers()).toEqual([])
	})

	it("still parses model, response_format and language", async () => {
		const res = await app().fetch(
			upload(new Uint8Array([1]), {
				model: "whisper-1",
				response_format: "verbose_json",
				language: "de",
			}),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			task: "transcribe",
			language: "de",
		})
		const wrong = await app().fetch(
			upload(new Uint8Array([1]), { model: "whisper-large-v3" }),
		)
		expect(wrong.status).toBe(404)
	})

	it("answers 400 missing_file for a form without a file", async () => {
		const form = new FormData()
		form.set("model", "whisper-1")
		form.set("file", "not a file, just text")
		const res = await app().fetch(post(form))
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: { code: "missing_file" } })
	})

	it("answers 400 invalid_body for no body or a JSON body", async () => {
		for (const req of [
			post(null),
			post(JSON.stringify({ file: "x" }), "application/json"),
		]) {
			const res = await app().fetch(req)
			expect(res.status).toBe(400)
			expect(await res.json()).toMatchObject({
				error: { code: "invalid_body" },
			})
		}
		expect(await leftovers()).toEqual([])
	})
})
