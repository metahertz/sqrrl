import { describe, expect, it } from "vitest"
import {
	type AnswerCitation,
	rawFootnotes,
	splitAnswer,
} from "./answer-text.js"

const CITATIONS: AnswerCitation[] = [
	{
		type: "page",
		ref: "P1",
		slug: "sources/standup",
		title: "Standup",
		kind: "source",
	},
	{
		type: "raw",
		ref: "R1",
		id: "abc",
		source: "apple-notes",
		sourceId: "n1",
		quote: "Kai to ship",
	},
	{
		type: "raw",
		ref: "R2",
		id: "def",
		source: "nextcloud",
		sourceId: "f1",
		quote: "Friday",
	},
]

describe("splitAnswer", () => {
	it("turns cited slugs into links and raw ids into numbered notes", () => {
		expect(
			splitAnswer(
				"Kai ships [sources/standup][raw:abc] by Friday [raw:def].",
				CITATIONS,
			),
		).toEqual([
			{ type: "text", at: 0, text: "Kai ships " },
			{ type: "page", at: 10, slug: "sources/standup", title: "Standup" },
			{ type: "raw", at: 27, id: "abc", n: 1 },
			{ type: "text", at: 36, text: " by Friday " },
			{ type: "raw", at: 47, id: "def", n: 2 },
			{ type: "text", at: 56, text: "." },
		])
	})

	it("leaves brackets that are not citations as text", () => {
		expect(
			splitAnswer("See [the doc] and [raw:zzz] [people/kai].", CITATIONS),
		).toEqual([
			{
				type: "text",
				at: 0,
				text: "See [the doc] and [raw:zzz] [people/kai].",
			},
		])
	})

	it("handles an answer with no citations", () => {
		expect(splitAnswer("Not in the brain.", [])).toEqual([
			{ type: "text", at: 0, text: "Not in the brain." },
		])
	})
})

describe("rawFootnotes", () => {
	it("lists raw citations in the order splitAnswer numbers them", () => {
		expect(rawFootnotes(CITATIONS).map((c) => c.id)).toEqual(["abc", "def"])
	})
})
