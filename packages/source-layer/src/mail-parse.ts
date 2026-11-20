// Mail as exported from Mail.app, made into raw items (roadmap, Phase 6.3).
//
// The Mac exporter is deliberately thin: it hands over each message's
// headers, plain-text content, recipients and mailbox. Everything that
// needs judgement happens here, where it can be tested:
//
//   - bulk mail is dropped ("people only"): mailing lists, anything with an
//     unsubscribe header, bulk/auto-submitted precedence, no-reply style
//     senders, and calendar invitations (the calendar connector has those);
//   - quoted history is cut, so a reply stores what was newly said;
//   - the thread is the References root (else In-Reply-To, else itself),
//     so a conversation is one distill unit however many replies it gets;
//   - the message id is the identity, so a message in both Inbox and Sent
//     (or in two accounts) is stored once.

import type { RawItemInput } from "./raw-items.js"

/** One message as the Mac exporter sends it. */
export interface MailRecord {
	mailbox: "inbox" | "sent"
	account?: string
	messageId?: string
	subject?: string
	/** "Name <address>" or a bare address. */
	sender?: string
	dateReceived?: string
	dateSent?: string
	/** The raw RFC 822 header block. */
	headers?: string
	/** Plain-text body. */
	content?: string
	to?: Array<{ name?: string; address?: string }>
	cc?: Array<{ name?: string; address?: string }>
	attachments?: string[]
}

export interface MailAddress {
	name?: string
	email: string
	self?: boolean
}

export type MailSkipReason = "bulk" | "calendar" | "no-id" | "empty"

const BODY_CHARS = 8000

/** Header names lowercased, folded lines joined, repeats kept in order. */
export function parseHeaders(raw: string | undefined): Map<string, string[]> {
	const out = new Map<string, string[]>()
	if (!raw) return out
	const unfolded = raw.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ")
	for (const line of unfolded.split("\n")) {
		const at = line.indexOf(":")
		if (at <= 0) continue
		const name = line.slice(0, at).trim().toLowerCase()
		const value = line.slice(at + 1).trim()
		const list = out.get(name)
		if (list) list.push(value)
		else out.set(name, [value])
	}
	return out
}

export function parseAddress(raw: string | undefined): MailAddress | undefined {
	if (!raw?.trim()) return undefined
	const angle = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
	if (angle) {
		const email = angle[2].trim().toLowerCase()
		const name = angle[1].trim()
		return name && name.toLowerCase() !== email ? { name, email } : { email }
	}
	const bare = raw.trim().match(/^[^\s@]+@[^\s@]+$/)
	return bare ? { email: raw.trim().toLowerCase() } : undefined
}

/** Message ids without angle brackets, lowercased. */
export function messageIds(value: string | undefined): string[] {
	return [...(value ?? "").matchAll(/<([^>\s]+)>/g)].map((m) =>
		m[1].toLowerCase(),
	)
}

function normId(id: string | undefined): string | undefined {
	const t = id?.trim().replace(/^<|>$/g, "").toLowerCase()
	return t || undefined
}

export function threadRoot(
	record: MailRecord,
	headers: Map<string, string[]>,
): string | undefined {
	const refs = messageIds(headers.get("references")?.join(" "))
	if (refs.length) return refs[0]
	const reply = messageIds(headers.get("in-reply-to")?.join(" "))
	if (reply.length) return reply[0]
	return normId(record.messageId ?? headers.get("message-id")?.[0])
}

const NO_REPLY =
	/^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|marketing|updates?|digest|automated|system)([+._-]|@)/i

/** Mail a person did not write to you. Sent mail is yours, so only an
 *  auto-reply of your own counts. */
export function bulkReason(
	record: MailRecord,
	headers: Map<string, string[]>,
): MailSkipReason | undefined {
	const auto = headers.get("auto-submitted")?.[0]?.toLowerCase()
	if (auto && auto !== "no") return "bulk"
	if (record.mailbox === "sent") return undefined
	const subject = record.subject ?? headers.get("subject")?.[0] ?? ""
	const type = headers.get("content-type")?.join(" ").toLowerCase() ?? ""
	if (
		type.includes("text/calendar") ||
		/^(invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event)\b.*:/i.test(
			subject,
		)
	)
		return "calendar"
	if (
		headers.has("list-id") ||
		headers.has("list-unsubscribe") ||
		headers.has("list-post")
	)
		return "bulk"
	const precedence = headers.get("precedence")?.[0]?.toLowerCase()
	if (precedence && ["bulk", "list", "junk"].includes(precedence)) return "bulk"
	if (headers.has("x-autoreply") || headers.has("x-autorespond")) return "bulk"
	const from = parseAddress(record.sender ?? headers.get("from")?.[0])
	if (from && NO_REPLY.test(from.email)) return "bulk"
	return undefined
}

/** The newly written part of a body: quoted history cut at the usual
 *  markers, ">"-quoted lines dropped. */
export function stripQuoted(body: string): string {
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	const out: string[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const next = `${line} ${lines[i + 1] ?? ""}`
		if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line))
			break
		if (/^\s*_{10,}\s*$/.test(line)) break
		if (
			/^\s*On .{4,200}\bwrote:\s*$/i.test(line) ||
			/^\s*On .{4,200}\bwrote:\s*$/i.test(next)
		)
			break
		if (
			/^\s*From:\s.+/i.test(line) &&
			lines.slice(i + 1, i + 5).some((l) => /^\s*(Sent|Date):\s/i.test(l))
		)
			break
		if (/^\s*>/.test(line)) continue
		out.push(line)
	}
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function label(a: MailAddress): string {
	if (a.self) return "me"
	return a.name ? `${a.name} <${a.email}>` : a.email
}

/** A raw item for one message, or why it was skipped. */
export function mailToRawItem(
	record: MailRecord,
	selfAddresses: string[],
):
	| { item: RawItemInput & { thread: string }; root: string }
	| { skip: MailSkipReason } {
	const headers = parseHeaders(record.headers)
	const id = normId(record.messageId ?? headers.get("message-id")?.[0])
	if (!id) return { skip: "no-id" }
	const reason = bulkReason(record, headers)
	if (reason) return { skip: reason }
	const self = new Set(selfAddresses.map((a) => a.toLowerCase()))
	const mark = (a: MailAddress | undefined) =>
		a ? { ...a, ...(self.has(a.email) ? { self: true } : {}) } : undefined
	const from = mark(parseAddress(record.sender ?? headers.get("from")?.[0]))
	const recipients = (list: MailRecord["to"]) =>
		(list ?? [])
			.map((r) =>
				mark(
					r.address
						? {
								email: r.address.toLowerCase(),
								...(r.name?.trim() ? { name: r.name.trim() } : {}),
							}
						: undefined,
				),
			)
			.filter((a): a is MailAddress => Boolean(a))
	const to = recipients(record.to)
	const cc = recipients(record.cc)
	const body = stripQuoted(record.content ?? "")
	const subject =
		(record.subject ?? headers.get("subject")?.[0] ?? "").trim() ||
		"(no subject)"
	if (!body && !(record.attachments ?? []).length) return { skip: "empty" }
	// The sent time, for every copy: the same message in Inbox and Sent must
	// store identically, or each sync would version it again.
	const date = record.dateSent ?? record.dateReceived
	const root = threadRoot(record, headers) ?? id
	const text = [
		`From: ${from ? label(from) : "unknown"}`,
		to.length ? `To: ${to.map(label).join(", ")}` : undefined,
		cc.length ? `Cc: ${cc.map(label).join(", ")}` : undefined,
		`Subject: ${subject}`,
		"",
		body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)} …` : body,
		...(record.attachments?.length
			? ["", `Attachments: ${record.attachments.join(", ")}`]
			: []),
	]
		.filter((l) => l !== undefined)
		.join("\n")
	return {
		root,
		item: {
			source: "email",
			sourceId: id,
			kind: "email",
			text,
			title: subject,
			unit: `email:${root}`,
			thread: root,
			...(date ? { occurredAt: date } : {}),
			...(from ? { author: from.self ? "me" : (from.name ?? from.email) } : {}),
			participants: [
				...new Set(
					[from, ...to, ...cc]
						.filter((a): a is MailAddress => Boolean(a))
						.map((a) => a.email),
				),
			],
			attachments: (record.attachments ?? []).map((name) => ({
				name,
				ref: `mail:${id}/${name}`,
			})),
			metadata: {
				messageId: id,
				subject,
				...(from ? { from } : {}),
				to,
				cc,
				fromSelf: Boolean(from?.self),
				...(messageIds(headers.get("in-reply-to")?.join(" "))[0]
					? { inReplyTo: messageIds(headers.get("in-reply-to")?.join(" "))[0] }
					: {}),
			},
		},
	}
}
