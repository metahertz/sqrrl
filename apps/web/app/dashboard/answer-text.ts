// Splits a cited answer from POST /v1/wiki/answer into renderable pieces.
//
// The API rewrites the model's citations to [slug] for wiki pages and
// [raw:<id>] for raw items, and only for evidence it actually supplied, so
// a bracket is a citation exactly when it names one of the answer's
// citations. Anything else in brackets stays text.

export type AnswerCitation =
	| { type: "page"; ref: string; slug: string; title: string; kind: string }
	| {
			type: "raw"
			ref: string
			id: string
			source: string
			sourceId: string
			title?: string
			occurredAt?: string
			quote: string
	  }

/** at is the segment's offset in the answer: unique, so it serves as a
 *  React key. */
export type AnswerSegment =
	| { type: "text"; at: number; text: string }
	| { type: "page"; at: number; slug: string; title: string }
	/** n is the raw citation's 1-based position in the footnotes. */
	| { type: "raw"; at: number; id: string; n: number }

export function splitAnswer(
	answer: string,
	citations: AnswerCitation[],
): AnswerSegment[] {
	const pages = new Map<string, string>()
	const raw = new Map<string, number>()
	for (const c of citations) {
		if (c.type === "page") pages.set(c.slug, c.title)
		else raw.set(c.id, raw.size + 1)
	}
	const segments: AnswerSegment[] = []
	const push = (text: string, at: number) => {
		if (text) segments.push({ type: "text", at, text })
	}
	let at = 0
	for (const m of answer.matchAll(/\[([^\][]+)\]/g)) {
		const inner = m[1] ?? ""
		const index = m.index ?? 0
		const rawId = inner.startsWith("raw:") ? inner.slice(4) : undefined
		let segment: AnswerSegment | undefined
		if (rawId !== undefined && raw.has(rawId))
			segment = { type: "raw", at: index, id: rawId, n: raw.get(rawId) ?? 0 }
		else if (pages.has(inner))
			segment = {
				type: "page",
				at: index,
				slug: inner,
				title: pages.get(inner) ?? inner,
			}
		if (!segment) continue
		push(answer.slice(at, index), at)
		segments.push(segment)
		at = index + m[0].length
	}
	push(answer.slice(at), at)
	return segments
}

/** Raw citations in footnote order, matching AnswerSegment.n. */
export function rawFootnotes(citations: AnswerCitation[]) {
	return citations.filter(
		(c): c is Extract<AnswerCitation, { type: "raw" }> => c.type === "raw",
	)
}
