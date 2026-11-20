// Settings → Slack: is a token usable, before the first sync runs?
//
// auth.test says whose token it is and which scopes it has (the
// x-oauth-scopes header); users.conversations counts what it can read. Read
// only: nothing is imported. The token is never echoed back.

/** User scopes the connector needs (packages/connector-slack manifest). */
export const SLACK_SCOPES = [
	"channels:history",
	"channels:read",
	"groups:history",
	"groups:read",
	"im:history",
	"im:read",
	"mpim:history",
	"mpim:read",
	"users:read",
	"users:read.email",
]

export interface SlackCheck {
	ok: boolean
	/** Why it is not usable, in words. */
	error?: string
	team?: string
	user?: string
	url?: string
	missingScopes?: string[]
	conversations?: {
		total: number
		/** True when there were more pages than were counted. */
		more: boolean
		byType: Record<string, number>
	}
	ms: number
}

type Fetch = typeof fetch

const TYPES = "public_channel,private_channel,mpim,im"
const MAX_PAGES = 10

export async function checkSlackToken(
	token: string,
	opts: { baseUrl?: string; fetch?: Fetch; timeoutMs?: number } = {},
): Promise<SlackCheck> {
	const started = Date.now()
	const base = (opts.baseUrl ?? "https://slack.com/api").replace(/\/+$/, "")
	const f = opts.fetch ?? fetch
	const call = async (method: string, params: Record<string, string> = {}) => {
		const res = await f(`${base}/${method}?${new URLSearchParams(params)}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
		})
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
		return { res, body }
	}
	const done = (r: Omit<SlackCheck, "ms">): SlackCheck => ({
		...r,
		ms: Date.now() - started,
	})
	try {
		const auth = await call("auth.test")
		if (auth.body.ok !== true)
			return done({
				ok: false,
				error: slackError(String(auth.body.error ?? auth.res.status)),
			})
		const granted = (auth.res.headers.get("x-oauth-scopes") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
		const missingScopes = granted.length
			? SLACK_SCOPES.filter((s) => !granted.includes(s))
			: []
		const who = {
			team: String(auth.body.team ?? ""),
			user: String(auth.body.user ?? ""),
			url: String(auth.body.url ?? ""),
		}
		const byType: Record<string, number> = {}
		let total = 0
		let cursor = ""
		let pages = 0
		do {
			const page = await call("users.conversations", {
				types: TYPES,
				exclude_archived: "true",
				limit: "200",
				...(cursor ? { cursor } : {}),
			})
			if (page.body.ok !== true)
				return done({
					ok: false,
					...who,
					missingScopes,
					error: slackError(String(page.body.error ?? page.res.status)),
				})
			for (const ch of (page.body.channels as Array<Record<string, unknown>>) ??
				[]) {
				const type = ch.is_im
					? "dm"
					: ch.is_mpim
						? "group dm"
						: ch.is_private
							? "private channel"
							: "channel"
				byType[type] = (byType[type] ?? 0) + 1
				total++
			}
			cursor = String(
				(page.body.response_metadata as { next_cursor?: string } | undefined)
					?.next_cursor ?? "",
			)
			pages++
		} while (cursor && pages < MAX_PAGES)
		return done({
			ok: missingScopes.length === 0,
			...who,
			missingScopes,
			...(missingScopes.length
				? { error: `missing scopes: ${missingScopes.join(", ")}` }
				: {}),
			conversations: { total, more: Boolean(cursor), byType },
		})
	} catch (err) {
		const e = err as {
			name?: string
			cause?: { code?: string }
			message?: string
		}
		return done({
			ok: false,
			error:
				e.name === "TimeoutError"
					? "Slack did not answer in time"
					: `could not reach Slack (${e.cause?.code ?? e.message ?? "error"})`,
		})
	}
}

/** Slack's error codes, in words for the ones a person can act on. */
export function slackError(code: string): string {
	const words: Record<string, string> = {
		invalid_auth: "Slack does not recognize this token",
		not_authed: "no token was sent",
		token_revoked:
			"this token was revoked; reinstall the app and copy the new one",
		account_inactive: "the account behind this token is deactivated",
		missing_scope: "the app is missing a scope; reinstall it from the manifest",
		not_allowed_token_type:
			"Slack refused this token type; use the User OAuth Token (xoxp-)",
		ratelimited: "Slack is rate limiting; try again in a minute",
	}
	return words[code] ?? `Slack said: ${code}`
}
