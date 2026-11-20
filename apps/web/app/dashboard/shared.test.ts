import { describe, expect, it } from "vitest"
import { pageType } from "./shared.js"

describe("pageType", () => {
	it("keeps teams and automated senders out of People", () => {
		expect(pageType({ slug: "people/taylor-morgan", kind: "entity" })).toBe(
			"person",
		)
		expect(pageType({ slug: "orgs/travel", kind: "entity" })).toBe("other")
	})
})
