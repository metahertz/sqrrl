import { describe, expect, it } from "vitest"
import { metadata } from "./layout.js"

describe("showcase metadata", () => {
	it("names SQRRL and what it keeps", () => {
		expect(metadata.title).toBe("SQRRL | Squirrel away what you know")
		expect(metadata.description).toContain("second brain")
		expect(metadata.description).toContain("cited wiki")
		expect(metadata.openGraph?.images).toEqual([
			{
				url: "/opengraph-image",
				width: 1200,
				height: 630,
				alt: "SQRRL squirrels away notes, meetings, Slack and mail into one cited wiki.",
			},
		])
	})
})
