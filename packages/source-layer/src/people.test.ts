import { describe, expect, it } from "vitest"
import { parseRef } from "./identity.js"
import { type HubEntry, hubEntry, matchPerson } from "./people.js"

const hubs: HubEntry[] = [
	hubEntry({
		slug: "people/taylor-morgan-acme-example",
		title: "taylor.morgan@acme.example",
		personCard: { emails: ["taylor.morgan@acme.example"] },
	}),
	hubEntry({
		slug: "people/taylor-pryce-acme-example",
		title: "taylor.pryce@acme.example",
		personCard: { emails: ["taylor.pryce@acme.example"] },
	}),
	hubEntry({ slug: "people/nasir-quinn", title: "Nasir Quinn" }),
	hubEntry({ slug: "people/kai", title: "Kai" }),
	hubEntry({
		slug: "people/alex-events-example",
		title: "alex@events.example",
		personCard: { emails: ["alex@events.example"] },
	}),
	hubEntry({
		slug: "orgs/travel",
		title: "Travel",
		personCard: { emails: ["travel@acme.example"] },
	}),
]

function match(name: string, email?: string, context?: string[]) {
	const ref = parseRef({ name, email })
	if (!ref) throw new Error("parse")
	return matchPerson(hubs, ref, context)
}

describe("hubEntry", () => {
	it("names an address-titled hub after the address", () => {
		expect(hubs[0].title).toBe("Taylor Morgan")
		expect(hubs[0].keys).toContain("taylor morgan")
		expect(hubs[5].org).toBe(true)
	})
})

describe("matchPerson", () => {
	it("joins every spelling of a full name to one hub", () => {
		for (const n of [
			"Taylor Morgan",
			"taylor.morgan@acme.example",
			"Morgan, Taylor",
			"Taylor M",
		])
			expect(match(n).entry?.slug).toBe("people/taylor-morgan-acme-example")
		expect(match("Someone", "taylor.morgan@acme.example").entry?.slug).toBe(
			"people/taylor-morgan-acme-example",
		)
	})

	it("resolves a first name only when it is unambiguous", () => {
		expect(match("Nasir").entry?.slug).toBe("people/nasir-quinn")
		const taylor = match("Taylor")
		expect(taylor.entry).toBeUndefined()
		expect(taylor.ambiguous?.map((e) => e.slug)).toEqual([
			"people/taylor-morgan-acme-example",
			"people/taylor-pryce-acme-example",
		])
		// Taylor Pryce is on the same page: that Taylor.
		expect(
			match("Taylor", undefined, ["people/taylor-pryce-acme-example"]).entry
				?.slug,
		).toBe("people/taylor-pryce-acme-example")
	})

	it("keeps first-name hubs and single-name addresses apart", () => {
		expect(match("Kai").entry?.slug).toBe("people/kai")
		// "Alex" is not alex@events.example: that hub is identified by its address.
		expect(match("Alex").entry).toBeUndefined()
		// A partial name with its own address is never guessed from the name.
		expect(match("Taylor", "taylor@elsewhere.test")).toEqual({})
	})

	it("treats a same name with another address as a namesake", () => {
		expect(match("Taylor Morgan", "tm@other.test").entry).toBeUndefined()
	})

	it("never matches people to teams or services", () => {
		expect(match("Travel Smith").entry).toBeUndefined()
	})
})
