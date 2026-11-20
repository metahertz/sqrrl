// The slice of the Slack Web API the connector reads, with the two things
// every caller needs: cursor paging and rate-limit backoff.
//
// Read-only by construction: only GET methods that list or read are here.
// Authenticated with a user token (xoxp-), so it sees exactly what the user
// sees, DMs included, and nothing more.

export class SlackApiError extends Error {
	constructor(
		readonly method: string,
		readonly code: string,
	) {
		super(`slack ${method}: ${code}`)
	}
}

export interface SlackUser {
	id: string
	name?: string
	deleted?: boolean
	is_bot?: boolean
	real_name?: string
	tz?: string
	profile?: { display_name?: string; real_name?: string; email?: string }
}

export interface SlackConversation {
	id: string
	name?: string
	is_channel?: boolean
	is_group?: boolean
	is_im?: boolean
	is_mpim?: boolean
	is_private?: boolean
	is_archived?: boolean
	/** The other person, for a DM. */
	user?: string
}

export interface SlackFile {
	name?: string
	title?: string
	mimetype?: string
	permalink?: string
}

export interface SlackMessage {
	type?: string
	subtype?: string
	ts: string
	user?: string
	bot_id?: string
	username?: string
	text?: string
	thread_ts?: string
	reply_count?: number
	latest_reply?: string
	edited?: { ts: string }
	files?: SlackFile[]
}

type Fetch = typeof globalThis.fetch

export class SlackApi {
	constructor(
		private readonly token: string,
		private readonly opts: {
			baseUrl?: string
			fetchFn?: Fetch
			/** Waits are injectable so tests do not sleep. */
			sleep?: (ms: number) => Promise<void>
			maxRetries?: number
		} = {},
	) {}

	private async call<T>(
		method: string,
		params: Record<string, string | number | boolean | undefined>,
	): Promise<T> {
		const base = (this.opts.baseUrl ?? "https://slack.com/api").replace(
			/\/$/,
			"",
		)
		const qs = new URLSearchParams()
		for (const [k, v] of Object.entries(params))
			if (v !== undefined) qs.set(k, String(v))
		const fetchFn = this.opts.fetchFn ?? globalThis.fetch
		const sleep =
			this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
		for (let attempt = 0; ; attempt++) {
			const res = await fetchFn(`${base}/${method}?${qs}`, {
				headers: { authorization: `Bearer ${this.token}` },
			})
			if (res.status === 429 && attempt < (this.opts.maxRetries ?? 6)) {
				const wait = Number(res.headers.get("retry-after") ?? "5")
				await sleep((Number.isFinite(wait) ? wait : 5) * 1000 + 250)
				continue
			}
			if (!res.ok) throw new SlackApiError(method, `http_${res.status}`)
			const body = (await res.json()) as { ok?: boolean; error?: string } & T
			if (!body.ok)
				throw new SlackApiError(method, body.error ?? "unknown_error")
			return body
		}
	}

	private async paginate<T>(
		method: string,
		params: Record<string, string | number | boolean | undefined>,
		key: string,
	): Promise<T[]> {
		const out: T[] = []
		let cursor: string | undefined
		do {
			const page = await this.call<
				Record<string, unknown> & {
					response_metadata?: { next_cursor?: string }
				}
			>(method, { ...params, limit: 200, cursor })
			out.push(...((page[key] as T[] | undefined) ?? []))
			cursor = page.response_metadata?.next_cursor || undefined
		} while (cursor)
		return out
	}

	authTest() {
		return this.call<{
			user_id: string
			user: string
			team: string
			team_id: string
			url: string
		}>("auth.test", {})
	}

	users() {
		return this.paginate<SlackUser>("users.list", {}, "members")
	}

	/** Every conversation the user is a member of, of the given types. */
	conversations(types: string[]) {
		return this.paginate<SlackConversation>(
			"users.conversations",
			{ types: types.join(","), exclude_archived: true },
			"channels",
		)
	}

	members(channel: string) {
		return this.paginate<string>(
			"conversations.members",
			{ channel },
			"members",
		)
	}

	/** Top-level messages (and thread broadcasts) with ts >= oldest. */
	history(channel: string, oldest: string) {
		return this.paginate<SlackMessage>(
			"conversations.history",
			{ channel, oldest, inclusive: true },
			"messages",
		)
	}

	/** A thread's replies with ts >= oldest, without the parent. */
	async replies(channel: string, ts: string, oldest: string) {
		const all = await this.paginate<SlackMessage>(
			"conversations.replies",
			{ channel, ts, oldest, inclusive: true },
			"messages",
		)
		return all.filter((m) => m.ts !== ts)
	}
}
