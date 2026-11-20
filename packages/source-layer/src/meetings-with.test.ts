import { describe, expect, it } from "vitest"
import { participantPatterns } from "./meetings-with.js"

const matches = (person: { emails: string[]; names: string[] }, p: string) =>
	participantPatterns(person).some((re) => re.test(p))

describe("participantPatterns", () => {
	const kai = { emails: ["kai.smith@example.com"], names: ["Kai Smith", "Kai"] }

	it("matches an address alone or inside a name", () => {
		expect(matches(kai, "kai.smith@example.com")).toBe(true)
		expect(matches(kai, "Kai Smith <KAI.SMITH@example.com>")).toBe(true)
		expect(matches(kai, "Kai S <kai.smith@example.com>")).toBe(true)
	})

	it("matches a full name, never a first name alone", () => {
		expect(matches(kai, "Kai Smith")).toBe(true)
		expect(matches(kai, "Kai")).toBe(false)
		expect(matches(kai, "Kai Jones <kai.jones@example.com>")).toBe(false)
	})

	it("does not match a longer address that contains this one", () => {
		expect(matches(kai, "xkai.smith@example.com")).toBe(false)
		expect(matches(kai, "kai.smith@example.com.au")).toBe(false)
	})

	it("treats address characters literally", () => {
		expect(matches(kai, "kaiXsmith@example.com")).toBe(false)
	})
})
