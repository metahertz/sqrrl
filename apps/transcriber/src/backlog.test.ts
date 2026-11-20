import { describe, expect, it } from "vitest"
import { Backlog, windowSeconds } from "./backlog.js"

// Driven by an injected clock: every duration below is exact.
function setup() {
	const clock = { t: 0 }
	const backlog = new Backlog(() => clock.t)
	/** Runs one job of `audio` seconds that takes `ms` to finish. */
	const history = (audio: number, ms: number) => {
		const job = backlog.add(audio)
		backlog.start(job)
		clock.t += ms
		backlog.finish(job, { audioSeconds: audio })
	}
	/** Starts a job of `audio` seconds (undefined: length unknown). */
	const running = (audio: number | undefined) => {
		const job = backlog.add(audio)
		backlog.start(job)
		return job
	}
	return { clock, backlog, history, running }
}

describe("windowSeconds", () => {
	it("rounds audio up to whole 30 s Whisper windows", () => {
		expect(windowSeconds(1)).toBe(30)
		expect(windowSeconds(30)).toBe(30)
		expect(windowSeconds(31)).toBe(60)
		expect(windowSeconds(120)).toBe(120)
	})
})

describe("Backlog.retryAfter", () => {
	it("says 60 s before anything is known", () => {
		const { backlog, running } = setup()
		running(120)
		expect(backlog.retryAfter()).toBe(60)
	})

	it("is not thrown off by a short clip measured after a restart", () => {
		// Live: the last job before the probe was a 1 s clip (0.23x in raw
		// audio seconds), then 3 running + 8 queued 120 s jobs gave 600 s
		// where a place really opened in ~55 s.
		const { clock, backlog, history, running } = setup()
		history(1, 13_000) // one 30 s window in 13 s: 2.3x
		const jobs = [running(120), running(120), running(120)]
		for (let i = 0; i < 8; i++) backlog.add(120)
		// Each 120 s job is 4 windows: 52 s at that speed.
		expect(backlog.retryAfter()).toBe(52)
		// Staggered: the oldest one decides.
		clock.t += 20_000
		backlog.start(jobs[1]) // restarted later (as if it began now)
		expect(backlog.retryAfter()).toBe(32)
	})

	it("measures the same speed from short and long jobs", () => {
		const a = setup()
		a.history(1, 13_000)
		a.running(120)
		const b = setup()
		b.history(120, 52_000)
		b.running(120)
		expect(a.backlog.retryAfter()).toBe(b.backlog.retryAfter())
	})

	it("takes the soonest-finishing running job, not the whole backlog", () => {
		const { clock, backlog, history, running } = setup()
		history(60, 30_000) // 2 windows in 30 s: 2x
		running(600) // 300 s
		clock.t += 5_000
		running(45) // 2 windows: 30 s
		clock.t += 10_000
		running(90) // 45 s
		for (let i = 0; i < 8; i++) backlog.add(3600) // queued: irrelevant
		// The 45 s job started 10 s ago: 30 - 10 = 20 s.
		expect(backlog.retryAfter()).toBe(20)
	})

	it("ignores queued jobs entirely", () => {
		const { backlog, history, running } = setup()
		history(30, 15_000) // 2x
		running(30) // 15 s
		const before = backlog.retryAfter()
		for (let i = 0; i < 8; i++) backlog.add(3600)
		expect(backlog.retryAfter()).toBe(before)
		expect(before).toBe(15)
	})

	it("subtracts elapsed time, never going below the floor", () => {
		const { clock, backlog, history, running } = setup()
		history(30, 15_000)
		running(120) // 60 s
		clock.t += 45_000
		expect(backlog.retryAfter()).toBe(15)
		clock.t += 600_000 // overdue: about to finish
		expect(backlog.retryAfter()).toBe(5)
	})

	it("follows a change in speed", () => {
		const { backlog, history, running } = setup()
		history(60, 30_000) // 2x
		const before = running(60)
		expect(backlog.retryAfter()).toBe(30)
		backlog.finish(before)
		for (let i = 0; i < 10; i++) history(60, 120_000) // slowed to 0.5x
		running(60)
		expect(backlog.retryAfter()).toBeGreaterThan(110)
	})

	it("counts a running job of unknown length as an average job", () => {
		const { clock, backlog, history, running } = setup()
		history(30, 20_000)
		running(undefined)
		clock.t += 5_000
		expect(backlog.retryAfter()).toBe(15)
	})

	it("falls back to 60 s when nothing is running", () => {
		const { backlog, history } = setup()
		history(30, 20_000)
		backlog.add(120)
		expect(backlog.retryAfter()).toBe(60)
	})

	it("clamps to 5..600 s", () => {
		const { backlog, history, running } = setup()
		history(30, 1_000) // 30x
		const quick = running(1)
		expect(backlog.retryAfter()).toBe(5)
		backlog.finish(quick)
		for (let i = 0; i < 10; i++) history(30, 300_000) // 0.1x
		running(3 * 3600)
		expect(backlog.retryAfter()).toBe(600)
	})

	it("forgets finished jobs, including failed ones", () => {
		const { backlog, history, running } = setup()
		history(30, 15_000) // 2x
		const a = running(3600)
		expect(backlog.retryAfter()).toBe(600)
		backlog.finish(a)
		running(20) // 1 window: 15 s
		expect(backlog.retryAfter()).toBe(15)
	})
})
