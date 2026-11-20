// Does the evidence show a task is finished, or no longer needed?
//
// One task, a handful of dated evidence items, one LLM call. The model
// must quote the evidence; a verdict whose quote is not found verbatim in
// an evidence item it cited is thrown away, as an answer citing evidence it
// was not given is in lib/answer.ts. Plans and promises are explicitly not
// completion: "I'll send it Friday" closes nothing.

import type { ProposedStatus, SuggestionEvidence } from "./store.js"

export const TASK_JUDGE_PROMPT = [
	"You decide whether a task from someone's knowledge base has been completed, or is no longer needed, using ONLY the evidence given.",
	"Each evidence item has a label (E1, E2, ...) and a date. All of it is dated after the task was created.",
	'verdict "done": the evidence states or clearly shows the task\'s outcome happened: it was sent, fixed, delivered, decided, or the meeting it describes took place.',
	'verdict "dropped": the evidence shows the task is no longer needed: cancelled, superseded, decided against, or the meeting it was for was cancelled.',
	'verdict "none": anything else: a mention, a plan, a promise, partial progress, or evidence about a different task, person or thing.',
	'Plans and intentions ("will send", "next week", "I\'ll look into it") are NOT completion.',
	'A recurring or ongoing task ("weekly 1:1s", "every sprint", "keep X updated") is NOT done because one occurrence happened; only "dropped" if it was explicitly stopped.',
	"A meeting page dated before today that is not marked removed means the meeting took place; one marked removed was cancelled.",
	'In notes, "me" means the knowledge base owner.',
	"quote: copy, verbatim, the shortest span (under 200 characters) of ONE cited evidence item that shows the verdict.",
	"confidence: 0 to 1, how certain the evidence alone makes the verdict.",
	"Respond with ONLY a JSON object, no prose and no code fences:",
	'{"verdict":"done|dropped|none","confidence":number,"evidence":["E1"],"quote":string,"rationale":string}',
].join("\n")

export interface JudgeTask {
	title: string
	owner?: string
	createdAt?: string
	dueDate?: string
	/** What the task was extracted from, when the page says. */
	context?: string
}

export interface JudgeEvidence {
	key: string
	kind: "page" | "raw"
	slug?: string
	rawItemId?: string
	title: string
	text: string
	occurredAt?: string
	source?: string
	author?: string
}

export function buildJudgePrompt(
	task: JudgeTask,
	evidence: JudgeEvidence[],
	today: string,
): string {
	const lines = [
		`Today: ${today}`,
		"",
		`Task: ${task.title}`,
		task.owner ? `Owner: ${task.owner}` : undefined,
		task.createdAt ? `Created: ${task.createdAt.slice(0, 10)}` : undefined,
		task.dueDate ? `Due: ${task.dueDate}` : undefined,
		task.context ? `Context: ${task.context}` : undefined,
		"",
		"Evidence:",
		...evidence.map((e, i) =>
			[
				"",
				`[E${i + 1}] ${e.source ?? e.kind}${e.title ? ` "${e.title}"` : ""}${e.author ? ` by ${e.author}` : ""}${e.occurredAt ? ` on ${e.occurredAt.slice(0, 10)}` : ""}`,
				e.text,
			].join("\n"),
		),
	]
	return lines.filter((l) => l !== undefined).join("\n")
}

export interface JudgeVerdict {
	proposed: ProposedStatus
	confidence: number
	rationale: string
	evidence: SuggestionEvidence[]
}

/** Lowercase, straight quotes, one space: so a quote that differs from the
 *  evidence only in whitespace or typography still counts as verbatim. */
export function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, " ")
		.replace(/^["'\s.…]+|["'\s.…]+$/g, "")
		.trim()
}

/** The model's reply as a verdict worth showing, or undefined. */
export function parseJudgeReply(
	reply: unknown,
	evidence: JudgeEvidence[],
	minConfidence: number,
): JudgeVerdict | undefined {
	if (!reply || typeof reply !== "object") return undefined
	const r = reply as {
		verdict?: unknown
		confidence?: unknown
		evidence?: unknown
		quote?: unknown
		rationale?: unknown
	}
	if (r.verdict !== "done" && r.verdict !== "dropped") return undefined
	const confidence =
		typeof r.confidence === "number" ? r.confidence : Number(r.confidence)
	if (!Number.isFinite(confidence) || confidence < minConfidence)
		return undefined
	const quote = typeof r.quote === "string" ? r.quote.trim() : ""
	const needle = normalizeForMatch(quote)
	if (needle.length < 4) return undefined
	const labels = Array.isArray(r.evidence)
		? r.evidence.filter((x): x is string => typeof x === "string")
		: []
	const cited = [
		...new Set(
			labels.map((l) => l.trim().toUpperCase()).filter((l) => /^E\d+$/.test(l)),
		),
	]
		.map((l) => evidence[Number(l.slice(1)) - 1])
		.filter((e): e is JudgeEvidence => Boolean(e))
	// The quote must be in what was cited; if the model cited nothing valid,
	// any evidence item holding the quote is the citation.
	const pool = cited.length ? cited : evidence
	const holding = pool.filter((e) => normalizeForMatch(e.text).includes(needle))
	if (!holding.length) return undefined
	return {
		proposed: r.verdict,
		confidence: Math.min(1, confidence),
		rationale:
			typeof r.rationale === "string" ? r.rationale.trim().slice(0, 500) : "",
		evidence: holding.map((e) => ({
			key: e.key,
			kind: e.kind,
			...(e.slug ? { slug: e.slug } : {}),
			...(e.rawItemId ? { rawItemId: e.rawItemId } : {}),
			title: e.title,
			quote: quote.slice(0, 300),
			...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
			...(e.source ? { source: e.source } : {}),
		})),
	}
}
