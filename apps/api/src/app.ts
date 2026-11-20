import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { bodyLimit } from "hono/body-limit"
import type { ApiEnvironment, AuthorizedRequestScope } from "./api-context.js"
import { openApiSpec } from "./openapi-spec.js"
import {
	authorizePrincipalRequest,
	createDevelopmentPrincipal,
	parseScopedApiKeyPolicies,
	resolveBearerPrincipal,
	timingSafeBearerEquals,
	type ApiPrincipal,
	type PrincipalCapability,
} from "./principal.js"
import { resolveStoredKeyPrincipal } from "./db-api-keys.js"
import { createAnswerRouter } from "./routes/answer.js"
import { createMailRouter } from "./routes/mail.js"
import { createSettingsRouter } from "./routes/settings.js"
import {
	createTaskReviewRouter,
	createTaskSuggestionsRouter,
} from "./routes/task-suggestions.js"
import { createDecisionsRouter } from "./routes/decisions.js"
import { createIdentityRouter } from "./routes/identity.js"
import { createStatusRouter } from "./routes/status.js"
import { checkRawStoreReadiness, createRawRouter } from "./routes/raw.js"
import { createV1Router } from "./routes/v1.js"
import { WIKI_SCOPE_VALUES, type WikiScope } from "@sqrrl/wiki-engine"
import {
	createWikiBrowseRouter,
	readWikiSessionCookie,
	WIKI_LOGIN_PATH,
} from "./routes/wiki-browse.js"
import { checkWikiStoreReadiness } from "./wiki-store-runtime.js"

let unauthenticatedApiWarningEmitted = false
const SCOPES = new Set<string>(WIKI_SCOPE_VALUES)
const SCOPE_VALIDATION_MESSAGE = `scope must be ${WIKI_SCOPE_VALUES.join("|")}`
const READINESS_CACHE_MS = 1_000

export { parseScopedApiKeyPolicies, timingSafeBearerEquals }

export function resetUnauthenticatedApiWarningForTests(): void {
	unauthenticatedApiWarningEmitted = false
}

async function checkReadinessDependencies() {
	return Promise.allSettled([
		checkWikiStoreReadiness(),
		checkRawStoreReadiness(),
	])
}

async function readRequestScopeInput(
	c: Context<ApiEnvironment>,
): Promise<Record<string, unknown>> {
	const query = c.req.query() as Record<string, unknown>
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		return query
	}
	const contentType = c.req.header("Content-Type") ?? ""
	if (!contentType.toLowerCase().includes("application/json")) {
		return query
	}
	const body = (await c.req.raw
		.clone()
		.json()
		.catch(() => ({}))) as unknown
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return query
	}
	return {
		...(body as Record<string, unknown>),
		requestQuery: query,
	}
}

function stringFieldValues(
	input: Record<string, unknown>,
	field: string,
	includeEmpty = false,
): string[] {
	const containers = [
		input,
		input.handle,
		input.entry,
		input.memory,
		input.params,
		input.requestQuery,
	].filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === "object" && !Array.isArray(item),
	)
	const values = new Set<string>()
	for (const container of containers) {
		const value = container[field]
		if (typeof value === "string" && (includeEmpty || value.trim())) {
			values.add(value.trim())
		}
	}
	return [...values]
}

function isWikiScope(value: string): value is WikiScope {
	return SCOPES.has(value)
}

/** Routes that describe the caller rather than touching scoped data.
 *
 *  A key whose grants name specific scopes must send a scope on every
 *  request. That is right for data routes and wrong for identity: whoami
 *  reports only what the caller already holds, and a console has to call it
 *  BEFORE it knows which scopes the key may use. Without this exemption the
 *  one call that could answer "what am I allowed to do" is itself refused
 *  for lacking an answer to that question. */
const SCOPE_EXEMPT_PATHS = new Set(["/v1/auth/whoami"])

async function authorizeScopedApiKey(
	c: Context<ApiEnvironment>,
	principal: ApiPrincipal,
): Promise<{
	forbidden: string | null
	validationError: string | null
	requestScope: AuthorizedRequestScope
}> {
	const input = await readRequestScopeInput(c)
	const agentIds = stringFieldValues(input, "agentId")
	const scopes = stringFieldValues(input, "scope", true)
	const explicitScopeRefs = stringFieldValues(input, "scopeRef")
	const scopeRefs =
		explicitScopeRefs.length > 0
			? explicitScopeRefs
			: stringFieldValues(input, "containerTag")
	const scope = scopes[0]
	const requestScope: AuthorizedRequestScope = {
		...(agentIds[0] ? { agentId: agentIds[0] } : {}),
		...(scope && isWikiScope(scope) ? { scope } : {}),
		...(scopeRefs[0] ? { scopeRef: scopeRefs[0] } : {}),
	}
	const conflict =
		agentIds.length > 1
			? "conflicting agentId values are not allowed"
			: scopes.length > 1
				? "conflicting scope values are not allowed"
				: scopeRefs.length > 1
					? "conflicting scopeRef values are not allowed"
					: null
	if (SCOPE_EXEMPT_PATHS.has(c.req.path)) {
		// Capability is still enforced below via the normal path for every
		// other route; whoami needs only "read", which any usable key holds.
		return { requestScope, validationError: null, forbidden: null }
	}
	return {
		requestScope,
		validationError:
			scope !== undefined && !isWikiScope(scope)
				? SCOPE_VALIDATION_MESSAGE
				: null,
		forbidden:
			conflict ??
			authorizePrincipalRequest(principal, {
				...requestScope,
				capability: requiredCapability(c),
			}),
	}
}

const READ_POST_PATHS = new Set([
	"/v1/wiki/search",
	"/v1/wiki/answer",
	"/v1/raw/search",
])

const WRITE_POST_PATHS = new Set([
	"/v1/wiki",
	"/v1/wiki/okf-import",
	"/v1/wiki/maintenance",
	"/v1/wiki/restore",
	"/v1/wiki/relationships",
	"/v1/wiki/merge",
	"/v1/wiki/tasks/reassign",
	"/v1/wiki/purge",
	"/v1/raw/items",
	"/v1/raw/sync",
	"/v1/raw/mail",
	"/v1/wiki/task-review/run",
	"/v1/wiki/task-review/task",
	"/v1/wiki/task-review/sweep",
])

function requiredCapability(c: Context<ApiEnvironment>): PrincipalCapability {
	const path = c.req.path
	if (path.startsWith("/v1/admin/")) {
		return "administer"
	}
	if (path === "/v1/wiki/okf-export") return "export"
	if (
		path === "/v1/lifecycle/delete" ||
		path === "/v1/wiki/purge" ||
		(c.req.method === "DELETE" && c.req.query("hard") === "true")
	) {
		return "hard-delete"
	}
	if (c.req.method === "GET" || c.req.method === "HEAD") return "read"
	if (c.req.method === "PATCH" || c.req.method === "DELETE") return "write"
	if (READ_POST_PATHS.has(path)) return "read"
	// Accepting closes a task; dismissing records a decision.
	if (/^\/v1\/wiki\/task-suggestions\/[^/]+\/(accept|dismiss)$/.test(path))
		return "write"
	// Accepting moves a link or merges two people; the bulk cleanup
	// (/v1/wiki/identity/cleanup) stays administer.
	if (/^\/v1\/wiki\/identity\/suggestions\/[^/]+\/(accept|dismiss)$/.test(path))
		return "write"
	// A queued accept/dismiss: the same capability as deciding directly.
	if (path === "/v1/wiki/decisions") return "write"
	// Who "me" is: an ordinary curation write.
	if (path === "/v1/wiki/identity/self") return "write"
	// A connector linking a page it wrote to the people in it.
	if (path === "/v1/wiki/identity/link") return "write"
	if (WRITE_POST_PATHS.has(path)) return "write"
	return "administer"
}

/**
 * Graceful shutdown: Process-level graceful shutdown orchestrator.
 *
 * Registers listeners for SIGTERM / SIGINT that:
 *  1. Stop accepting new HTTP connections (`closeServer`).
 *  2. Close the wiki store (and with it the raw item store, which shares it).
 *  3. Call `exit(0)` when both succeed, or `exit(1)` if the timeout elapses
 *     first — never block the container runtime's kill window indefinitely.
 *
 * Server and store close are awaited in sequence (server first, so no new
 * requests land while the stores are shutting down). The function accepts
 * the process and an `exit` function as injected dependencies so the test
 * suite can drive it without actually exiting.
 */
export type GracefulShutdownOptions = {
	signals: readonly NodeJS.Signals[]
	process: NodeJS.Process
	closeServer: () => Promise<void>
	closeStores: () => Promise<void>
	exit: (code: number) => void
	/** Hard deadline for the full shutdown sequence before force-exit. */
	timeoutMs?: number
}

export function registerGracefulShutdown(
	options: GracefulShutdownOptions,
): void {
	const {
		signals,
		process: proc,
		closeServer,
		closeStores,
		exit,
		timeoutMs = 10_000,
	} = options
	let shuttingDown = false

	const runShutdown = (signal: NodeJS.Signals): void => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true

		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			// Cannot wait any longer — exit non-zero so orchestrators know we
			// shed work under duress instead of exiting cleanly.
			try {
				exit(1)
			} catch {
				// exit() may be a stub; ignore.
			}
		}, timeoutMs)
		// setTimeout handles have .unref() in Node — do not hold the event loop.
		if (
			typeof (timer as unknown as { unref?: () => void }).unref === "function"
		) {
			;(timer as unknown as { unref: () => void }).unref()
		}

		;(async () => {
			try {
				await closeServer()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`graceful shutdown: closeServer failed: ${msg}`)
			}
			try {
				await closeStores()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`graceful shutdown: closeStores failed: ${msg}`)
			}
			if (timedOut) {
				return
			}
			clearTimeout(timer)
			try {
				exit(0)
			} catch {
				// exit() may be a stub; ignore.
			}
			void signal // marker — signal identity recorded via the event only
		})()
	}

	for (const signal of signals) {
		proc.on(signal, () => runShutdown(signal))
	}
}

/** The browsable wiki lives outside /v1 so its URLs are short enough to be
 *  typed and shared. It reuses /v1's auth and rate limiting rather than
 *  running unguarded — the only difference is where the token may come from
 *  and what an unauthenticated response looks like. */
const BROWSE_PREFIX = "/wiki"

function isBrowsePath(c: Context<ApiEnvironment>): boolean {
	const path = c.req.path
	return path === BROWSE_PREFIX || path.startsWith(`${BROWSE_PREFIX}/`)
}

/** Login and logout must stay reachable without a credential, or signing in
 *  would require already being signed in. */
function isBrowsePublicPath(c: Context<ApiEnvironment>): boolean {
	return c.req.path === WIKI_LOGIN_PATH || c.req.path === "/wiki/_logout"
}

/** Bearer token for the request. Browse paths may present it as the
 *  path-scoped session cookie, because a browser following a link sends no
 *  Authorization header. /v1 is header-only: the cookie must never become a
 *  second way to reach the JSON API. */
function readRequestBearer(c: Context<ApiEnvironment>): string {
	const auth = c.req.header("Authorization") ?? ""
	if (auth.startsWith("Bearer ")) return auth.slice(7).trim()
	if (isBrowsePath(c)) return readWikiSessionCookie(c)?.trim() ?? ""
	return ""
}

/** A browser gets sent to the login form; an API client gets JSON 401. */
function unauthorizedResponse(c: Context<ApiEnvironment>): Response {
	if (isBrowsePath(c)) {
		const url = new URL(c.req.url)
		const next = `${url.pathname}${url.search}`
		return c.redirect(
			`${WIKI_LOGIN_PATH}?next=${encodeURIComponent(next)}`,
			302,
		)
	}
	return c.json(
		{ error: { code: "UNAUTHORIZED", message: "unauthorized" } },
		401,
	)
}

export function createApp(): Hono<ApiEnvironment> {
	const app = new Hono<ApiEnvironment>()
	let readinessCache:
		| {
				expiresAt: number
				result: Awaited<ReturnType<typeof checkReadinessDependencies>>
		  }
		| undefined
	let readinessInFlight:
		| ReturnType<typeof checkReadinessDependencies>
		| undefined
	const loadReadiness = () => {
		const now = Date.now()
		if (readinessCache && readinessCache.expiresAt > now) {
			return Promise.resolve(readinessCache.result)
		}
		if (!readinessInFlight) {
			readinessInFlight = checkReadinessDependencies()
				.then((result) => {
					readinessCache = {
						expiresAt: Date.now() + READINESS_CACHE_MS,
						result,
					}
					return result
				})
				.finally(() => {
					readinessInFlight = undefined
				})
		}
		return readinessInFlight
	}

	const corsOrigins = process.env.SQRRL_API_CORS_ORIGINS?.trim()
	app.use(
		"/*",
		cors(
			corsOrigins
				? { origin: corsOrigins.split(",").map((o) => o.trim()) }
				: {},
		),
	)

	// Request body size cap (413 on oversized payloads). The rate limiter
	// bounds request frequency, not payload size — this closes that gap.
	// Configure via SQRRL_API_MAX_BODY_BYTES (default 2 MiB). Set 0 to
	// disable.
	const maxBodyBytes = Number(
		process.env.SQRRL_API_MAX_BODY_BYTES ?? 2 * 1024 * 1024,
	)
	if (maxBodyBytes > 0) {
		// JSON like every other error, so clients can show why: Hono's
		// default is a bare "Payload Too Large" text body.
		app.use(
			"/v1/*",
			bodyLimit({
				maxSize: maxBodyBytes,
				onError: (c) =>
					c.json(
						{
							error: {
								code: "PAYLOAD_TOO_LARGE",
								message: `request body is over the ${maxBodyBytes}-byte limit (SQRRL_API_MAX_BODY_BYTES); send it in smaller parts`,
							},
						},
						413,
					),
			}),
		)
	}

	app.use("/v1/*", async (c, next) => {
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			const contentType = c.req.header("Content-Type")
			const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
			const hasBody = c.req.raw.body !== null
			if ((hasBody || mediaType) && mediaType !== "application/json") {
				return c.json(
					{
						error: {
							code: "UNSUPPORTED_MEDIA_TYPE",
							message: "Content-Type must be application/json",
						},
					},
					415,
				)
			}
		}
		await next()
	})

	// Simple in-memory rate limiter (per-IP, sliding window).
	// No external deps — sufficient for single-instance dev/small-scale deploy.
	// Configure via SQRRL_API_RATE_LIMIT_MAX (default 100) and
	// SQRRL_API_RATE_LIMIT_WINDOW_MS (default 60000). Set MAX=0 to disable.
	// IP resolution: when SQRRL_API_TRUST_PROXY=true, trusts X-Forwarded-For
	// (for deployments behind a reverse proxy that overwrites the header).
	// Default: uses x-real-ip or "unknown" — does NOT trust X-Forwarded-For
	// to prevent header-spoofing bypass of the rate limit.
	const rateLimitWindowMs = Number(
		process.env.SQRRL_API_RATE_LIMIT_WINDOW_MS ?? 60_000,
	)
	const rateLimitMax = Number(process.env.SQRRL_API_RATE_LIMIT_MAX ?? 100)
	const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

	const rateLimitMiddleware = async (
		c: Context<ApiEnvironment>,
		next: () => Promise<void>,
	) => {
		if (rateLimitMax <= 0) {
			await next()
			return
		}
		const trustProxy = process.env.SQRRL_API_TRUST_PROXY === "true"
		const ip = trustProxy
			? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
				c.req.header("x-real-ip") ??
				"unknown")
			: (c.req.header("x-real-ip") ?? "unknown")
		const now = Date.now()
		const entry = rateLimitMap.get(ip)
		if (!entry || now > entry.resetAt) {
			rateLimitMap.set(ip, { count: 1, resetAt: now + rateLimitWindowMs })
			await next()
			return
		}
		entry.count++
		if (entry.count > rateLimitMax) {
			c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)))
			return c.json(
				{
					error: {
						code: "RATE_LIMITED",
						message: "Rate limit exceeded. Try again later.",
					},
				},
				429,
			)
		}
		await next()
	}
	app.use("/v1/*", rateLimitMiddleware)
	// Browse pages are HTML served from the same process; leaving them off the
	// limiter would hand an unauthenticated scraper a free lane into Mongo.
	app.use("/wiki/*", rateLimitMiddleware)

	const token = process.env.SQRRL_API_KEY?.trim()
	const scopedCredentials = parseScopedApiKeyPolicies()
	if (token && scopedCredentials.some((c) => c.token === token)) {
		throw new Error(
			"SQRRL_API_KEY duplicates a scoped API key token; tokens must be unique",
		)
	}
	if (token || scopedCredentials.length > 0) {
		const authMiddleware = async (
			c: Context<ApiEnvironment>,
			next: () => Promise<void>,
		) => {
			const bearer = readRequestBearer(c)
			// Master first: it is the only identity allowed to manage keys, and
			// deciding that here (rather than from the resolved principal's
			// fields) is what stops a stored key claiming admin for itself.
			const isMasterKey = Boolean(
				token && timingSafeBearerEquals(bearer, token),
			)
			let principal = resolveBearerPrincipal({
				bearer,
				adminToken: token,
				adminSubjectId:
					process.env.SQRRL_API_ADMIN_SUBJECT_ID?.trim() || undefined,
				scopedCredentials,
			})
			// Env-configured keys win over stored ones: a key pinned in the
			// environment is the operator's override and must not be
			// shadowed by a database row.
			if (!principal) {
				principal = await resolveStoredKeyPrincipal(bearer)
			}
			if (!principal) {
				return unauthorizedResponse(c)
			}
			c.set("isMasterKey", isMasterKey)
			const { forbidden, validationError, requestScope } =
				await authorizeScopedApiKey(c, principal)
			if (validationError) {
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: validationError,
						},
					},
					400,
				)
			}
			if (forbidden) {
				return c.json({ error: { code: "FORBIDDEN", message: forbidden } }, 403)
			}
			c.set("principal", principal)
			c.set("authorizedRequestScope", requestScope)
			await next()
		}
		app.use("/v1/*", authMiddleware)
		// Same credential check for the browse UI; the only difference is
		// that readRequestBearer will also accept the session cookie and
		// unauthorizedResponse redirects to the login form.
		app.use("/wiki/*", async (c, next) => {
			if (isBrowsePublicPath(c)) return next()
			return authMiddleware(c, next)
		})
	} else {
		const isProduction =
			process.env.NODE_ENV === "production" ||
			process.env.SQRRL_ENV === "production"
		if (isProduction) {
			throw new Error(
				"SQRRL_API_KEY is not set and SQRRL_API_SCOPED_KEYS is empty. Refusing to start in production mode with unauthenticated /v1 routes. Set SQRRL_API_KEY or SQRRL_API_SCOPED_KEYS, or set NODE_ENV=development.",
			)
		}
		// Fail-open development access is opt-in: staging/preview/QA or an
		// unset environment must not silently install a full-capability
		// principal just because the env is not named exactly "production".
		if (process.env.SQRRL_ALLOW_DEV_PRINCIPAL !== "1") {
			throw new Error(
				"SQRRL_API_KEY is not set and SQRRL_API_SCOPED_KEYS is empty, and the unauthenticated development principal is not explicitly allowed. Set SQRRL_API_KEY, set SQRRL_API_SCOPED_KEYS, or opt in to the development principal with SQRRL_ALLOW_DEV_PRINCIPAL=1 for trusted local development only.",
			)
		}
		if (!unauthenticatedApiWarningEmitted) {
			unauthenticatedApiWarningEmitted = true
			console.warn(
				"WARNING: SQRRL_ALLOW_DEV_PRINCIPAL=1 is set with no SQRRL_API_KEY and empty SQRRL_API_SCOPED_KEYS; /v1 routes run as the unauthenticated development principal. Use only for trusted local development.",
			)
		}
	}
	if (!token && scopedCredentials.length === 0) {
		const devAuthMiddleware = async (
			c: Context<ApiEnvironment>,
			next: () => Promise<void>,
		) => {
			const principal = createDevelopmentPrincipal()
			// The development principal already holds every capability, so
			// gating key management away from it would only be theatre.
			c.set("isMasterKey", true)
			const { forbidden, validationError, requestScope } =
				await authorizeScopedApiKey(c, principal)
			if (validationError) {
				return c.json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: validationError,
						},
					},
					400,
				)
			}
			if (forbidden) {
				return c.json({ error: { code: "FORBIDDEN", message: forbidden } }, 403)
			}
			c.set("principal", principal)
			c.set("authorizedRequestScope", requestScope)
			await next()
		}
		app.use("/v1/*", devAuthMiddleware)
		app.use("/wiki/*", async (c, next) => {
			if (isBrowsePublicPath(c)) return next()
			return devAuthMiddleware(c, next)
		})
	}

	app.get("/health", (c) => c.json({ ok: true, service: "sqrrl-api" }))
	app.get("/ready", async (c) => {
		const [wiki, raw] = await loadReadiness()
		const dependencies = [
			...(wiki.status === "rejected" ? ["wiki"] : []),
			...(raw.status === "rejected" ? ["raw"] : []),
		]
		if (wiki.status === "rejected" || raw.status === "rejected") {
			return c.json(
				{
					ok: false,
					service: "sqrrl-api",
					error: {
						code: "DEPENDENCY_NOT_READY",
						message: "The wiki or raw item store is not ready",
						dependencies,
					},
				},
				503,
			)
		}
		return c.json({
			ok: true,
			service: "sqrrl-api",
			wiki: wiki.value,
			raw: raw.value,
		})
	})
	app.get("/openapi.json", (c) => c.json(openApiSpec))
	app.route("/v1/raw/mail", createMailRouter())
	app.route("/v1/raw", createRawRouter())
	app.route("/v1/wiki/answer", createAnswerRouter())
	app.route("/v1/wiki/task-suggestions", createTaskSuggestionsRouter())
	app.route("/v1/wiki/status", createStatusRouter())
	app.route("/v1/wiki/identity", createIdentityRouter())
	app.route("/v1/wiki/decisions", createDecisionsRouter())
	app.route("/v1/wiki/task-review", createTaskReviewRouter())
	app.route("/v1/admin/settings", createSettingsRouter())
	app.route("/v1", createV1Router())
	app.route("/wiki", createWikiBrowseRouter())

	return app
}
