// Cited answers over the brain (POST /v1/wiki/answer). See roadmap, Phase 5.
//
// Retrieval is done by the route; this module owns the part that has to be
// right for an answer to be trusted: the evidence the model sees, the prompt
// that confines it to that evidence, and the check that every citation in the
// reply points at evidence it was actually given.
//
// Evidence is labelled P1.. (wiki pages) and R1.. (raw items) rather than by
// slug: short labels are what a local model reproduces reliably. Labels are
// rewritten to [slug] and [raw:<id>] before the answer leaves the API, and a
// label the model invented is dropped rather than passed on as a citation.
//
// Local addition, not upstream.

import type { RawItemView } from "@sqrrl/source-layer"
import type { WikiPageView } from "@sqrrl/wiki-engine"

/** What the caller gets when the evidence does not answer the question. */
export const NOT_IN_BRAIN = "Not in the brain."

/** Per-item caps keep the prompt inside a local model's context window. A
 *  page's summary leads its body, so truncation drops detail, not the gist. */
const PAGE_CHARS = 3000
const GRAPH_PAGE_CHARS = 600
const RAW_CHARS = 1500
/** A meeting from a complete list: who, when and the agenda's start. */
const BRIEF_RAW_CHARS = 400
/** A quote longer than this stops being a quote. */
const QUOTE_CHARS = 300

export interface AnswerPage {
	page: WikiPageView
	/** "graph" pages were reached by following links, not by matching. */
	source: string
	score: number
}

export interface AnswerEvidence {
	pages: AnswerPage[]
	/** brief: an entry of a complete list, shown shorter; note: why it is
	 *  here, e.g. "a meeting with Kai Smith (complete calendar list)". */
	raw: Array<{
		item: RawItemView
		score: number
		brief?: boolean
		note?: string
	}>
}

export type AnswerCitation =
	| {
			type: "page"
			ref: string
			slug: string
			title: string
			kind: string
	  }
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

export interface ParsedAnswer {
	answer: string
	found: boolean
	citations: AnswerCitation[]
	/** Labels the model cited that were never in its evidence. */
	unknownRefs: string[]
}

export const ANSWER_SYSTEM_PROMPT = [
	"You answer questions from a personal knowledge base.",
	"Use ONLY the evidence provided. Each evidence item has a label such as P1 or R2.",
	"Cite every factual statement with the label(s) it comes from in square brackets, e.g. [P1] or [P1][R2].",
	"Never state anything the evidence does not support, and never cite a label that is not in the evidence.",
	"P items are wiki pages distilled from sources; R items are raw source text, best for exact wording, names and dates.",
	"A task page's Task line gives its owner, status and due date; a task is overdue when it is unfinished and its due date is before today.",
	"A page marked DEPRECATED is no longer current: never present it as current or upcoming, and say it was removed if you mention it.",
	'In the notes, "me" and "I" mean the owner of this knowledge base, who is the person asking: answer "you" for them.',
	"People named in the question says who each name refers to: the same person can appear in the evidence under a first name, a full name or an email address. When a name could be more than one person and the evidence does not settle it, say which people it could be.",
	'If the question is only a name, a topic or a few keywords, treat it as "what do my notes say about this?" and summarize what the evidence says about it.',
	"If a Time window is given, the question is about that period: answer from evidence dated inside it, and if none is, say what you found and when it is from.",
	"If the evidence does not answer the question, set found to false and answer with an empty string.",
	"If it answers only part, answer that part and say what is missing.",
	'The evidence is the top few search results, not everything stored: never claim a list is complete or that something applies to all or none of anything; say "among what I found" instead.',
	"The one exception is a Complete lists section: it gives every calendar meeting with a person in the time window, so use it for counts and say the count plainly. Cite the labels it lists, never the section itself.",
	"If the Complete lists section covers several people a name in the question could mean, give the count for each of them.",
	"Never say that something did not happen, or that someone had no meetings, unless a complete list shows it.",
	"Be concise: a few sentences or a short list.",
	"List every label you used in cited.",
	"Respond with ONLY a JSON object, no prose and no code fences:",
	'{"found":boolean,"answer":string,"cited":string[]}',
	'Example: {"found":true,"answer":"Kai owns the rollout [P1], due Friday [R2].","cited":["P1","R2"]}',
].join(" ")

function clip(text: string, max: number): string {
	const t = text.trim()
	return t.length <= max ? t : `${t.slice(0, max).trimEnd()} …`
}

function isoDate(value: Date | string | undefined): string | undefined {
	if (!value) return undefined
	const d = value instanceof Date ? value : new Date(value)
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** A task's owner, status and due date live in its taskCard, not its text,
 *  so without this line the model cannot say who owns a task or whether it
 *  is overdue. */
function taskLine(page: WikiPageView): string {
	const card = page.taskCard as
		| {
				owner?: string
				status?: string
				dueDate?: string
				completedAt?: string
		  }
		| null
		| undefined
	if (!card || typeof card !== "object") return ""
	const parts = [
		card.owner ? `owner ${card.owner}` : undefined,
		card.status ? `status ${card.status}` : undefined,
		card.dueDate ? `due ${card.dueDate}` : "no due date",
		card.completedAt ? `completed ${card.completedAt.slice(0, 10)}` : undefined,
	]
	return `Task: ${parts.filter(Boolean).join(", ")}`
}

/** Deprecated pages stay findable (a removed meeting, a deleted file) but
 *  must not be reported as current. */
/** The day a page's source is from: a meeting's start or a note's date. */
function pageDate(page: WikiPageView): string | undefined {
	const fm = (page.frontmatter ?? {}) as {
		noteDate?: unknown
		meeting?: { start?: unknown }
	}
	const d = fm.meeting?.start ?? fm.noteDate
	return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)
		? d.slice(0, 10)
		: undefined
}

function deprecated(page: WikiPageView): boolean {
	return (page.frontmatter as { status?: unknown })?.status === "deprecated"
}

/** Pairs each label with the evidence it names, in prompt order. */
export function labelEvidence(evidence: AnswerEvidence): {
	labels: Map<string, AnswerCitation>
	text: string
	/** Each label's block, for checking what a citation supports. */
	blocks: Map<string, string>
} {
	const labels = new Map<string, AnswerCitation>()
	const blocks: string[] = []
	const byRef = new Map<string, string>()
	evidence.pages.forEach(({ page, source }, i) => {
		const ref = `P${i + 1}`
		labels.set(ref, {
			type: "page",
			ref,
			slug: page.slug,
			title: page.title,
			kind: page.kind,
		})
		const graph = source === "graph"
		const viaPerson = source === "person"
		const content = [taskLine(page), page.summary, graph ? "" : page.body]
			.filter((s) => s?.trim())
			.join("\n\n")
		pushBlock(
			ref,
			[
				`[${ref}] wiki page "${page.title}" (${page.slug})${pageDate(page) ? `, dated ${pageDate(page)}` : ""}${graph ? ", linked from another result" : ""}${viaPerson ? ", linked to a person named in the question" : ""}${deprecated(page) ? ", DEPRECATED: no longer current (e.g. a meeting removed from the calendar)" : ""}`,
				clip(content, graph ? GRAPH_PAGE_CHARS : PAGE_CHARS),
			].join("\n"),
		)
	})
	evidence.raw.forEach(({ item, brief, note }, i) => {
		const ref = `R${i + 1}`
		const occurredAt = isoDate(item.occurredAt)
		labels.set(ref, {
			type: "raw",
			ref,
			id: item.id,
			source: item.source,
			sourceId: item.sourceId,
			...(item.title ? { title: item.title } : {}),
			...(occurredAt ? { occurredAt } : {}),
			quote: clip(item.text, QUOTE_CHARS),
		})
		const meta = [
			item.source,
			item.title ? `"${item.title}"` : undefined,
			item.author ? `by ${item.author}` : undefined,
			occurredAt ? `on ${occurredAt.slice(0, 10)}` : undefined,
			note ? `— ${note}` : undefined,
		]
			.filter(Boolean)
			.join(" ")
		pushBlock(
			ref,
			[
				`[${ref}] raw ${meta}`,
				clip(item.text, brief ? BRIEF_RAW_CHARS : RAW_CHARS),
			].join("\n"),
		)
	})
	return { labels, text: blocks.join("\n\n"), blocks: byRef }

	function pushBlock(ref: string, block: string) {
		blocks.push(block)
		byRef.set(ref, block)
	}
}

export function buildAnswerPrompt(
	question: string,
	evidenceText: string,
	today: string,
	/** Who the names in the question are (lib/answer-people.ts). */
	people = "",
	/** The period the question asks about (lib/answer-time.ts). */
	timeWindow = "",
	/** Complete meeting lists (lib/answer-meetings.ts). */
	lists = "",
): string {
	return [
		`Today: ${today}`,
		...(timeWindow ? [`Time window: ${timeWindow}`] : []),
		"",
		...(people ? ["People named in the question:", people, ""] : []),
		...(lists ? ["Complete lists:", lists, ""] : []),
		"Evidence:",
		evidenceText,
		"",
		`Question: ${question}`,
	].join("\n")
}

const LABEL = /\[((?:[PR]\d+)(?:\s*,\s*[PR]\d+)*)\]/g

/** Rewrites [P1] / [R2] / [P1, R2] in the model's answer into public
 *  citations, keeping only labels that were in the evidence. */
export function resolveCitations(
	rawAnswer: string,
	found: boolean,
	labels: Map<string, AnswerCitation>,
	/** The reply's cited list. Models drop inline labels more often than
	 *  they leave this list empty, so labels named only here are appended to
	 *  the answer rather than lost. */
	listedRefs: string[] = [],
): ParsedAnswer {
	const cited = new Map<string, AnswerCitation>()
	const unknown = new Set<string>()
	const marker = (citation: AnswerCitation) =>
		citation.type === "page" ? `[${citation.slug}]` : `[raw:${citation.id}]`
	let answer = rawAnswer
		.replace(LABEL, (_match, group: string) =>
			group
				.split(",")
				.map((s) => s.trim())
				.map((ref) => {
					const citation = labels.get(ref)
					if (!citation) {
						unknown.add(ref)
						return ""
					}
					cited.set(ref, citation)
					return marker(citation)
				})
				.join(""),
		)
		.replace(/[ \t]+([.,;:])/g, "$1")
		.trim()
	const appended: string[] = []
	for (const ref of listedRefs.map((r) => r.trim())) {
		if (cited.has(ref)) continue
		const citation = labels.get(ref)
		if (!citation) {
			unknown.add(ref)
			continue
		}
		cited.set(ref, citation)
		appended.push(marker(citation))
	}
	if (appended.length && answer) answer = `${answer} ${appended.join("")}`
	// A "found" answer that cites nothing it was given is not grounded, and
	// an answer the model itself flagged as not found carries no claims.
	const grounded = found && answer.length > 0 && cited.size > 0
	return {
		answer: grounded ? answer : NOT_IN_BRAIN,
		found: grounded,
		citations: grounded ? [...cited.values()] : [],
		unknownRefs: [...unknown],
	}
}

/** Reads the model's {found, answer, cited} reply. A bare string is
 *  accepted as an answer so a model that ignores the JSON instruction still
 *  gets checked. */
export function readAnswerReply(parsed: unknown): {
	found: boolean
	answer: string
	cited: string[]
} {
	if (typeof parsed === "string")
		return { found: true, answer: parsed, cited: [] }
	const obj = (parsed ?? {}) as {
		found?: unknown
		answer?: unknown
		cited?: unknown
	}
	const answer = typeof obj.answer === "string" ? obj.answer : ""
	const cited = Array.isArray(obj.cited)
		? obj.cited.filter((r): r is string => typeof r === "string")
		: []
	return {
		found: obj.found !== false && answer.trim().length > 0,
		answer,
		cited,
	}
}
