// Estimates Retry-After for a request refused because the queue is full.
//
// What the refused caller needs is the time until an admission place opens,
// and only a job FINISHING frees one (a queued job starting just moves it
// from waiting to running). So the answer is the remaining time of the
// soonest-finishing running job, not the time to clear the whole backlog.
//
// Work is counted in Whisper windows, not audio seconds: the model always
// processes a full 30 s window, so a 1 s clip costs as much as a 30 s one.
// Measured in raw audio seconds, a 1 s clip ran at 0.23x while 120 s clips
// ran at ~2.3x, and after a restart one short clip set the speed for every
// estimate that followed (600 s, the cap, where ~55 s was right). In
// windows, both measure the same speed.
//
//   remaining(job) = windows(audio) / speed - elapsed
//   Retry-After    = min over running jobs of remaining, clamped 5..600 s
//
// A running job whose length is not known yet counts as an average job;
// with nothing measured at all it is 60 s.

export interface BacklogJob {
	/** Audio seconds, when known: probed from the header before the job
	 *  queues, then the decoded length once it runs. */
	audioSeconds?: number
	/** Clock time the job got a worker; unset while queued. */
	startedAt?: number
}

/** Whisper's window: every chunk is padded to it. */
const WINDOW_SECONDS = 30
const MIN_SECONDS = 5
const MAX_SECONDS = 600
const FALLBACK_SECONDS = 60
/** Weight of the newest sample in the moving averages. */
const ALPHA = 0.3

/** Audio length rounded up to whole windows: what the model actually runs.
 *  The 5 s chunk overlap is deliberately ignored; the rounding is what
 *  matters. */
export function windowSeconds(audioSeconds: number): number {
	return Math.ceil(audioSeconds / WINDOW_SECONDS) * WINDOW_SECONDS
}

export class Backlog {
	private readonly jobs = new Set<BacklogJob>()
	/** Window seconds processed per wall-clock second, recent average. */
	private speed: number | undefined
	/** Recent average running time of a job, in ms. */
	private avgJobMs: number | undefined

	constructor(private readonly now: () => number = Date.now) {}

	/** Registers an accepted job; remove it with finish(). */
	add(audioSeconds?: number): BacklogJob {
		const job: BacklogJob = { audioSeconds }
		this.jobs.add(job)
		return job
	}

	start(job: BacklogJob): void {
		job.startedAt = this.now()
	}

	/** Removes the job. A successful one also updates the averages, with
	 *  `audioSeconds` as actually decoded. */
	finish(job: BacklogJob, ok?: { audioSeconds: number }): void {
		this.jobs.delete(job)
		if (!ok || job.startedAt === undefined) return
		const ranMs = this.now() - job.startedAt
		this.avgJobMs = mix(this.avgJobMs, ranMs)
		if (ranMs > 0 && ok.audioSeconds > 0) {
			this.speed = mix(
				this.speed,
				windowSeconds(ok.audioSeconds) / (ranMs / 1000),
			)
		}
	}

	/** Seconds until the soonest running job should finish and free an
	 *  admission place. */
	retryAfter(): number {
		const now = this.now()
		let soonest: number | undefined
		for (const job of this.jobs) {
			if (job.startedAt === undefined) continue
			const total = this.expectedSeconds(job)
			if (total === undefined) continue
			const left = Math.max(0, total - (now - job.startedAt) / 1000)
			soonest = soonest === undefined ? left : Math.min(soonest, left)
		}
		return soonest === undefined ? FALLBACK_SECONDS : clamp(soonest)
	}

	/** Expected running time of a job in seconds, if anything is known. */
	private expectedSeconds(job: BacklogJob): number | undefined {
		if (job.audioSeconds !== undefined && this.speed !== undefined) {
			return windowSeconds(job.audioSeconds) / this.speed
		}
		return this.avgJobMs === undefined ? undefined : this.avgJobMs / 1000
	}
}

function mix(prev: number | undefined, sample: number): number {
	return prev === undefined ? sample : prev * (1 - ALPHA) + sample * ALPHA
}

function clamp(seconds: number): number {
	// Rounded up, less float noise: 52.000000001 s is 52, not 53.
	const whole = Math.ceil(seconds - 1e-6)
	return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, whole))
}
