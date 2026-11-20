import { describe, expect, it } from "vitest"
import {
	cleanName,
	isServiceEmail,
	nameFromEmail,
	nameKey,
	parseRef,
	partialMatches,
	splitRefs,
} from "./identity.js"

describe("nameKey and cleanName", () => {
	it("compares names without case, accents or punctuation", () => {
		expect(nameKey("  José  O'Neil ")).toBe("jose oneil")
		expect(nameKey("Taylor M.")).toBe("taylor m")
	})

	it("strips relay and pronoun tags and reorders Last, First", () => {
		expect(cleanName("Lauren Shaw (via Google Docs)")).toBe("Lauren Shaw")
		expect(cleanName("Pedro Jose Henry (P)")).toBe("Pedro Jose Henry")
		expect(cleanName('"Morgan, Taylor"')).toBe("Taylor Morgan")
		expect(cleanName("Kai Smith [EXT]")).toBe("Kai Smith")
		expect(cleanName("Blake-Simons, J. (Jorik)")).toBe("Jorik Blake-Simons")
		expect(cleanName("Jonasson, J.R. (Jack)")).toBe("Jack Jonasson")
		expect(cleanName("mazen.moreau")).toBe("Mazen Moreau")
		expect(
			parseRef({
				name: "Libby Rosen (Google Slides)",
				email: "comments-noreply@docs.google.com",
			})?.kind,
		).toBe("person")
	})

	it("derives a name from an address", () => {
		expect(nameFromEmail("taylor.morgan@acme.example")).toBe("Taylor Morgan")
		expect(nameFromEmail("kai_smith2+news@x.io")).toBe("Kai Smith")
	})
})

describe("parseRef", () => {
	it("gives every spelling of one person the same key", () => {
		const forms = [
			{ name: "Taylor Morgan" },
			{ name: "taylor.morgan@acme.example" },
			{ email: "Taylor.Morgan@acme.example" },
			{ name: "Morgan, Taylor", email: "taylor.morgan@acme.example" },
		]
		for (const f of forms) {
			const r = parseRef(f)
			expect(r?.kind).toBe("person")
			expect(r?.key).toBe("taylor morgan")
			expect(r?.first).toBe("taylor")
			expect(r?.last).toBe("morgan")
		}
		expect(parseRef({ name: "taylor.morgan@acme.example" })?.email).toBe(
			"taylor.morgan@acme.example",
		)
	})

	it("marks partial names", () => {
		expect(parseRef({ name: "Taylor" })).toMatchObject({
			firstOnly: true,
			first: "taylor",
		})
		expect(parseRef({ name: "Taylor M." })).toMatchObject({
			firstOnly: false,
			first: "taylor",
			lastInitial: "m",
		})
	})

	it("keeps a relayed person but drops the relay address", () => {
		const r = parseRef({
			name: "Lauren Shaw (via Google Docs)",
			email: "drive-shares-dm-noreply@google.com",
		})
		expect(r).toMatchObject({ kind: "person", key: "lauren shaw" })
		expect(r?.email).toBeUndefined()
	})

	it("classifies services and groups", () => {
		const svc = (name: string | undefined, email?: string) =>
			parseRef({ name, email })?.kind
		expect(
			svc("Autonotification", "autonotification@concursolutions.com"),
		).toBe("service")
		expect(svc("MongoDB Atlas", "cloud-alerts@acme.example")).toBe("service")
		expect(
			svc("HR Processing", "employeeexperience-noreply@acme.example"),
		).toBe("service")
		expect(
			svc("Scheduled by Aarushi", "c_0000@group.calendar.google.com"),
		).toBe("service")
		expect(svc("Travel", "travel@acme.example")).toBe("service")
		expect(svc("HR")).toBe("group")
		expect(svc("Marketing partners")).toBe("group")
		expect(svc("Toni's team")).toBe("group")
		expect(svc("Steffan", "steffan@acme.example")).toBe("person")
		expect(isServiceEmail("nasir.quinn@acme.example")).toBe(false)
	})
})

describe("splitRefs and partialMatches", () => {
	it("splits loosely written pairs only when every part is a name", () => {
		expect(splitRefs("Lauren / Steffan")).toEqual(["Lauren", "Steffan"])
		expect(splitRefs("Kai and Nasir Quinn")).toEqual(["Kai", "Nasir Quinn"])
		expect(splitRefs("Q3 / Q4 planning")).toEqual(["Q3 / Q4 planning"])
		expect(splitRefs("Taylor")).toEqual(["Taylor"])
	})

	it("matches a first name or first plus initial to a full name", () => {
		const taylor = parseRef({ name: "Taylor" })
		const taylorM = parseRef({ name: "Taylor M" })
		if (!taylor || !taylorM) throw new Error("parse")
		expect(partialMatches(taylor, "taylor morgan")).toBe(true)
		expect(partialMatches(taylorM, "taylor morgan")).toBe(true)
		expect(partialMatches(taylorM, "taylor pryce")).toBe(false)
		expect(partialMatches(taylor, "taylor")).toBe(false)
	})
})
