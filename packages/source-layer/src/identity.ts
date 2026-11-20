// Person references, normalized.
//
// Every source names people differently: a note says "Taylor" or "Taylor M",
// a calendar invite says "taylor.morgan@acme.example" with no name, mail says
// "Morgan, Taylor" or "Lauren Shaw (via Google Docs)" from a Google
// noreply address, a task owner may be "Lauren / Steffan". parseRef turns any
// of these into one shape the resolver (people.ts) can match on:
//
//   - kind: a person, a group (a team or department), or a service (an
//     automated sender: notifications, alerts, role mailboxes, calendars);
//   - a clean display name and its comparison key ("taylor morgan");
//   - the email, only when it is this person's own (a relay address that
//     sends on someone's behalf is dropped);
//   - first name, last name or last initial, for partial matches.
//
// Pure functions, no I/O.

export type RefKind = "person" | "group" | "service"

export interface PersonRefInput {
	name?: string
	email?: string
}

export interface ParsedRef {
	kind: RefKind
	/** Clean display name ("Taylor Morgan"), when there is one. */
	name?: string
	/** nameKey(name): lowercase, no accents or punctuation. */
	key?: string
	/** Lowercased, only when the address belongs to this person or service. */
	email?: string
	/** nameKey of the first word. */
	first?: string
	/** nameKey of the last word, for names of two or more words. */
	last?: string
	/** "Taylor M" / "Taylor M.": the last name's initial. */
	lastInitial?: string
	/** Only a first name is known ("Taylor"). */
	firstOnly: boolean
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/

/** Lowercase, accents and punctuation removed, spaces collapsed. */
export function nameKey(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/['’`]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

export function normalizeEmail(raw: string | undefined): string | undefined {
	if (!raw) return undefined
	const e = raw
		.trim()
		.replace(/^mailto:/i, "")
		.replace(/^<|>$/g, "")
		.toLowerCase()
	return EMAIL_RE.test(e) ? e : undefined
}

// Local parts that send on behalf of a system or a role, not a person.
const SERVICE_LOCAL =
	/(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|notifier|alerts?|autonotification|automated|mailer-daemon|mailer|postmaster|bounces?|calendar|calendar-notification|newsletters?|news|updates?|digest|info|support|help|helpdesk|service|billing|invoices?|receipts?|accounts?|admin|travel|hr|events?|marketing|team|hello|contact|sales|security|feedback|reminders?|jira|confluence|github|gitlab|slack|zoom|drive-shares-dm-noreply|drive-shares-noreply|comments-noreply|successfactors|workday)([._+-]|$)/
const SERVICE_DOMAIN =
	/(^|\.)(group\.calendar\.google\.com|resource\.calendar\.google\.com|calendar\.google\.com|docs\.google\.com|concursolutions\.com|successfactors\.com|amazonses\.com|sendgrid\.net|mailchimp\.com|zendesk\.com)$/

export function isServiceEmail(email: string): boolean {
	const [local = "", domain = ""] = email.split("@")
	return SERVICE_LOCAL.test(local) || SERVICE_DOMAIN.test(domain)
}

// Whole words that make a name a team or a system, not a person.
const SERVICE_WORDS = new Set([
	"noreply",
	"notification",
	"notifications",
	"autonotification",
	"alerts",
	"alert",
	"calendar",
	"newsletter",
	"digest",
	"support",
	"helpdesk",
	"admin",
	"administrator",
	"bot",
	"system",
	"mailer",
	"scheduled",
	"automated",
	"atlas",
	"workday",
	"successfactors",
	"concur",
])
const GROUP_WORDS = new Set([
	"team",
	"teams",
	"group",
	"department",
	"dept",
	"office",
	"hr",
	"marketing",
	"travel",
	"sales",
	"finance",
	"legal",
	"events",
	"partners",
	"committee",
	"org",
	"devrel",
	"engineering",
	"leadership",
	"staff",
	"everyone",
	"all",
	"inc",
	"ltd",
	"llc",
	"corp",
	"gmbh",
	"plc",
])

// "(via Google Docs)", "(Google Slides)": sent by a service for this person.
const RELAY_TAG =
	/\s*\((via [^)]*|google (docs|sheets|slides|drive|calendar|forms)|jira|confluence|slack)\)\s*/gi

/** Strips "(via Google Docs)", "(P)", "[EXT]", quotes, and "Last, First". */
export function cleanName(raw: string): string {
	let s = raw
		.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
		.replace(RELAY_TAG, " ")
		.replace(/\s*\((external|ext|p|she\/her|he\/him|they\/them)\)\s*/gi, " ")
		.replace(/\s*\[(ext|external)\]\s*/gi, " ")
		.replace(/\s+/g, " ")
		.trim()
	// "Blake-Simons, J. (Jorik)", "Jonasson, J.R. (Jack)" -> "Jorik
	// Blake-Simons", "Jack Jonasson".
	const nick = s.match(/^([\p{L}'’-]+),\s*(?:\p{L}\.?\s*)+\(([\p{L}'’-]+)\)$/u)
	if (nick) return `${nick[2]} ${nick[1]}`
	// An address's local part used as a name: "mazen.moreau".
	if (/^[a-z]+(?:[._][a-z]+)+$/.test(s)) return nameFromEmail(s)
	// "Morgan, Taylor" -> "Taylor Morgan" (one comma, a word on each side).
	const m = s.match(/^([\p{L}'’-]+),\s*([\p{L}'’-]+(?: [\p{L}'’-]+)?)$/u)
	if (m) s = `${m[2]} ${m[1]}`
	return s
}

/** "taylor.morgan" -> "Taylor Morgan"; digits and one-letter tags dropped. */
export function nameFromEmail(email: string): string {
	const local = (email.split("@")[0] ?? email).replace(/\+.*$/, "")
	return local
		.split(/[._-]+/)
		.map((w) => w.replace(/\d+/g, ""))
		.filter((w) => w.length > 0)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ")
}

function words(key: string): string[] {
	return key.split(" ").filter(Boolean)
}

function classifyName(key: string): RefKind {
	const ws = words(key)
	if (ws.some((w) => SERVICE_WORDS.has(w))) return "service"
	if (ws.some((w) => GROUP_WORDS.has(w))) return "group"
	if (/\bs team$/.test(key)) return "group"
	return "person"
}

function looksLikeEmail(text: string): boolean {
	return EMAIL_RE.test(text.trim().replace(/^<|>$/g, ""))
}

function withNameParts(ref: ParsedRef): ParsedRef {
	if (!ref.name) return ref
	const key = nameKey(ref.name)
	const ws = words(key)
	const out: ParsedRef = {
		...ref,
		key,
		first: ws[0],
		firstOnly: ws.length === 1,
	}
	if (ws.length >= 2) {
		const lastWord = ws[ws.length - 1]
		// "Taylor M" / "Taylor M." -> initial only.
		if (ws.length === 2 && lastWord.length === 1) {
			out.lastInitial = lastWord
		} else out.last = lastWord
	}
	return out
}

/** One reference, normalized. Undefined when nothing identifies anyone. */
export function parseRef(input: PersonRefInput): ParsedRef | undefined {
	let email = normalizeEmail(input.email)
	let rawName = input.name?.trim() || undefined
	// A name that is really an address (calendar attendees without a name).
	if (rawName && looksLikeEmail(rawName)) {
		email ??= normalizeEmail(rawName)
		rawName = undefined
	}
	const relayed = rawName
		? new RegExp(RELAY_TAG.source, "i").test(rawName)
		: false
	const name = rawName ? cleanName(rawName) : undefined

	if (email && isServiceEmail(email)) {
		// "Lauren Shaw (via Google Docs)" from a noreply address is
		// Lauren, without the address; a bare noreply is the service itself.
		if (name && relayed && classifyName(nameKey(name)) === "person")
			return withNameParts({ kind: "person", name, firstOnly: false })
		return withNameParts({
			kind: "service",
			name: name || nameFromEmail(email) || email,
			email,
			firstOnly: false,
		})
	}

	const finalName = name || (email ? nameFromEmail(email) : undefined)
	if (!finalName) return undefined
	const kind = classifyName(nameKey(finalName))
	return withNameParts({
		kind,
		name: finalName,
		...(email ? { email } : {}),
		firstOnly: false,
	})
}

/** "Lauren / Steffan", "Kai & Nasir", "Kai and Nasir" -> one ref each.
 *  Used for loosely written owners; display names from mail and calendar
 *  go through parseRef, where a comma means "Last, First". */
export function splitRefs(text: string): string[] {
	const t = text.trim()
	if (!t) return []
	const parts = t
		.split(/\s*(?:\/|&|\+|;|\band\b|,)\s*/i)
		.map((p) => p.trim())
		.filter(Boolean)
	// Only split when every part looks like a name (1-3 words, no digits).
	const nameLike = (p: string) =>
		!/\d/.test(p) && p.split(/\s+/).length <= 3 && /^\p{L}/u.test(p)
	return parts.length > 1 && parts.every(nameLike) ? parts : [t]
}

/** True when a known full name could be what a partial ref means:
 *  "Taylor" or "Taylor M" for "Taylor Morgan". */
export function partialMatches(ref: ParsedRef, fullKey: string): boolean {
	const ws = words(fullKey)
	if (ws.length < 2 || !ref.first || ws[0] !== ref.first) return false
	if (ref.firstOnly) return true
	if (ref.lastInitial) return ws[ws.length - 1].startsWith(ref.lastInitial)
	return false
}
