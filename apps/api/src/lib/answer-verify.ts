// Citation check for POST /v1/wiki/answer. The answering model cites
// labels; nothing so far checked that a cited item says what the sentence
// claims ("no meetings with Kai J. [P9][P10]" cited two pages about
// something else). A second call reads each claim next to the evidence it
// cites and says which citations support it. Unsupported citations are
// removed, and a claim left with none is removed with them.
//
// It works on the raw answer, before labels become public citations, and
// fails open: a broken check keeps the answer and reports it as unchecked.

const LABELS = /\[((?:[PR]\d+)(?:\s*,\s*[PR]\d+)*)\]/g

export const VERIFY_SYSTEM_PROMPT = [
	"You check the citations in an answer against the evidence they cite.",
	"You get evidence items labelled P1, R2 and so on, then numbered claims, each with the labels it cites.",
	"For each claim, list the cited labels whose evidence directly supports what the claim says.",
	"A label supports a claim only if its evidence states it or plainly implies it: being about the same person or topic is not enough.",
	"A claim that something did not happen, or that there is none of something, is supported only by a label from a complete list that shows it.",
	"A claim can be supported by several labels together, e.g. a count backed by every item counted.",
	"An item marked as a meeting with someone (complete calendar list) is confirmed to include that person, even when its attendee list is cut short.",
	"Only list labels the claim itself cites.",
	"Respond with ONLY a JSON object, no prose and no code fences:",
	'{"claims":[{"n":number,"supported":string[]}]}',
	'Example: {"claims":[{"n":1,"supported":["P1"]},{"n":2,"supported":[]}]}',
].join(" ")

export interface Claim {
	n: number
	text: string
	labels: string[]
}

/** The answer as segments in order: claims (text with labels) and the
 *  separators and label-free text between them, so it can be rebuilt. */
export interface SplitAnswer {
	parts: Array<{ text: string; claim?: Claim }>
	claims: Claim[]
}

function labelsIn(text: string): string[] {
	const out: string[] = []
	for (const m of text.matchAll(LABELS))
		for (const ref of m[1].split(","))
			if (!out.includes(ref.trim())) out.push(ref.trim())
	return out
}

/** Lines, then sentences. Labels written after the full stop
 *  ("Done. [P1]") are moved before it first, so they stay with their
 *  sentence; a stop the labels are followed by ("Kai J. [P9].") is an
 *  initial, not the end. A sentence starts with a capital, a digit, a quote
 *  or a list mark, so "Kai S. twice" stays whole. */
export function splitClaims(answer: string): SplitAnswer {
	const normalized = answer.replace(
		/([.!?])((?:\s*\[(?:[PR]\d+)(?:\s*,\s*[PR]\d+)*\])+)(?!\s*\[[PR]\d)(?!\s*[.!?])/g,
		(_m, stop: string, refs: string) => `${refs.replace(/^\s+/, " ")}${stop}`,
	)
	const parts: SplitAnswer["parts"] = []
	const claims: Claim[] = []
	// Keep the separators: odd indexes are whitespace between sentences.
	const pieces = normalized.split(/(\n+|(?<=[.!?])[ \t]+(?=[A-Z0-9"'“*•(-]))/)
	for (const [i, piece] of pieces.entries()) {
		if (i % 2 === 1 || !piece) {
			if (piece) parts.push({ text: piece })
			continue
		}
		const labels = labelsIn(piece)
		if (!labels.length) {
			parts.push({ text: piece })
			continue
		}
		const claim = { n: claims.length + 1, text: piece, labels }
		claims.push(claim)
		parts.push({ text: piece, claim })
	}
	return { parts, claims }
}

export function buildVerifyPrompt(
	claims: Claim[],
	blocks: Map<string, string>,
): string {
	const cited = [...new Set(claims.flatMap((c) => c.labels))]
	return [
		"Evidence:",
		cited
			.map((ref) => blocks.get(ref))
			.filter(Boolean)
			.join("\n\n"),
		"",
		"Claims:",
		...claims.map((c) => `${c.n}. ${c.text} (cites ${c.labels.join(", ")})`),
	].join("\n")
}

/** Which labels each claim keeps, or null if the reply is unusable. A claim
 *  the reply leaves out keeps its labels. */
export function readVerifyReply(
	reply: unknown,
	claims: Claim[],
): Map<number, string[]> | null {
	const list = (reply as { claims?: unknown } | null)?.claims
	if (!Array.isArray(list)) return null
	const kept = new Map(claims.map((c) => [c.n, c.labels]))
	for (const entry of list) {
		const e = entry as { n?: unknown; supported?: unknown }
		const n = Number(e.n)
		const claim = claims.find((c) => c.n === n)
		if (!claim || !Array.isArray(e.supported)) continue
		const supported = e.supported.map((s) => String(s).trim())
		kept.set(
			n,
			claim.labels.filter((l) => supported.includes(l)),
		)
	}
	return kept
}

export interface VerifiedAnswer {
	answer: string
	citationsDropped: Array<{ claim: string; label: string }>
	claimsRemoved: string[]
}

/** Rebuilds the answer with only supported citations. */
export function applyVerification(
	split: SplitAnswer,
	kept: Map<number, string[]>,
): VerifiedAnswer {
	const citationsDropped: VerifiedAnswer["citationsDropped"] = []
	const claimsRemoved: string[] = []
	const out: string[] = []
	for (const part of split.parts) {
		const claim = part.claim
		if (!claim) {
			out.push(part.text)
			continue
		}
		const keep = kept.get(claim.n) ?? claim.labels
		const plain = tidy(claim.text.replace(LABELS, ""))
		for (const l of claim.labels)
			if (!keep.includes(l))
				citationsDropped.push({ claim: plain.trim(), label: l })
		if (!keep.length) {
			claimsRemoved.push(plain.trim())
			continue
		}
		out.push(
			claim.text.replace(LABELS, (_m, group: string) => {
				const refs = group
					.split(",")
					.map((r) => r.trim())
					.filter((r) => keep.includes(r))
				return refs.map((r) => `[${r}]`).join("")
			}),
		)
	}
	const answer = out
		.join("")
		// Separators around a removed claim collapse into one.
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
	return { answer: tidy(answer), citationsDropped, claimsRemoved }
}

/** Space before punctuation goes, and "P. ." (an initial whose citations
 *  were removed) becomes "P."; an ellipsis is left alone. */
function tidy(text: string): string {
	return text
		.replace(/([.!?])[ \t]+\./g, "$1")
		.replace(/[ \t]+([.,;:!?])/g, "$1")
		.trim()
}

/** The whole check. `complete` is the answer model's completion. */
export async function verifyAnswer(
	answer: string,
	blocks: Map<string, string>,
	complete: (system: string, user: string) => Promise<unknown>,
): Promise<
	(VerifiedAnswer & { checked: number }) | { unchecked: "no-claims" | "failed" }
> {
	const split = splitClaims(answer)
	if (!split.claims.length) return { unchecked: "no-claims" }
	let reply: unknown
	try {
		reply = await complete(
			VERIFY_SYSTEM_PROMPT,
			buildVerifyPrompt(split.claims, blocks),
		)
	} catch {
		return { unchecked: "failed" }
	}
	const kept = readVerifyReply(reply, split.claims)
	if (!kept) return { unchecked: "failed" }
	return { ...applyVerification(split, kept), checked: split.claims.length }
}
