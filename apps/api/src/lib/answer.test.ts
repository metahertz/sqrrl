import { describe, expect, it } from "vitest"
import type { RawItemView } from "@sqrrl/source-layer"
import type { WikiPageView } from "@sqrrl/wiki-engine"
import {
	type AnswerEvidence,
	buildAnswerPrompt,
	labelEvidence,
	NOT_IN_BRAIN,
	readAnswerReply,
	resolveCitations,
} from "./answer.js"
import { ownerLine } from "./answer-people.js"

function page(slug: string, extra: Partial<WikiPageView> = {}): WikiPageView {
	return {
		slug,
		title: slug.split("/").pop() ?? slug,
		kind: "source",
		summary: `summary of ${slug}`,
		body: `body of ${slug}`,
		...extra,
	} as WikiPageView
}

function rawItem(id: string, extra: Partial<RawItemView> = {}): RawItemView {
	return {
		id,
		source: "apple-notes",
		sourceId: `note-${id}`,
		kind: "note",
		text: `raw text ${id}`,
		participants: [],
		attachments: [],
		metadata: {},
		...extra,
	} as RawItemView
}

const EVIDENCE: AnswerEvidence = {
	pages: [
		{ page: page("sources/standup"), source: "hybrid", score: 0.9 },
		{ page: page("people/kai"), source: "graph", score: 0 },
	],
	raw: [
		{
			item: rawItem("abc123", {
				title: "Standup",
				occurredAt: new Date("2026-11-02T09:00:00Z"),
				author: "Matt",
			}),
			score: 0.8,
		},
	],
}

describe("labelEvidence", () => {
	it("labels pages P1.. then raw items R1.., in order", () => {
		const { labels, text } = labelEvidence(EVIDENCE)
		expect([...labels.keys()]).toEqual(["P1", "P2", "R1"])
		expect(labels.get("P1")).toMatchObject({
			type: "page",
			slug: "sources/standup",
		})
		expect(labels.get("R1")).toMatchObject({
			type: "raw",
			id: "abc123",
			sourceId: "note-abc123",
			occurredAt: "2026-11-02T09:00:00.000Z",
			quote: "raw text abc123",
		})
		expect(text).toContain('[P1] wiki page "standup" (sources/standup)')
		expect(text).toContain(
			'[R1] raw apple-notes "Standup" by Matt on 2026-11-02',
		)
	})

	it("gives a linked page its summary only, and marks it as linked", () => {
		const { text } = labelEvidence(EVIDENCE)
		const block = text.split("\n\n").find((b) => b.startsWith("[P2]")) ?? ""
		expect(block).toContain("linked from another result")
		expect(block).toContain("summary of people/kai")
		expect(text).not.toContain("body of people/kai")
		expect(text).toContain("body of sources/standup")
	})

	it("states a task's owner, status and due date", () => {
		const { text } = labelEvidence({
			pages: [
				{
					page: page("tasks/ship", {
						taskCard: { owner: "Kai", status: "open", dueDate: "2026-10-13" },
					}),
					source: "hybrid",
					score: 1,
				},
				{
					page: page("tasks/later", {
						taskCard: { owner: "me", status: "done" },
					}),
					source: "hybrid",
					score: 1,
				},
			],
			raw: [],
		})
		expect(text).toContain("Task: owner Kai, status open, due 2026-10-13")
		expect(text).toContain("Task: owner me, status done, no due date")
		expect(text).not.toMatch(/Task:.*sources\/standup/)
	})

	it("flags a deprecated page as no longer current", () => {
		const { text } = labelEvidence({
			pages: [
				{
					page: page("meetings/x", { frontmatter: { status: "deprecated" } }),
					source: "hybrid",
					score: 1,
				},
			],
			raw: [],
		})
		expect(text).toContain("DEPRECATED: no longer current")
		expect(labelEvidence(EVIDENCE).text).not.toContain("DEPRECATED")
	})

	it("clips long text", () => {
		const long = "x".repeat(10_000)
		const { text, labels } = labelEvidence({
			pages: [{ page: page("a", { body: long }), source: "text", score: 1 }],
			raw: [{ item: rawItem("r", { text: long }), score: 1 }],
		})
		expect(text.length).toBeLessThan(5_000)
		const quote = (labels.get("R1") as { quote: string }).quote
		expect(quote.length).toBeLessThanOrEqual(302)
		expect(quote.endsWith("…")).toBe(true)
	})
})

describe("buildAnswerPrompt", () => {
	it("puts the date, the evidence and the question in order", () => {
		const prompt = buildAnswerPrompt("who?", "[P1] x", "2026-11-17")
		expect(prompt.indexOf("Today: 2026-11-17")).toBeLessThan(
			prompt.indexOf("[P1] x"),
		)
		expect(prompt.endsWith("Question: who?")).toBe(true)
		expect(prompt).not.toContain("People named")
	})

	it("says who the people in the question are, before the evidence", () => {
		const prompt = buildAnswerPrompt(
			"what does Taylor owe?",
			"[P1] x",
			"2026-11-17",
			'- "Taylor" could be Taylor Morgan or Taylor Pryce',
		)
		expect(prompt.indexOf("People named in the question:")).toBeLessThan(
			prompt.indexOf("Evidence:"),
		)
		expect(prompt).toContain("Taylor Pryce")
	})

	it("marks pages reached through a person", () => {
		const { text } = labelEvidence({
			pages: [{ page: page("tasks/a"), source: "person", score: 0 }],
			raw: [],
		})
		expect(text).toContain("linked to a person named in the question")
		expect(text).toContain("body of tasks/a")
	})
})

describe("resolveCitations", () => {
	const { labels } = labelEvidence(EVIDENCE)

	it("rewrites labels to slugs and raw ids, and lists what was cited", () => {
		const out = resolveCitations(
			"Kai owns the rollout [P1][R1], due Friday [P2].",
			true,
			labels,
		)
		expect(out.answer).toBe(
			"Kai owns the rollout [sources/standup][raw:abc123], due Friday [people/kai].",
		)
		expect(out.found).toBe(true)
		expect(out.citations.map((c) => c.ref)).toEqual(["P1", "R1", "P2"])
		expect(out.unknownRefs).toEqual([])
	})

	it("accepts comma-separated labels in one bracket", () => {
		const out = resolveCitations("Yes [P1, R1].", true, labels)
		expect(out.answer).toBe("Yes [sources/standup][raw:abc123].")
	})

	it("drops a label that was not in the evidence and reports it", () => {
		const out = resolveCitations("Kai [P1] and Lee [P9].", true, labels)
		expect(out.answer).toBe("Kai [sources/standup] and Lee.")
		expect(out.citations).toHaveLength(1)
		expect(out.unknownRefs).toEqual(["P9"])
	})

	it("treats an answer that cites nothing real as not in the brain", () => {
		for (const text of ["Kai owns it.", "Kai owns it [P7]."]) {
			const out = resolveCitations(text, true, labels)
			expect(out).toMatchObject({
				answer: NOT_IN_BRAIN,
				found: false,
				citations: [],
			})
		}
	})

	it("honours the model's own found:false even when it cited", () => {
		const out = resolveCitations("Unclear [P1].", false, labels)
		expect(out).toMatchObject({ answer: NOT_IN_BRAIN, found: false })
	})

	it("appends labels named only in the cited list", () => {
		const out = resolveCitations("Sam writes it, due 28 Nov.", true, labels, [
			"P1",
			"R1",
		])
		expect(out.answer).toBe(
			"Sam writes it, due 28 Nov. [sources/standup][raw:abc123]",
		)
		expect(out.found).toBe(true)
		expect(out.citations.map((c) => c.ref)).toEqual(["P1", "R1"])
	})

	it("does not repeat a label cited both inline and in the list", () => {
		const out = resolveCitations("Kai [P1].", true, labels, ["P1", "P9"])
		expect(out.answer).toBe("Kai [sources/standup].")
		expect(out.unknownRefs).toEqual(["P9"])
	})

	it("leaves other bracketed text alone", () => {
		const out = resolveCitations("See [the doc] [P1].", true, labels)
		expect(out.answer).toBe("See [the doc] [sources/standup].")
	})
})

describe("readAnswerReply", () => {
	it("reads the JSON reply", () => {
		expect(
			readAnswerReply({ found: true, answer: "x [P1]", cited: ["P1", 2] }),
		).toEqual({ found: true, answer: "x [P1]", cited: ["P1"] })
		expect(readAnswerReply({ found: false, answer: "" }).found).toBe(false)
	})

	it("takes a bare string as an answer still to be checked", () => {
		expect(readAnswerReply("x [P1]")).toEqual({
			found: true,
			answer: "x [P1]",
			cited: [],
		})
	})

	it("treats an empty or malformed reply as not found", () => {
		expect(readAnswerReply({}).found).toBe(false)
		expect(readAnswerReply(null).found).toBe(false)
		expect(readAnswerReply({ found: true, answer: "  " }).found).toBe(false)
	})
})

describe("ownerLine", () => {
	it("names the owner and every way they are written", () => {
		expect(
			ownerLine("Matt Hollis", {
				names: ["Matt", "Matt Hollis"],
				emails: ["matt.hollis@acme.example"],
			}),
		).toBe(
			'- You are answering Matt Hollis (also written Matt, matt.hollis@acme.example): evidence naming them is about the person asking, so say "you".',
		)
	})
})
