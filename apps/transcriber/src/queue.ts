// A bounded pool of transcription workers.
//
// This was a strictly serial queue, for a good reason: Whisper on CPU uses
// every core it is given, so two concurrent jobs sharing one core only make
// each other slower. That reason still holds PER CORE — the pool does not
// repeal it, it just stops one core being the whole machine. Each worker is
// given `threads` = cores / workers, so the workers partition the CPU rather
// than fighting over it, and a one-core host lands back on exactly the old
// behaviour: one worker, one thread, one job at a time.
//
// Each worker owns its own Engine, never shared mid-flight. transformers.js
// pipelines carry state across a generate() call, so two jobs inside one
// pipeline are not safe; a slot is leased for the whole job and returned
// afterwards. That isolation costs a full copy of the model weights per
// worker (~726 MB for whisper-base.en q8), which is the real ceiling on how
// many workers a host can hold — see TRANSCRIBER_WORKERS in config.ts.

export class QueueFullError extends Error {}

export class JobQueue {
	/** Accepted and not yet finished, running or waiting. */
	private inFlight = 0
	/** Worker slots not leased right now. A slot is leased the moment a job
	 *  is admitted to it and passes straight from a finishing job to the
	 *  next waiter, so `concurrency - free.length` is always the number of
	 *  jobs holding a worker, with no gap at either boundary. */
	private readonly free: number[]
	/** Resolvers for callers waiting on a slot, oldest first. */
	private readonly waiting: Array<(slot: number) => void> = []
	/** Reservations holding a place that run() has not used yet. */
	private readonly reserved = new Set<Reservation>()

	readonly concurrency: number

	constructor(
		readonly maxWaiting: number,
		concurrency = 1,
	) {
		// Normalised once, so admission control and the slot count cannot
		// disagree about how wide the pool is. Non-finite input falls back
		// to one worker: NaN would build a pool with no slots at all.
		this.concurrency = Number.isFinite(concurrency)
			? Math.max(1, Math.floor(concurrency))
			: 1
		this.free = Array.from({ length: this.concurrency }, (_, i) => i)
	}

	/** Jobs accepted but not yet running. */
	get depth(): number {
		return this.inFlight - this.running
	}

	/** True when anything at all is running. Kept for /health, which reported
	 *  this when there was only ever one job. */
	get busy(): boolean {
		return this.running > 0
	}

	/** True when every worker is occupied — the honest "no spare capacity"
	 *  signal now that busy() can be true with idle workers beside it. */
	get saturated(): boolean {
		return this.running >= this.concurrency
	}

	/** Jobs holding a worker slot. */
	get running(): number {
		return this.concurrency - this.free.length
	}

	/** True once a new job would be refused. Lets a caller turn a request
	 *  away before doing expensive work for it, such as reading its body. */
	get full(): boolean {
		return this.inFlight >= this.maxWaiting + this.concurrency
	}

	private admit(): void {
		if (this.full) {
			throw new QueueFullError(
				`transcription queue is full (${this.maxWaiting} waiting)`,
			)
		}
		this.inFlight++
	}

	/** Takes an admission place now, for a job that will be handed to run()
	 *  later. Throws QueueFullError when there is none. The place counts in
	 *  `depth` until it is used or cancelled, so a request can hold its spot
	 *  while its upload is still arriving. */
	reserve(): Reservation {
		this.admit()
		const reservation: Reservation = {
			cancel: () => {
				if (this.reserved.delete(reservation)) this.inFlight--
			},
		}
		this.reserved.add(reservation)
		return reservation
	}

	private acquire(signal?: AbortSignal): Promise<number> {
		const slot = this.free.pop()
		if (slot !== undefined) return Promise.resolve(slot)
		return new Promise<number>((resolve, reject) => {
			const onAbort = () => {
				// Still in line: leave it, so the place is free at once and the
				// job never starts. If the slot was already handed over, the
				// waiter is gone from the line and run() gives the slot back.
				const at = this.waiting.indexOf(waiter)
				if (at < 0) return
				this.waiting.splice(at, 1)
				reject(signal?.reason)
			}
			const waiter = (granted: number) => {
				signal?.removeEventListener("abort", onAbort)
				resolve(granted)
			}
			this.waiting.push(waiter)
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	private release(slot: number): void {
		// Hand straight to the next waiter rather than through the free list,
		// so a queued job cannot be overtaken by one arriving later.
		const next = this.waiting.shift()
		if (next) next(slot)
		else this.free.push(slot)
	}

	/** Runs `job` on a leased worker slot. Throws QueueFullError when more
	 *  than `maxWaiting` are already queued behind the running ones, unless
	 *  `reservation` already holds a place.
	 *
	 *  When `signal` aborts while the job is still waiting for a slot, it
	 *  leaves the queue at once and the promise rejects with the signal's
	 *  reason; the job is never started. Once running, cancelling the job
	 *  is the job's own business: the slot comes back when it settles.
	 *
	 *  Counting everything in flight, rather than jobs "not yet started",
	 *  matters: a job accepted into an idle pool only starts on the next tick,
	 *  and must not make a request arriving in that gap look like overflow. */
	run<T>(job: (slot: number) => Promise<T>, opts: RunOptions = {}): Promise<T> {
		const { signal, reservation } = opts
		// Deliberately NOT an async method: overflow throws synchronously, as
		// it always has, so a caller that does not await immediately gets an
		// exception rather than an unhandled rejection.
		if (reservation) {
			if (!this.reserved.delete(reservation)) {
				throw new Error("reservation was already used or cancelled")
			}
		} else {
			if (signal?.aborted) return Promise.reject(signal.reason)
			this.admit()
		}
		return (async () => {
			try {
				if (signal?.aborted) throw signal.reason
				const slot = await this.acquire(signal)
				if (signal?.aborted) {
					// Aborted in the same turn the slot was handed over.
					this.release(slot)
					throw signal.reason
				}
				try {
					return await job(slot)
				} finally {
					this.release(slot)
				}
			} finally {
				this.inFlight--
			}
		})()
	}
}

export interface Reservation {
	/** Gives the place back if run() has not used it. Safe to call twice. */
	cancel(): void
}

export interface RunOptions {
	/** Aborting drops a job that is still waiting for a slot. */
	signal?: AbortSignal
	/** A place taken earlier with reserve(); skips admission control. */
	reservation?: Reservation
}
