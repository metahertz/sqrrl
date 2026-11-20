import { describe, expect, it } from "vitest"
import { JobQueue, QueueFullError } from "./queue.js"

// No wall-clock sleeps in here. Every job blocks on a gate the test opens
// explicitly, and `flush()` lets all pending promise callbacks run, so each
// assertion sees a state the test itself put the queue in, however loaded
// the machine is.

interface Gate<T = void> {
	promise: Promise<T>
	open: (value: T) => void
	fail: (err: unknown) => void
}

function gate<T = void>(): Gate<T> {
	let open!: (value: T) => void
	let fail!: (err: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		open = res
		fail = rej
	})
	return { promise, open, fail }
}

/** Runs every queued microtask (and anything they chain) to completion:
 *  setImmediate fires only once the microtask queue is empty. */
const flush = () => new Promise<void>((r) => setImmediate(r))

/** A job that records its start, holds until its gate opens, then records
 *  its end. Exposes the slot it was given. */
function heldJob(name: string, log: string[]) {
	const g = gate()
	let slot: number | undefined
	const job = async (s: number) => {
		slot = s
		log.push(`start ${name}`)
		await g.promise
		log.push(`end ${name}`)
		return name
	}
	return {
		job,
		release: () => g.open(),
		get slot() {
			return slot
		},
	}
}

describe("JobQueue", () => {
	it("runs jobs one at a time, in order", async () => {
		const q = new JobQueue(10)
		const log: string[] = []
		const [a, b, c] = ["a", "b", "c"].map((n) => heldJob(n, log))
		const results = Promise.all([q.run(a.job), q.run(b.job), q.run(c.job)])
		await flush()
		expect(log).toEqual(["start a"])
		// Release out of order: c and b are ready, but must wait their turn.
		c.release()
		b.release()
		await flush()
		expect(log).toEqual(["start a"])
		a.release()
		expect(await results).toEqual(["a", "b", "c"])
		expect(log).toEqual([
			"start a",
			"end a",
			"start b",
			"end b",
			"start c",
			"end c",
		])
	})

	it("keeps going after a job fails", async () => {
		const q = new JobQueue(10)
		const failed = q.run(async () => {
			throw new Error("boom")
		})
		const next = q.run(async () => "ok")
		await expect(failed).rejects.toThrow("boom")
		await expect(next).resolves.toBe("ok")
	})

	it("accepts one running plus the waiting limit, then refuses", async () => {
		const q = new JobQueue(1)
		const g = gate()
		// Both accepted in the same tick, before the first has started.
		const first = q.run(() => g.promise)
		const second = q.run(async () => {})
		expect(() => q.run(async () => 1)).toThrow(QueueFullError)
		// Still refused once the first is actually running.
		await flush()
		expect(() => q.run(async () => 1)).toThrow(QueueFullError)
		g.open()
		await Promise.all([first, second])
		await expect(q.run(async () => 2)).resolves.toBe(2)
	})

	it("throws QueueFullError synchronously, not as a rejection", () => {
		const q = new JobQueue(0)
		const g = gate()
		const held = q.run(() => g.promise)
		let threw: unknown
		try {
			q.run(async () => 1)
		} catch (err) {
			threw = err
		}
		expect(threw).toBeInstanceOf(QueueFullError)
		g.open()
		return held
	})

	it("reports depth and busy state", async () => {
		const q = new JobQueue(5)
		expect(q.busy).toBe(false)
		expect(q.depth).toBe(0)
		const ga = gate()
		const gb = gate()
		const a = q.run(() => ga.promise)
		const b = q.run(() => gb.promise)
		await flush()
		expect(q.busy).toBe(true)
		expect(q.running).toBe(1)
		expect(q.depth).toBe(1)
		ga.open()
		await a
		await flush()
		// b has moved from waiting to running.
		expect(q.busy).toBe(true)
		expect(q.running).toBe(1)
		expect(q.depth).toBe(0)
		gb.open()
		await b
		expect(q.busy).toBe(false)
		expect(q.running).toBe(0)
		expect(q.depth).toBe(0)
	})

	it("counts every waiting job in depth", async () => {
		const q = new JobQueue(10)
		const g = gate()
		const jobs = Array.from({ length: 5 }, () => q.run(() => g.promise))
		await flush()
		expect(q.running).toBe(1)
		expect(q.depth).toBe(4)
		g.open()
		await Promise.all(jobs)
		expect(q.depth).toBe(0)
		expect(q.busy).toBe(false)
	})
})

describe("JobQueue as a pool", () => {
	it("runs up to `concurrency` jobs at once and no more", async () => {
		const q = new JobQueue(10, 3)
		const log: string[] = []
		const jobs = Array.from({ length: 9 }, (_, i) => heldJob(`j${i}`, log))
		const done = Promise.all(jobs.map((j) => q.run(j.job)))
		await flush()
		expect(log).toEqual(["start j0", "start j1", "start j2"])
		expect(q.running).toBe(3)
		expect(q.depth).toBe(6)
		// Each completion admits exactly one more.
		jobs[1].release()
		await flush()
		expect(log.filter((l) => l.startsWith("start"))).toHaveLength(4)
		expect(q.running).toBe(3)
		expect(q.depth).toBe(5)
		for (const j of jobs) j.release()
		await done
		expect(q.running).toBe(0)
	})

	it("gives each concurrent job a distinct slot within range", async () => {
		// The slot indexes an engine, so two live jobs sharing one would put
		// two requests inside the same transformers.js pipeline.
		const q = new JobQueue(10, 3)
		const log: string[] = []
		const jobs = Array.from({ length: 9 }, (_, i) => heldJob(`j${i}`, log))
		const done = Promise.all(jobs.map((j) => q.run(j.job)))
		// Release one job at a time, checking the live slots at every step.
		for (let i = 0; i < jobs.length; i++) {
			await flush()
			const live = jobs
				.filter((j, k) => k >= i && j.slot !== undefined)
				.map((j) => j.slot as number)
			expect(new Set(live).size).toBe(live.length)
			expect(live.length).toBe(Math.min(3, jobs.length - i))
			expect(live.every((s) => s >= 0 && s < 3)).toBe(true)
			jobs[i].release()
		}
		await done
	})

	it("admits concurrency + maxWaiting before refusing", async () => {
		const q = new JobQueue(2, 2)
		const g = gate()
		const jobs = Array.from({ length: 4 }, () => q.run(() => g.promise))
		expect(() => q.run(async () => 1)).toThrow(QueueFullError)
		await flush()
		expect(() => q.run(async () => 1)).toThrow(QueueFullError)
		g.open()
		await Promise.all(jobs)
		await expect(q.run(async () => 1)).resolves.toBe(1)
	})

	it("hands a freed slot to the longest waiter, not a latecomer", async () => {
		const q = new JobQueue(10, 1)
		const order: string[] = []
		const g = gate()
		const a = q.run(async () => {
			await g.promise
			order.push("a")
		})
		const b = q.run(async () => {
			order.push("b")
		})
		await flush()
		// c arrives after b has been waiting; a frees the slot in between.
		g.open()
		const c = q.run(async () => {
			order.push("c")
		})
		await Promise.all([a, b, c])
		expect(order).toEqual(["a", "b", "c"])
	})

	it("serves waiters in FIFO order as slots free up", async () => {
		const q = new JobQueue(10, 2)
		const log: string[] = []
		const jobs = Array.from({ length: 6 }, (_, i) => heldJob(`j${i}`, log))
		const done = Promise.all(jobs.map((j) => q.run(j.job)))
		await flush()
		// Free the slots in reverse order of start.
		jobs[1].release()
		await flush()
		jobs[0].release()
		await flush()
		expect(log.filter((l) => l.startsWith("start"))).toEqual([
			"start j0",
			"start j1",
			"start j2",
			"start j3",
		])
		for (const j of jobs) j.release()
		await done
		expect(log.filter((l) => l.startsWith("start"))).toEqual(
			jobs.map((_, i) => `start j${i}`),
		)
	})

	it("a failing job frees its slot instead of leaking it", async () => {
		const q = new JobQueue(10, 1)
		await expect(
			q.run(async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")
		await expect(q.run(async () => "ok")).resolves.toBe("ok")
		expect(q.busy).toBe(false)
		expect(q.depth).toBe(0)
	})

	it("a job rejecting while others wait hands its slot on", async () => {
		const q = new JobQueue(10, 1)
		const g = gate()
		const failing = q.run(() => g.promise)
		const waiting = q.run(async () => "next")
		await flush()
		expect(q.depth).toBe(1)
		g.fail(new Error("boom"))
		await expect(failing).rejects.toThrow("boom")
		await expect(waiting).resolves.toBe("next")
		expect(q.busy).toBe(false)
		expect(q.depth).toBe(0)
	})

	it("a job that throws synchronously frees its slot", async () => {
		const q = new JobQueue(10, 1)
		const sync = (() => {
			throw new Error("sync boom")
		}) as unknown as () => Promise<void>
		await expect(q.run(sync)).rejects.toThrow("sync boom")
		await expect(q.run(async () => "ok")).resolves.toBe("ok")
		expect(q.busy).toBe(false)
	})

	it("failed jobs free their admission places too", async () => {
		const q = new JobQueue(1, 1)
		for (let i = 0; i < 5; i++) {
			const g = gate()
			const a = q.run(() => g.promise)
			const b = q.run(async () => {
				throw new Error("b")
			})
			expect(() => q.run(async () => 1)).toThrow(QueueFullError)
			g.fail(new Error("a"))
			await expect(a).rejects.toThrow("a")
			await expect(b).rejects.toThrow("b")
		}
		expect(q.depth).toBe(0)
		expect(q.busy).toBe(false)
	})

	it("reports saturation separately from busy", async () => {
		const q = new JobQueue(10, 2)
		expect(q.saturated).toBe(false)
		const ga = gate()
		const gb = gate()
		const a = q.run(() => ga.promise)
		await flush()
		// One of two workers running: busy, but there is still capacity.
		expect(q.busy).toBe(true)
		expect(q.saturated).toBe(false)
		const b = q.run(() => gb.promise)
		await flush()
		expect(q.saturated).toBe(true)
		ga.open()
		await a
		expect(q.busy).toBe(true)
		expect(q.saturated).toBe(false)
		gb.open()
		await b
		expect(q.busy).toBe(false)
		expect(q.saturated).toBe(false)
	})

	it("defaults to one worker, preserving the old serial behaviour", async () => {
		const q = new JobQueue(10)
		expect(q.concurrency).toBe(1)
		const log: string[] = []
		const jobs = Array.from({ length: 4 }, (_, i) => heldJob(`j${i}`, log))
		const done = Promise.all(jobs.map((j) => q.run(j.job)))
		for (let i = 0; i < jobs.length; i++) {
			await flush()
			expect(q.running).toBe(1)
			expect(log.at(-1)).toBe(`start j${i}`)
			jobs[i].release()
		}
		await done
	})

	it("counts a job as running from the moment it is admitted to a slot", async () => {
		// A job admitted into an idle pool holds its slot at once; the
		// getters must not report spare capacity while it is on its way in.
		const q = new JobQueue(10, 1)
		const ga = gate()
		const gb = gate()
		const a = q.run(() => ga.promise)
		expect(q.busy).toBe(true)
		expect(q.saturated).toBe(true)
		expect(q.running).toBe(1)
		expect(q.depth).toBe(0)
		const b = q.run(() => gb.promise)
		expect(q.depth).toBe(1)
		await flush()
		ga.open()
		await a
		// a has finished and handed its slot to b: still saturated, nothing
		// waiting, whether or not b's body has started yet.
		expect(q.saturated).toBe(true)
		expect(q.running).toBe(1)
		expect(q.depth).toBe(0)
		gb.open()
		await b
		expect(q.busy).toBe(false)
	})

	it("falls back to one worker for a non-finite concurrency", async () => {
		// NaN used to yield a pool with no slots, where every job waited
		// forever; Infinity threw a RangeError building the slot list.
		for (const n of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const q = new JobQueue(1, n)
			expect(q.concurrency).toBe(1)
			await expect(q.run(async (slot) => slot)).resolves.toBe(0)
		}
	})

	it("normalizes a fractional or sub-one concurrency", () => {
		expect(new JobQueue(1, 2.7).concurrency).toBe(2)
		expect(new JobQueue(1, 0).concurrency).toBe(1)
		expect(new JobQueue(1, -3).concurrency).toBe(1)
	})
})

describe("JobQueue cancellation", () => {
	it("drops a waiting job when its signal aborts, without starting it", async () => {
		const q = new JobQueue(1, 1)
		const g = gate()
		const running = q.run(() => g.promise)
		const ac = new AbortController()
		let started = false
		const waiting = q.run(
			async () => {
				started = true
			},
			{ signal: ac.signal },
		)
		await flush()
		expect(q.full).toBe(true)
		expect(q.depth).toBe(1)
		ac.abort(new Error("client gone"))
		await expect(waiting).rejects.toThrow("client gone")
		// Its place is free at once, while the first job still runs.
		expect(q.depth).toBe(0)
		expect(q.full).toBe(false)
		const next = q.run(async () => "next")
		g.open()
		await running
		await expect(next).resolves.toBe("next")
		expect(started).toBe(false)
		expect(q.busy).toBe(false)
	})

	it("keeps FIFO order for the waiters left behind", async () => {
		const q = new JobQueue(10, 1)
		const g = gate()
		const order: string[] = []
		const first = q.run(() => g.promise)
		const ac = new AbortController()
		const jobs = ["a", "b", "c"].map((n) =>
			q.run(
				async () => {
					order.push(n)
				},
				n === "b" ? { signal: ac.signal } : {},
			),
		)
		ac.abort(new Error("gone"))
		g.open()
		await first
		const results = await Promise.allSettled(jobs)
		expect(results.map((r) => r.status)).toEqual([
			"fulfilled",
			"rejected",
			"fulfilled",
		])
		expect(order).toEqual(["a", "c"])
	})

	it("rejects without admitting when the signal is already aborted", async () => {
		const q = new JobQueue(0, 1)
		const ac = new AbortController()
		ac.abort(new Error("already gone"))
		await expect(q.run(async () => 1, { signal: ac.signal })).rejects.toThrow(
			"already gone",
		)
		expect(q.depth).toBe(0)
		expect(q.busy).toBe(false)
		await expect(q.run(async () => 2)).resolves.toBe(2)
	})

	it("does not leak a slot aborted in the same turn it is handed over", async () => {
		const q = new JobQueue(10, 1)
		const g = gate()
		const ac = new AbortController()
		let started = false
		// Registered before the queue awaits g.promise, so this reaction runs
		// first; the microtask it queues then lands after the queue's own
		// reaction (which hands the slot to the waiter) but before the
		// waiter's continuation. That is the abort-at-hand-over race.
		g.promise.then(() => queueMicrotask(() => ac.abort(new Error("raced"))))
		const first = q.run(() => g.promise)
		const second = q.run(
			async () => {
				started = true
			},
			{ signal: ac.signal },
		)
		await flush()
		g.open()
		await first
		await expect(second).rejects.toThrow("raced")
		expect(started).toBe(false)
		expect(q.busy).toBe(false)
		expect(q.depth).toBe(0)
		await expect(q.run(async () => "ok")).resolves.toBe("ok")
	})

	it("does not leak a free slot taken by a job aborted before it starts", async () => {
		const q = new JobQueue(10, 1)
		const ac = new AbortController()
		let started = false
		const job = q.run(
			async () => {
				started = true
			},
			{ signal: ac.signal },
		)
		// The free slot was leased synchronously; abort before the next tick.
		expect(q.running).toBe(1)
		ac.abort(new Error("gone"))
		await expect(job).rejects.toThrow("gone")
		expect(started).toBe(false)
		expect(q.running).toBe(0)
		await expect(q.run(async () => "ok")).resolves.toBe("ok")
	})

	it("leaves a running job alone when its signal aborts", async () => {
		const q = new JobQueue(10, 1)
		const g = gate<string>()
		const ac = new AbortController()
		const job = q.run(() => g.promise, { signal: ac.signal })
		await flush()
		ac.abort(new Error("gone"))
		await flush()
		// Cancelling a running job is the job's business; the slot stays held.
		expect(q.running).toBe(1)
		g.open("finished")
		await expect(job).resolves.toBe("finished")
		expect(q.running).toBe(0)
	})
})

describe("JobQueue reservations", () => {
	it("holds an admission place until used", async () => {
		const q = new JobQueue(1, 1)
		const r1 = q.reserve()
		const r2 = q.reserve()
		expect(q.full).toBe(true)
		expect(q.depth).toBe(2)
		expect(() => q.reserve()).toThrow(QueueFullError)
		expect(() => q.run(async () => 0)).toThrow(QueueFullError)
		// A reservation is honoured even though the queue is full.
		const a = q.run(async () => "a", { reservation: r1 })
		const b = q.run(async () => "b", { reservation: r2 })
		await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"])
		expect(q.depth).toBe(0)
		expect(q.full).toBe(false)
	})

	it("gives the place back on cancel, once", () => {
		const q = new JobQueue(0, 1)
		const r = q.reserve()
		expect(q.full).toBe(true)
		r.cancel()
		r.cancel()
		expect(q.full).toBe(false)
		expect(q.depth).toBe(0)
		const again = q.reserve()
		expect(() => q.reserve()).toThrow(QueueFullError)
		again.cancel()
	})

	it("refuses a reservation that was used or cancelled", async () => {
		const q = new JobQueue(1, 1)
		const used = q.reserve()
		await q.run(async () => 1, { reservation: used })
		expect(() => q.run(async () => 1, { reservation: used })).toThrow(
			"already used",
		)
		const cancelled = q.reserve()
		cancelled.cancel()
		expect(() => q.run(async () => 1, { reservation: cancelled })).toThrow(
			"already used",
		)
		expect(q.depth).toBe(0)
	})

	it("frees a reserved place when the reserved job is aborted", async () => {
		const q = new JobQueue(0, 1)
		const r = q.reserve()
		const ac = new AbortController()
		ac.abort(new Error("gone"))
		await expect(
			q.run(async () => 1, { reservation: r, signal: ac.signal }),
		).rejects.toThrow("gone")
		expect(q.full).toBe(false)
		expect(q.depth).toBe(0)
	})
})
