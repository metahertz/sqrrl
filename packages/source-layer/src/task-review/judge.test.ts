import { describe, expect, it } from "vitest"
import {
	buildJudgePrompt,
	type JudgeEvidence,
	normalizeForMatch,
	parseJudgeReply,
} from "./judge.js"

const EVIDENCE: JudgeEvidence[] = [
	{
		key: "raw:r1",
		kind: "raw",
		rawItemId: "r1",
		title: "#platform",
		text: "Kai: I'll look at the exporter next week.",
		occurredAt: "2026-11-16T09:00:00Z",
		source: "slack",
		author: "Kai",
	},
	{
		key: "raw:r2",
		kind: "raw",
		rawItemId: "r2",
		title: "Re: deck",
		text: "Sent the deck to   Adyen this morning — let me know.",
		occurredAt: "2026-11-17T09:00:00Z",
		source: "email",
		author: "me",
	},
	{
		key: "page:meetings/x",
		kind: "page",
		slug: "meetings/x",
		title: "Adyen sync",
		text: "Meeting scheduled for 2026-11-15 10:00 — REMOVED from the calendar (cancelled).",
		occurredAt: "2026-11-15T10:00:00Z",
		source: "meeting",
	},
]

describe("buildJudgePrompt", () => {
	it("states the task and labels each dated evidence item", () => {
		const out = buildJudgePrompt(
			{
				title: "Send the deck to Adyen",
				owner: "me",
				createdAt: "2026-11-10T00:00:00Z",
				dueDate: "2026-11-14",
			},
			EVIDENCE,
			"2026-11-18",
		)
		expect(out).toContain("Today: 2026-11-18")
		expect(out).toContain(
			"Task: Send the deck to Adyen\nOwner: me\nCreated: 2026-11-10\nDue: 2026-11-14",
		)
		expect(out).toContain(
			'[E2] email "Re: deck" by me on 2026-11-17\nSent the deck',
		)
		expect(out).toContain("[E3] meeting")
	})
})

describe("parseJudgeReply", () => {
	const reply = (r: Record<string, unknown>) =>
		parseJudgeReply(
			{
				verdict: "done",
				confidence: 0.9,
				evidence: ["E2"],
				quote: "Sent the deck to Adyen this morning",
				rationale: "it was sent",
				...r,
			},
			EVIDENCE,
			0.7,
		)

	it("keeps a confident verdict whose quote is in the cited evidence", () => {
		expect(reply({})).toEqual({
			proposed: "done",
			confidence: 0.9,
			rationale: "it was sent",
			evidence: [
				{
					key: "raw:r2",
					kind: "raw",
					rawItemId: "r2",
					title: "Re: deck",
					quote: "Sent the deck to Adyen this morning",
					occurredAt: "2026-11-17T09:00:00Z",
					source: "email",
				},
			],
		})
	})

	it("tolerates whitespace and curly quotes, not invented text", () => {
		expect(
			reply({ quote: "“sent the deck to adyen this morning”" })?.proposed,
		).toBe("done")
		expect(reply({ quote: "Sent the slides to Adyen" })).toBeUndefined()
	})

	it("drops none, low confidence, and quotes from evidence not cited", () => {
		expect(reply({ verdict: "none" })).toBeUndefined()
		expect(reply({ confidence: 0.5 })).toBeUndefined()
		expect(reply({ evidence: ["E1"] })).toBeUndefined()
	})

	it("falls back to whichever evidence holds the quote when citations are invalid", () => {
		expect(
			reply({ evidence: ["E9", "x"] })?.evidence.map((e) => e.key),
		).toEqual(["raw:r2"])
	})

	it("accepts dropped for a cancelled meeting", () => {
		const out = parseJudgeReply(
			{
				verdict: "dropped",
				confidence: 0.8,
				evidence: ["E3"],
				quote: "REMOVED from the calendar (cancelled)",
			},
			EVIDENCE,
			0.7,
		)
		expect(out).toMatchObject({
			proposed: "dropped",
			evidence: [{ key: "page:meetings/x", slug: "meetings/x" }],
		})
	})

	it("rejects malformed replies", () => {
		expect(parseJudgeReply("done", EVIDENCE, 0.7)).toBeUndefined()
		expect(
			parseJudgeReply(
				{ verdict: "done", confidence: 0.9, quote: "ok" },
				EVIDENCE,
				0.7,
			),
		).toBeUndefined()
	})
})

describe("normalizeForMatch", () => {
	it("folds case, whitespace and typographic quotes", () => {
		expect(normalizeForMatch("  “It’s   DONE.” ")).toBe("it's done")
	})
})
