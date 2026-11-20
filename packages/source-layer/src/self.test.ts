import { describe, expect, it } from "vitest"
import { parseRef } from "./identity.js"
import { isSelfRef, selfKeys } from "./self.js"
import { readSelfInput, SelfIdentityError } from "./self-identity.js"

const SELF = {
	names: ["Matt", "Matt Hollis"],
	emails: ["matt@home.example", "matt.hollis@acme.example"],
}

const is = (name?: string, email?: string) => {
	const ref = parseRef({ name, email })
	if (!ref) throw new Error("parse")
	return isSelfRef(SELF, ref)
}

describe("isSelfRef", () => {
	it("knows the owner by address, full name or first name", () => {
		expect(is(undefined, "Matt.Hollis@acme.example")).toBe(true)
		expect(is("matt.hollis@acme.example")).toBe(true)
		expect(is("Matt Hollis")).toBe(true)
		expect(is("Hollis, Matt")).toBe(true)
		expect(is("Matt")).toBe(true)
	})

	it("does not take namesakes or other addresses", () => {
		expect(is("Matt Stone")).toBe(false)
		expect(is("Matt", "matt@side.example")).toBe(false)
		expect(is("Matthew")).toBe(false)
		expect(isSelfRef(null, parseRef({ name: "Matt" }) as never)).toBe(false)
	})

	it("derives first names from full names", () => {
		expect([...selfKeys({ names: ["Kai Smith"] }).first]).toEqual(["kai"])
	})
})

describe("readSelfInput", () => {
	it("cleans names and addresses", () => {
		expect(
			readSelfInput({
				personSlug: "people/matt-hollis",
				names: "Matt, Matt Hollis, Matt",
				emails: ["MATT@home.example", " matt.hollis@acme.example "],
			}),
		).toEqual({
			personSlug: "people/matt-hollis",
			names: ["Matt", "Matt Hollis"],
			emails: ["matt@home.example", "matt.hollis@acme.example"],
		})
	})

	it("rejects what it cannot use", () => {
		const bad = (b: Record<string, unknown>) => () => readSelfInput(b)
		expect(bad({ personSlug: "tasks/x", names: ["M"] })).toThrow(
			SelfIdentityError,
		)
		expect(bad({ personSlug: "people/m", names: [] })).toThrow(
			"at least one name",
		)
		expect(
			bad({ personSlug: "people/m", names: ["M"], emails: ["nope"] }),
		).toThrow("not an email address")
	})
})
