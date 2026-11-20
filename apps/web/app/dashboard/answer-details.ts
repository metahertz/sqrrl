// What the Ask panel shows about how an answer was made, read from the
// POST /v1/wiki/answer response: the time window, who the names are, the
// complete meeting counts and what the citation check changed.

export type AnswerPerson =
	| { text: string; slug: string; title: string }
	| { text: string; candidates: Array<{ slug: string; title: string }> }

export type AnswerVerification =
	| {
			claims: number
			citationsDropped: Array<{ claim: string; citation: string }>
			claimsRemoved: string[]
	  }
	| { unchecked: "no-claims" | "failed" }

export interface AnswerExtras {
	window?: { phrase: string; from: string; to: string }
	people?: AnswerPerson[]
	meetings?: Array<{
		slug: string
		title: string
		count: number
		truncated?: boolean
	}>
	verification?: AnswerVerification
	droppedCitations?: string[]
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")

function day(iso: string): { d: number; m: string; y: number } {
	const t = new Date(iso)
	return {
		d: t.getUTCDate(),
		m: MONTHS[t.getUTCMonth()],
		y: t.getUTCFullYear(),
	}
}

/** "last month · 1–31 Oct 2026". The window's end is exclusive. */
export function windowLabel(w: NonNullable<AnswerExtras["window"]>): string {
	const a = day(w.from)
	const b = day(new Date(Date.parse(w.to) - 1).toISOString())
	const range =
		a.d === b.d && a.m === b.m && a.y === b.y
			? `${a.d} ${a.m} ${a.y}`
			: a.m === b.m && a.y === b.y
				? `${a.d}–${b.d} ${b.m} ${b.y}`
				: a.y === b.y
					? `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`
					: `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`
	return `${w.phrase} · ${range}`
}

export function meetingCount(m: {
	count: number
	truncated?: boolean
}): string {
	const n = m.truncated ? `${m.count}+` : String(m.count)
	return `${n} ${m.count === 1 && !m.truncated ? "meeting" : "meetings"}`
}

export interface VerificationSummary {
	tone: "ok" | "changed" | "unchecked"
	text: string
}

export function verificationSummary(
	v: AnswerVerification,
): VerificationSummary {
	if ("unchecked" in v)
		return v.unchecked === "failed"
			? { tone: "unchecked", text: "Citations not checked: the check failed" }
			: { tone: "unchecked", text: "Citations not checked: none to check" }
	const dropped = v.citationsDropped.length
	const removed = v.claimsRemoved.length
	const claims = `${v.claims} ${v.claims === 1 ? "claim" : "claims"}`
	if (!dropped && !removed)
		return { tone: "ok", text: `Citations checked: ${claims}, all supported` }
	const parts = [
		dropped
			? `${dropped} unsupported ${dropped === 1 ? "citation" : "citations"} removed`
			: "",
		removed
			? `${removed} ${removed === 1 ? "sentence" : "sentences"} without support removed`
			: "",
	].filter(Boolean)
	return {
		tone: "changed",
		text: `Citations checked: ${claims}; ${parts.join(", ")}`,
	}
}

/** A dropped citation as it is named in the response: a page slug, or
 *  "raw:<id>" for a source item that has no page. */
export function citationTarget(
	citation: string,
): { kind: "page"; slug: string } | { kind: "raw"; id: string } {
	return citation.startsWith("raw:")
		? { kind: "raw", id: citation.slice(4) }
		: { kind: "page", slug: citation }
}
