import { describe, expect, it } from "vitest"
import {
	type HubDoc,
	planPeopleCleanup,
	type SourceLinks,
} from "./people-cleanup.js"

const hub = (
	slug: string,
	title: string,
	emails: string[] = [],
	backlinks: string[] = [],
): HubDoc => ({
	slug,
	title,
	personCard: emails.length ? { emails } : null,
	backlinks,
})

const HUBS: HubDoc[] = [
	hub("people/taylor-morgan", "Taylor Morgan", [], ["tasks/x"]),
	hub(
		"people/taylor-morgan-acme-example",
		"taylor.morgan@acme.example",
		["taylor.morgan@acme.example"],
		["meetings/a", "meetings/b"],
	),
	hub(
		"people/taylor-pryce-acme-example",
		"taylor.pryce@acme.example",
		["taylor.pryce@acme.example"],
		["meetings/b"],
	),
	hub("people/taylor", "Taylor", [], ["tasks/t1", "tasks/t2"]),
	hub(
		"people/lauren-shaw-via-google-docs",
		"Lauren Shaw (via Google Docs)",
		["drive-shares-dm-noreply@google.com"],
		["sources/doc"],
	),
	hub(
		"people/lauren-shaw-acme-example",
		"lauren.shaw@acme.example",
		["lauren.shaw@acme.example"],
		["meetings/a"],
	),
	hub("people/lauren", "Lauren", [], ["tasks/l"]),
	hub("people/steffan-mills", "Steffan Mills", [], ["tasks/s"]),
	hub("people/lauren-steffan", "Lauren / Steffan", [], ["tasks/ls"]),
	hub(
		"people/autonotification",
		"Autonotification",
		["autonotification@concursolutions.com"],
		["sources/m1"],
	),
	hub("people/marketing", "Marketing", [], ["tasks/m"]),
	hub("people/sven-white", "Sven Whitby", ["sven@acme.example"]),
	hub("people/sven-white-acme-example", "sven.whitby@acme.example", [
		"sven.whitby@acme.example",
	]),
]

const LINKS: SourceLinks = new Map([
	["tasks/t1", [{ kind: "owned_by", target: "people/taylor" }]],
	// Taylor Pryce is in this meeting's notes too: that Taylor.
	[
		"tasks/t2",
		[
			{ kind: "owned_by", target: "people/taylor" },
			{ kind: "mentions", target: "people/taylor-pryce-acme-example" },
		],
	],
	["tasks/l", [{ kind: "owned_by", target: "people/lauren" }]],
	["tasks/ls", [{ kind: "owned_by", target: "people/lauren-steffan" }]],
])

describe("planPeopleCleanup", () => {
	const plan = planPeopleCleanup(HUBS, LINKS)
	const mergeInto = (slug: string) => plan.merges.find((m) => m.into === slug)

	it("moves teams and automated senders to orgs/", () => {
		expect(plan.orgs).toEqual([
			expect.objectContaining({
				into: "orgs/autonotification",
				type: "service",
				from: ["people/autonotification"],
			}),
			expect.objectContaining({
				into: "orgs/marketing",
				type: "team",
				from: ["people/marketing"],
			}),
		])
	})

	it("merges the spellings of one person into the best-named hub", () => {
		expect(mergeInto("people/taylor-morgan")).toMatchObject({
			title: "Taylor Morgan",
			emails: ["taylor.morgan@acme.example"],
			from: ["people/taylor-morgan-acme-example"],
		})
		// The relay hub joins by name; Google's address is dropped.
		const lauren = plan.merges.find((m) =>
			m.from.includes("people/lauren-shaw-via-google-docs"),
		)
		expect(lauren?.into).toBe("people/lauren-shaw-acme-example")
		expect(lauren?.emails).toEqual(["lauren.shaw@acme.example"])
		expect(lauren?.title).toBe("Lauren Shaw")
	})

	it("folds a first name into the only person it can be", () => {
		const lauren = plan.merges.find((m) => m.from.includes("people/lauren"))
		expect(lauren?.reason).toMatch(/everywhere it appears/)
	})

	it("moves links it can place and asks about the rest", () => {
		expect(plan.relinks).toContainEqual({
			source: "tasks/t2",
			kind: "owned_by",
			from: "people/taylor",
			to: ["people/taylor-pryce-acme-example"],
		})
		const asked = plan.suggestions.filter((s) => s.kind === "link")
		expect(asked).toHaveLength(1)
		expect(asked[0]).toMatchObject({
			subject: "people/taylor",
			from: "tasks/t1",
		})
		expect(asked[0].candidates.map((c) => c.title).sort()).toEqual([
			"Taylor Morgan",
			"Taylor Pryce",
		])
		expect(plan.ambiguousHubs).toEqual(["people/taylor"])
	})

	it("splits a pair into a link to each and retires the pair hub", () => {
		expect(plan.relinks).toContainEqual({
			source: "tasks/ls",
			kind: "owned_by",
			from: "people/lauren-steffan",
			to: [expect.stringMatching(/^people\/lauren/), "people/steffan-mills"],
		})
		expect(plan.retire).toEqual(["people/lauren-steffan"])
	})

	it("asks rather than merges the same name with two addresses", () => {
		expect(plan.suggestions).toContainEqual(
			expect.objectContaining({
				kind: "merge",
				subject: expect.stringMatching(/sven/),
			}),
		)
		expect(
			plan.merges.some((m) => m.from.some((f) => f.includes("sven"))),
		).toBe(false)
	})
})
