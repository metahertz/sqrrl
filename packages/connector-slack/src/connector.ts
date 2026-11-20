// One Slack sync pass (roadmap, Phase 6.2).
//
//   1. who am I (auth.test), and everyone's names and emails (users.list);
//   2. every conversation I am in: channels, private channels, group DMs,
//      DMs (users.conversations), filtered by the configured lists;
//   3. per conversation, its recent history and the replies to recent
//      threads, grouped into local days;
//   4. each day goes to /v1/raw/sync as a complete window for that
//      conversation, so a deleted message is retired (thread replies are
//      exempt: Slack cannot cheaply list every reply to an old thread);
//   5. each day that changed and has enough text is distilled through
//      /v1/wiki/maintenance like a note: a page per conversation-day with
//      claims, tasks with owners and topics;
//   6. that page is linked to the people/ pages of whoever spoke, through
//      the API's shared people resolver (the same rules as email and
//      calendar; a new page only for a speaker in a small conversation).
//
// A conversation with no activity for coldAfterDays is read at most once a
// day, so a long tail of old DMs does not cost a history call every run.

import type { SlackConfig } from "./config.js"
import {
	type DayMessage,
	dayWindow,
	isContent,
	isReply,
	localDay,
	type Names,
	renderTranscript,
	slackText,
	tsToDate,
} from "./format.js"
import type {
	SlackApi,
	SlackConversation,
	SlackMessage,
	SlackUser,
} from "./slack-api.js"
import { type SlackState, saveState } from "./state.js"

export type RawMessageItem = {
	source: "slack"
	sourceId: string
	kind: "message"
	text: string
	title?: string
	unit: string
	occurredAt: string
	channel: string
	thread?: string
	author?: string
	participants?: string[]
	attachments?: Array<{ name: string; ref: string; contentType?: string }>
	metadata: Record<string, unknown>
}

/** The slice of SqrrlClient the connector uses, so tests can fake it. */
export interface SlackWriter {
	rawSync(input: {
		scope: string
		scopeRef: string
		source: string
		items: RawMessageItem[]
		window: { from: string; to: string }
		channel: string
		excludeReplies: boolean
	}): Promise<unknown>
	wikiMaintenance(
		input: {
			scope: string
			scopeRef: string
			changedSources: Array<{ path: string; content: string }>
			extractTasks?: boolean
			noteDate?: string
		},
		requestOptions?: { timeoutMs?: number },
	): Promise<{ errors: string[]; pagesCreated: number; pagesUpdated: number }>
	/** Links a page to people through the API's shared resolver. */
	linkPeople(input: {
		scope: string
		scopeRef: string
		slug: string
		title?: string
		edgeKind?: string
		maxNewPeople?: number
		people: Array<{
			name?: string
			email?: string
			create?: boolean
			weight?: number
		}>
	}): Promise<{ linked: number; created: number }>
}

export interface RunSummary {
	conversations: number
	skippedCold: number
	messages: number
	daysSynced: number
	daysDistilled: number
	retired: number
	peopleLinked: number
	peopleCreated: number
	errors: string[]
}

type Conversation = {
	id: string
	name: string
	slug: string
	kind: string
	members: string[]
}

const DAY_MS = 86400_000

export function slugify(text: string, max = 60): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max)
			.replace(/-+$/, "") || "conversation"
	)
}

/** The page slug the engine gives a maintenance source path (sourceToSlug). */
export function pageSlugFor(path: string): string {
	return `sources/${path
		.toLowerCase()
		.replace(/[^a-z0-9/.]+/g, "-")
		.replace(/^-+|-+$/g, "")}`
}

function displayName(u: SlackUser | undefined, fallback: string): string {
	return (
		u?.profile?.display_name?.trim() ||
		u?.real_name?.trim() ||
		u?.profile?.real_name?.trim() ||
		u?.name ||
		fallback
	)
}

function fullName(u: SlackUser | undefined): string | undefined {
	return u?.real_name?.trim() || u?.profile?.real_name?.trim() || undefined
}

export class SlackConnector {
	constructor(
		private readonly cfg: SlackConfig,
		private readonly slack: SlackApi,
		private readonly writer: SlackWriter,
		private readonly state: SlackState,
		private readonly opts: {
			dryRun?: boolean
			now?: () => Date
			log?: (line: string) => void
		} = {},
	) {}

	private log(line: string) {
		;(this.opts.log ?? console.log)(line)
	}

	async run(): Promise<RunSummary> {
		const now = this.opts.now?.() ?? new Date()
		const out: RunSummary = {
			conversations: 0,
			skippedCold: 0,
			messages: 0,
			daysSynced: 0,
			daysDistilled: 0,
			retired: 0,
			peopleLinked: 0,
			peopleCreated: 0,
			errors: [],
		}
		const me = await this.slack.authTest()
		const users = new Map((await this.slack.users()).map((u) => [u.id, u]))
		const all = await this.slack.conversations(this.cfg.types)
		const conversations: Conversation[] = []
		for (const c of all) {
			const conv = await this.describe(c, users, me.user_id)
			if (conv) conversations.push(conv)
		}
		const names: Names = {
			user: (id) => displayName(users.get(id), id),
			channel: (id) => all.find((c) => c.id === id)?.name ?? id,
		}

		for (const conv of conversations) {
			const st = this.state.conversations[conv.id] ?? { name: conv.name }
			const lastActivity = st.lastActivityTs
				? tsToDate(st.lastActivityTs).getTime()
				: 0
			const lastChecked = st.lastCheckedAt ? Date.parse(st.lastCheckedAt) : 0
			if (
				st.firstSyncedAt &&
				now.getTime() - lastActivity > this.cfg.coldAfterDays * DAY_MS &&
				now.getTime() - lastChecked < DAY_MS
			) {
				out.skippedCold++
				continue
			}
			out.conversations++
			try {
				await this.syncConversation(
					conv,
					st,
					now,
					names,
					users,
					me.user_id,
					out,
				)
				st.name = conv.name
				st.lastCheckedAt = now.toISOString()
				st.firstSyncedAt ??= now.toISOString()
				this.state.conversations[conv.id] = st
				if (!this.opts.dryRun) await saveState(this.cfg.stateFile, this.state)
			} catch (err) {
				out.errors.push(
					`${conv.name}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
		return out
	}

	/** A conversation's readable name and slug, or undefined when the
	 *  channel lists leave it out. */
	private async describe(
		c: SlackConversation,
		users: Map<string, SlackUser>,
		self: string,
	): Promise<Conversation | undefined> {
		if (c.is_im) {
			const other = c.user ? users.get(c.user) : undefined
			if (other?.is_bot || c.user === "USLACKBOT") return undefined
			const name = `DM ${fullName(other) ?? displayName(other, c.user ?? c.id)}`
			return {
				id: c.id,
				name,
				slug: slugify(name),
				kind: "im",
				members: [self, c.user ?? ""].filter(Boolean),
			}
		}
		if (c.is_mpim) {
			const members = (await this.slack.members(c.id)).filter((m) => m !== self)
			const name = `Group DM ${members.map((m) => displayName(users.get(m), m)).join(", ")}`
			return {
				id: c.id,
				name,
				slug: `group-dm-${slugify(members.map((m) => displayName(users.get(m), m)).join(" "), 50)}`,
				kind: "mpim",
				members,
			}
		}
		const channel = c.name ?? c.id
		if (this.cfg.channels.length && !this.cfg.channels.includes(channel))
			return undefined
		if (this.cfg.excludeChannels.includes(channel)) return undefined
		return {
			id: c.id,
			name: `#${channel}`,
			slug: slugify(channel),
			kind: c.is_private ? "private_channel" : "public_channel",
			members: [],
		}
	}

	private async syncConversation(
		conv: Conversation,
		st: SlackState["conversations"][string],
		now: Date,
		names: Names,
		users: Map<string, SlackUser>,
		self: string,
		out: RunSummary,
	) {
		const tz = this.cfg.timeZone
		const reachDays = st.firstSyncedAt
			? this.cfg.refreshDays
			: this.cfg.backfillDays
		// Windows are whole local days, so the first one starts at a midnight.
		const firstDay = localDay(
			new Date(now.getTime() - (reachDays - 1) * DAY_MS),
			tz,
		)
		const syncFrom = dayWindow(firstDay, tz).from
		// History reaches further back than the synced days, to find threads
		// that are older than the window but still getting replies.
		const historyFrom = new Date(
			Math.min(
				syncFrom.getTime(),
				now.getTime() - this.cfg.threadLookbackDays * DAY_MS,
			),
		)
		const oldest = (historyFrom.getTime() / 1000).toFixed(6)
		const history = (await this.slack.history(conv.id, oldest)).filter(
			isContent,
		)
		const parents = new Map(history.map((m) => [m.ts, m]))
		const messages: SlackMessage[] = history.filter(
			(m) => tsToDate(m.ts) >= syncFrom,
		)
		const syncFromTs = (syncFrom.getTime() / 1000).toFixed(6)
		for (const p of history) {
			if (
				!p.reply_count ||
				!p.latest_reply ||
				Number(p.latest_reply) < Number(syncFromTs)
			)
				continue
			const replies = (
				await this.slack.replies(conv.id, p.ts, syncFromTs)
			).filter(isContent)
			for (const r of replies)
				if (!messages.some((m) => m.ts === r.ts)) messages.push(r)
		}
		if (messages.length) {
			const newest = messages.reduce((a, b) =>
				Number(a.ts) > Number(b.ts) ? a : b,
			).ts
			if (!st.lastActivityTs || Number(newest) > Number(st.lastActivityTs))
				st.lastActivityTs = newest
		}
		out.messages += messages.length

		const byDay = new Map<string, SlackMessage[]>()
		for (const m of messages) {
			const day = localDay(tsToDate(m.ts), tz)
			const list = byDay.get(day)
			if (list) list.push(m)
			else byDay.set(day, [m])
		}
		// Every day in the window is sent, empty ones too: an empty day is
		// how a deletion of its last message is noticed.
		const days: string[] = []
		for (let t = syncFrom.getTime(); t < now.getTime(); t += DAY_MS) {
			const d = localDay(new Date(t + 12 * 3600_000), tz)
			if (!days.includes(d)) days.push(d)
		}

		for (const day of days) {
			const dayMessages = byDay.get(day) ?? []
			const window = dayWindow(day, tz)
			const unit = `slack:${conv.id}:${day}`
			const rendered: DayMessage[] = dayMessages.map((m) => ({
				message: m,
				speaker: m.user
					? displayName(users.get(m.user), m.user)
					: (m.username ?? "bot"),
				text: this.messageText(m, names),
				at: tsToDate(m.ts),
			}))
			const items: RawMessageItem[] = rendered.map((r) =>
				this.rawItem(conv, unit, r, names),
			)
			if (this.opts.dryRun) {
				if (items.length)
					this.log(`  ${conv.name} ${day}: ${items.length} message(s)`)
				continue
			}
			const res = (await this.writer.rawSync({
				scope: this.cfg.scope,
				scopeRef: this.cfg.scopeRef,
				source: "slack",
				items,
				window: {
					from: window.from.toISOString(),
					to: window.to.toISOString(),
				},
				channel: conv.id,
				excludeReplies: true,
			})) as { created?: number; updated?: number; retired?: number }
			out.daysSynced++
			out.retired += res.retired ?? 0
			const changed =
				(res.created ?? 0) + (res.updated ?? 0) + (res.retired ?? 0) > 0
			if (!changed || !rendered.length) continue
			// The distiller reads the owner of the token as "me", as in notes:
			// "me" owns tasks without minting a person page for oneself.
			const asMe: Names = {
				user: (id) => (id === self ? "me" : names.user(id)),
				channel: names.channel,
			}
			const transcript = renderTranscript(
				conv.name,
				day,
				rendered.map((r) => ({
					...r,
					speaker: r.message.user === self ? "me" : r.speaker,
					text: this.messageText(r.message, asMe),
				})),
				(ts) => {
					const p = parents.get(ts)
					return p ? this.messageText(p, asMe) : undefined
				},
				tz,
			)
			if (transcript.length < this.cfg.distillMinChars) continue
			const path = `slack/${conv.slug}/${day}`
			const result = await this.writer.wikiMaintenance(
				{
					scope: this.cfg.scope,
					scopeRef: this.cfg.scopeRef,
					changedSources: [{ path, content: transcript }],
					extractTasks: true,
					noteDate: day,
				},
				{ timeoutMs: this.cfg.wikiTimeoutMs },
			)
			if (result.errors.length)
				throw new Error(`distill ${path}: ${result.errors.join("; ")}`)
			out.daysDistilled++
			const linked = await this.linkSpeakers(
				pageSlugFor(path),
				`${conv.name} ${day}`,
				dayMessages,
				users,
				self,
			)
			out.peopleLinked += linked.linked
			out.peopleCreated += linked.created
		}
	}

	private messageText(m: SlackMessage, names: Names): string {
		const files = (m.files ?? []).map(
			(f) => `[file: ${f.title || f.name || "attachment"}]`,
		)
		return [slackText(m.text ?? "", names).trim(), ...files]
			.filter(Boolean)
			.join(" ")
	}

	private rawItem(
		conv: Conversation,
		unit: string,
		r: DayMessage,
		names: Names,
	): RawMessageItem {
		const m = r.message
		const reply = isReply(m)
		return {
			source: "slack",
			sourceId: `${conv.id}:${m.ts}`,
			kind: "message",
			text: r.text,
			title: `${conv.name} — ${r.speaker}`,
			unit,
			occurredAt: r.at.toISOString(),
			channel: conv.id,
			...(m.thread_ts ? { thread: `${conv.id}:${m.thread_ts}` } : {}),
			author: r.speaker,
			...(conv.members.length
				? { participants: conv.members.map((id) => names.user(id)) }
				: {}),
			...(m.files?.length
				? {
						attachments: m.files
							.filter((f) => f.permalink)
							.map((f) => ({
								name: f.title || f.name || "attachment",
								ref: f.permalink as string,
								...(f.mimetype ? { contentType: f.mimetype } : {}),
							})),
					}
				: {}),
			metadata: {
				conversation: conv.name,
				conversationType: conv.kind,
				ts: m.ts,
				...(m.user ? { userId: m.user } : {}),
				...(reply ? { isReply: true, threadTs: m.thread_ts } : {}),
				...(m.reply_count ? { replyCount: m.reply_count } : {}),
				...(m.edited ? { edited: true } : {}),
				...(m.subtype ? { subtype: m.subtype } : {}),
			},
		}
	}

	/** Links a day page to the people who spoke in it, through the shared
	 *  people resolver (POST /v1/wiki/identity/link): an email or full name
	 *  finds the existing page whatever it is called, short names lean on
	 *  the others in the conversation, unclear ones become "same person?"
	 *  questions, and a speaker nobody knows gets a page when the day is a
	 *  conversation, not a broadcast. The owner of the token is "me", as in
	 *  notes, and gets no edge. */
	private async linkSpeakers(
		slug: string,
		title: string,
		messages: SlackMessage[],
		users: Map<string, SlackUser>,
		self: string,
	): Promise<{ linked: number; created: number }> {
		const people: Array<{ name?: string; email?: string; create: boolean }> = []
		for (const id of new Set(
			messages.map((m) => m.user).filter((u): u is string => Boolean(u)),
		)) {
			if (id === self) continue
			const u = users.get(id)
			if (!u || u.is_bot || u.deleted) continue
			const email = u.profile?.email?.trim() || undefined
			const name = fullName(u) ?? displayName(u, "")
			if (!email && !name) continue
			people.push({
				...(name ? { name } : {}),
				...(email ? { email } : {}),
				create: true,
			})
		}
		if (!people.length) return { linked: 0, created: 0 }
		const res = await this.writer.linkPeople({
			scope: this.cfg.scope,
			scopeRef: this.cfg.scopeRef,
			slug,
			title,
			edgeKind: "participant",
			people,
		})
		return { linked: res.linked, created: res.created }
	}
}
