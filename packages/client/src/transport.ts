export type SqrrlClientOptions = {
	/** Sqrrl API base URL (e.g. http://127.0.0.1:3847). */
	baseUrl?: string
	/** Optional Bearer token; also reads `SQRRL_API_KEY` when unset. */
	apiKey?: string
	/** Max retries for 429/503 (default 2). */
	maxRetries?: number
	/** Total request budget in milliseconds (default 10,000). */
	defaultDeadlineMs?: number
}

export type SqrrlRequestOptions = {
	/** Overrides the client deadline for this call. */
	timeoutMs?: number
	/** Cancels this call without affecting other client requests. */
	signal?: AbortSignal
}

/**
 * Parsed form of the API's error envelope
 * (`{ error: { code, message, retryable?, outcome?, retryAfterMs? } }`).
 * Exposed on every SqrrlClientError so callers can branch on the machine
 * code (e.g. REVISION_CONFLICT) instead of scraping the raw body text.
 */
export type SqrrlApiErrorEnvelope = {
	code: string
	message: string
	retryable?: boolean
	outcome?: string
	retryAfterMs?: number
}

function parseErrorEnvelope(body: string): SqrrlApiErrorEnvelope | undefined {
	if (!body) return undefined
	try {
		const parsed: unknown = JSON.parse(body)
		if (parsed === null || typeof parsed !== "object") return undefined
		const error = (parsed as Record<string, unknown>).error
		if (error === null || typeof error !== "object") return undefined
		const { code, message } = error as Record<string, unknown>
		if (typeof code !== "string" || typeof message !== "string")
			return undefined
		const envelope = { code, message } as SqrrlApiErrorEnvelope
		const { retryable, outcome, retryAfterMs } = error as Record<
			string,
			unknown
		>
		if (typeof retryable === "boolean") envelope.retryable = retryable
		if (typeof outcome === "string") envelope.outcome = outcome
		if (typeof retryAfterMs === "number") envelope.retryAfterMs = retryAfterMs
		return envelope
	} catch {
		return undefined
	}
}

/** Thrown when the Sqrrl HTTP API returns a non-OK status. */
export class SqrrlClientError extends Error {
	readonly status: number
	readonly body: string
	readonly code?: "DEADLINE_EXCEEDED" | "REQUEST_ABORTED"
	/**
	 * The API error envelope parsed from `body`, when the server sent one.
	 * API error codes (UNAUTHORIZED, DUPLICATE_SLUG, REVISION_CONFLICT,
	 * RATE_LIMITED, ...) live here; the transport-level `code` above only
	 * covers abort/deadline conditions.
	 */
	readonly envelope?: SqrrlApiErrorEnvelope

	constructor(
		status: number,
		body: string,
		message?: string,
		code?: "DEADLINE_EXCEEDED" | "REQUEST_ABORTED",
	) {
		super(message ?? `Sqrrl API ${status}: ${body || "(empty)"}`)
		this.name = "SqrrlClientError"
		this.status = status
		this.body = body
		this.code = code
		this.envelope = parseErrorEnvelope(body)
	}
}

const DEFAULT_DEADLINE_MS = 10_000

type RequestContext = {
	signal: AbortSignal
	abortKind: () => "caller" | "deadline" | undefined
	remainingMs: () => number
	cleanup: () => void
}

export function resolveDeadlineMs(
	opts: SqrrlClientOptions,
	requestOptions: SqrrlRequestOptions = {},
): number {
	const timeoutMs =
		requestOptions.timeoutMs ?? opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs < 0 ||
		timeoutMs > 2_147_483_647
	) {
		throw new TypeError(
			"timeoutMs must be between 0 and 2,147,483,647 milliseconds",
		)
	}
	return timeoutMs
}

function createRequestContext(
	opts: SqrrlClientOptions,
	requestOptions: SqrrlRequestOptions = {},
): RequestContext {
	const timeoutMs = resolveDeadlineMs(opts, requestOptions)
	const controller = new AbortController()
	const deadlineAt = Date.now() + timeoutMs
	let kind: "caller" | "deadline" | undefined
	const callerSignal = requestOptions.signal
	const abortFromCaller = () => {
		if (!controller.signal.aborted) {
			kind = "caller"
			controller.abort()
		}
	}
	if (callerSignal?.aborted) {
		abortFromCaller()
	} else {
		callerSignal?.addEventListener("abort", abortFromCaller, { once: true })
	}

	let timer: ReturnType<typeof setTimeout> | undefined
	if (timeoutMs === 0) {
		if (!controller.signal.aborted) {
			kind = "deadline"
			controller.abort()
		}
	} else {
		timer = setTimeout(() => {
			if (!controller.signal.aborted) {
				kind = "deadline"
				controller.abort()
			}
		}, timeoutMs)
	}

	return {
		signal: controller.signal,
		abortKind: () => kind,
		remainingMs: () => Math.max(0, deadlineAt - Date.now()),
		cleanup: () => {
			if (timer) {
				clearTimeout(timer)
			}
			callerSignal?.removeEventListener("abort", abortFromCaller)
		},
	}
}

function requestAbortError(kind: "caller" | "deadline"): SqrrlClientError {
	if (kind === "deadline") {
		return new SqrrlClientError(
			408,
			"Request deadline exceeded",
			"Sqrrl request deadline exceeded",
			"DEADLINE_EXCEEDED",
		)
	}
	return new SqrrlClientError(
		499,
		"Request canceled",
		"Sqrrl request canceled",
		"REQUEST_ABORTED",
	)
}

function resolveBaseUrl(opts: SqrrlClientOptions): string {
	const raw =
		opts.baseUrl ?? process.env.SQRRL_API_URL ?? "http://127.0.0.1:3847"
	return raw.replace(/\/$/, "")
}

function resolveApiKey(opts: SqrrlClientOptions): string | undefined {
	return opts.apiKey ?? process.env.SQRRL_API_KEY ?? undefined
}

type RetryPolicy = "safe" | "same-key" | "never"

type ResponseParse = "json" | "text"

function retryDelayMs(response: Response, attempt: number): number {
	const retryAfter = response.headers.get("retry-after")
	if (retryAfter) {
		const seconds = Number(retryAfter)
		if (Number.isFinite(seconds) && seconds >= 0) {
			return seconds * 1_000
		}
		const at = Date.parse(retryAfter)
		if (Number.isFinite(at)) {
			return Math.max(0, at - Date.now())
		}
	}
	return 200 * 2 ** attempt
}

function sleep(ms: number, context: RequestContext): Promise<void> {
	if (context.signal.aborted) {
		return Promise.reject(requestAbortError(context.abortKind() ?? "caller"))
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer)
			reject(requestAbortError(context.abortKind() ?? "caller"))
		}
		const timer = setTimeout(() => {
			context.signal.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		context.signal.addEventListener("abort", onAbort, { once: true })
	})
}

function buildHeaders(
	opts: SqrrlClientOptions,
	method: string,
): Record<string, string> {
	const key = resolveApiKey(opts)
	const headers: Record<string, string> = {}
	if (key) {
		headers.Authorization = `Bearer ${key}`
	}
	if (method !== "GET" && method !== "HEAD") {
		headers["Content-Type"] = "application/json"
	}
	return headers
}

async function apiFetch<T>(
	opts: SqrrlClientOptions,
	path: string,
	init: RequestInit,
	retryPolicy: RetryPolicy,
	requestOptions?: SqrrlRequestOptions,
	parse: ResponseParse = "json",
): Promise<T> {
	const url = `${resolveBaseUrl(opts)}${path}`
	const method = (init.method ?? "GET").toUpperCase()
	const maxRetries = opts.maxRetries ?? 2
	let attempt = 0
	const context = createRequestContext(opts, requestOptions)
	const waitForTransportRetry = async (): Promise<boolean> => {
		if (retryPolicy === "never" || attempt >= maxRetries) {
			return false
		}
		const delayMs = 200 * 2 ** attempt
		if (delayMs >= context.remainingMs()) {
			return false
		}
		attempt += 1
		await sleep(delayMs, context)
		return true
	}
	try {
		for (;;) {
			if (context.signal.aborted) {
				throw requestAbortError(context.abortKind() ?? "caller")
			}
			let res: Response
			try {
				res = await fetch(url, {
					...init,
					headers: { ...buildHeaders(opts, method), ...init.headers },
					signal: context.signal,
				})
			} catch (error) {
				const abortKind = context.abortKind()
				if (abortKind) {
					throw requestAbortError(abortKind)
				}
				if (await waitForTransportRetry()) {
					continue
				}
				throw error
			}
			if (res.ok) {
				if (parse === "text") {
					return (await res.text()) as T
				}
				try {
					return (await res.json()) as T
				} catch (error) {
					if (error instanceof TypeError && (await waitForTransportRetry())) {
						continue
					}
					throw error
				}
			}
			let text: string
			try {
				text = await res.text()
			} catch (error) {
				if (error instanceof TypeError && (await waitForTransportRetry())) {
					continue
				}
				throw error
			}
			if (
				retryPolicy !== "never" &&
				(res.status === 429 || res.status === 503) &&
				attempt < maxRetries
			) {
				const delayMs = retryDelayMs(res, attempt)
				if (delayMs >= context.remainingMs()) {
					throw new SqrrlClientError(res.status, text)
				}
				attempt += 1
				await sleep(delayMs, context)
				continue
			}
			throw new SqrrlClientError(res.status, text)
		}
	} catch (error) {
		const abortKind = context.abortKind()
		if (abortKind && !(error instanceof SqrrlClientError && error.code)) {
			throw requestAbortError(abortKind)
		}
		throw error
	} finally {
		context.cleanup()
	}
}

export async function apiPost<T>(
	opts: SqrrlClientOptions,
	path: string,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
	retryPolicy: RetryPolicy = "never",
	requestOptions?: SqrrlRequestOptions,
): Promise<T> {
	return apiFetch<T>(
		opts,
		path,
		{
			method: "POST",
			body: JSON.stringify(body),
			headers,
		},
		retryPolicy,
		requestOptions,
	)
}

export async function apiGet<T>(
	opts: SqrrlClientOptions,
	path: string,
	requestOptions?: SqrrlRequestOptions,
): Promise<T> {
	return apiFetch<T>(opts, path, { method: "GET" }, "safe", requestOptions)
}

/**
 * GET that resolves to the raw response body text instead of parsed JSON.
 * Used for wiki GET with format=markdown|html, where the API deliberately
 * returns a non-JSON body.
 */
export async function apiGetText(
	opts: SqrrlClientOptions,
	path: string,
	requestOptions?: SqrrlRequestOptions,
): Promise<string> {
	return apiFetch<string>(
		opts,
		path,
		{ method: "GET" },
		"safe",
		requestOptions,
		"text",
	)
}

export async function apiPatch<T>(
	opts: SqrrlClientOptions,
	path: string,
	body: Record<string, unknown>,
	requestOptions?: SqrrlRequestOptions,
): Promise<T> {
	return apiFetch<T>(
		opts,
		path,
		{
			method: "PATCH",
			body: JSON.stringify(body),
		},
		"never",
		requestOptions,
	)
}

export async function apiPut<T>(
	opts: SqrrlClientOptions,
	path: string,
	body: Record<string, unknown>,
	requestOptions?: SqrrlRequestOptions,
): Promise<T> {
	return apiFetch<T>(
		opts,
		path,
		{
			method: "PUT",
			body: JSON.stringify(body),
		},
		"safe",
		requestOptions,
	)
}

export async function apiDelete<T>(
	opts: SqrrlClientOptions,
	path: string,
	requestOptions?: SqrrlRequestOptions,
): Promise<T> {
	return apiFetch<T>(opts, path, { method: "DELETE" }, "never", requestOptions)
}
