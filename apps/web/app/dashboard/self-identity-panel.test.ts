import { describe, expect, it } from "vitest"
import { suggestedNames } from "./self-identity-panel.js"

describe("suggestedNames", () => {
	it("offers the first name and the full name of a person page", () => {
		expect(suggestedNames("Matt Hollis")).toEqual(["Matt", "Matt Hollis"])
		expect(suggestedNames("Matt")).toEqual(["Matt"])
		expect(suggestedNames("matt@example.test")).toEqual([])
	})
})
