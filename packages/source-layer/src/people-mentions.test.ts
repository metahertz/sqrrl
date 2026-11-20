import { describe, expect, it } from "vitest"
import { hubEntry } from "./people.js"
import { describeMentions, findPeopleMentions } from "./people-mentions.js"

const entries = [
	hubEntry({
		slug: "people/taylor-morgan",
		title: "Taylor Morgan",
		personCard: { emails: ["taylor.morgan@acme.example"] },
	}),
	hubEntry({
		slug: "people/taylor-pryce",
		title: "Taylor Pryce",
		personCard: { emails: ["taylor.pryce@acme.example"] },
	}),
	hubEntry({ slug: "people/may-perry", title: "May Perry" }),
	hubEntry({ slug: "people/nasir-quinn", title: "Nasir Quinn" }),
	hubEntry({ slug: "orgs/travel", title: "Travel" }),
]

const slugs = (q: string) =>
	findPeopleMentions(entries, q).map(
		(m) => m.person?.slug ?? m.candidates?.map((c) => c.slug).join("|"),
	)

describe("findPeopleMentions", () => {
	it("finds full names, addresses and unambiguous first or last names", () => {
		expect(slugs("What did Taylor Morgan promise?")).toEqual([
			"people/taylor-morgan",
		])
		expect(slugs("anything from taylor.pryce@acme.example this week")).toEqual([
			"people/taylor-pryce",
		])
		expect(slugs("When did I last meet Nasir?")).toEqual(["people/nasir-quinn"])
		expect(slugs("Open tasks for Pryce")).toEqual(["people/taylor-pryce"])
	})

	it("returns every candidate for a shared first name", () => {
		expect(slugs("What does Taylor owe me?")).toEqual([
			"people/taylor-morgan|people/taylor-pryce",
		])
	})

	it("ignores months, question words and lowercase words", () => {
		expect(slugs("What happened in May?")).toEqual([])
		expect(slugs("what did nasir say")).toEqual([])
		expect(slugs("Travel plans for Nasir and May Perry")).toEqual([
			"people/may-perry",
			"people/nasir-quinn",
		])
	})
})

describe("describeMentions", () => {
	it("says who a name is, or that it is unclear", () => {
		const text = describeMentions(
			findPeopleMentions(entries, "Did Taylor or Nasir reply?"),
		)
		expect(text).toContain(
			'"Taylor" could be Taylor Morgan (taylor.morgan@acme.example) or Taylor Pryce',
		)
		expect(text).toContain('"Nasir" is Nasir Quinn')
	})
})
