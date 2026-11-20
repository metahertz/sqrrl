// Slack text and days, made readable.
//
// Slack stores mentions and links as tokens (<@U123>, <#C1|general>,
// <https://x|label>); the wiki and the LLM should see names. A "day" is the
// user's local day, since that is how people remember a conversation, so
// windows are computed in a time zone, not in UTC.

import type { SlackMessage } from "./slack-api.js"

export type Names = {
	user: (id: string) => string
	channel: (id: string) => string
}

export function slackText(raw: string, names: Names): string {
	return raw
		.replace(
			/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g,
			(_m, id: string, label?: string) => `@${label ?? names.user(id)}`,
		)
		.replace(
			/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g,
			(_m, id: string, label?: string) => `#${label || names.channel(id)}`,
		)
		.replace(
			/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g,
			(_m, label?: string) => label ?? "@group",
		)
		.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
		.replace(/<!date\^\d+\^[^|>]*\|([^>]+)>/g, "$1")
		.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
		.replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function zoneOffset(at: Date, timeZone: string): number {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(at)
			.map((p) => [p.type, p.value]),
	)
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	)
	return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

export function tsToDate(ts: string): Date {
	return new Date(Math.floor(Number(ts) * 1000))
}

/** "2026-11-17" for the instant, in the zone. */
export function localDay(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(at)
}

export function localClock(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(at)
}

/** The UTC instants bounding a local day: [start, end). DST-safe: each
 *  midnight is found from its own offset. */
export function dayWindow(
	day: string,
	timeZone: string,
): { from: Date; to: Date } {
	const midnight = (d: string) => {
		const [y, m, dd] = d.split("-").map(Number)
		const guess = Date.UTC(y, m - 1, dd)
		const first = guess - zoneOffset(new Date(guess), timeZone)
		return new Date(guess - zoneOffset(new Date(first), timeZone))
	}
	const [y, m, d] = day.split("-").map(Number)
	const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
	return { from: midnight(day), to: midnight(nextDay) }
}

/** Messages that are conversation, not housekeeping. */
export function isContent(m: SlackMessage): boolean {
	const skip = new Set([
		"channel_join",
		"channel_leave",
		"channel_topic",
		"channel_purpose",
		"channel_name",
		"channel_archive",
		"channel_unarchive",
		"group_join",
		"group_leave",
		"pinned_item",
		"bot_add",
		"bot_remove",
	])
	return !m.subtype || !skip.has(m.subtype)
}

export function isReply(m: SlackMessage): boolean {
	return Boolean(m.thread_ts && m.thread_ts !== m.ts)
}

function firstWords(text: string, n = 8): string {
	const words = text.replace(/\s+/g, " ").trim().split(" ")
	return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ")
}

export type DayMessage = {
	message: SlackMessage
	speaker: string
	text: string
	at: Date
}

/** One conversation-day as a transcript the distiller can read: messages
 *  in order, each thread's same-day replies indented under their parent,
 *  and replies to threads from other days marked with what they answer. */
export function renderTranscript(
	title: string,
	day: string,
	messages: DayMessage[],
	parentText: (threadTs: string) => string | undefined,
	timeZone: string,
): string {
	const sorted = [...messages].sort(
		(a, b) => Number(a.message.ts) - Number(b.message.ts),
	)
	const replies = new Map<string, DayMessage[]>()
	const topLevel: DayMessage[] = []
	const tops = new Set(
		sorted.filter((m) => !isReply(m.message)).map((m) => m.message.ts),
	)
	for (const m of sorted) {
		const parent = m.message.thread_ts
		if (isReply(m.message) && parent && tops.has(parent)) {
			const list = replies.get(parent)
			if (list) list.push(m)
			else replies.set(parent, [m])
		} else topLevel.push(m)
	}
	const line = (m: DayMessage) =>
		`${localClock(m.at, timeZone)} ${m.speaker}: ${m.text}`
	const lines = [`${title} — ${day} (Slack)`, ""]
	for (const m of topLevel) {
		if (isReply(m.message)) {
			const about = parentText(m.message.thread_ts as string)
			lines.push(
				`${line(m)}${about ? `  (in thread: “${firstWords(about)}”)` : "  (in a thread)"}`,
			)
		} else lines.push(line(m))
		for (const r of replies.get(m.message.ts) ?? [])
			lines.push(`    ↳ ${line(r)}`)
	}
	return lines.join("\n")
}
