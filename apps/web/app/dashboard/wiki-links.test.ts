import { describe, expect, it } from "vitest"
import { wikiIndexUrl, wikiPageUrl } from "./wiki-links.js"

describe("wikiPageUrl", () => {
	it("builds an absolute URL on the API origin with scope carried", () => {
		expect(
			wikiPageUrl("http://host:3847", "people/lauren", "workspace", "brain"),
		).toBe("http://host:3847/wiki/people/lauren?scope=workspace&scopeRef=brain")
	})

	it("keeps slug slashes as path separators and encodes each segment", () => {
		expect(
			wikiPageUrl(
				"http://host:3847",
				"sources/my notes/a.md",
				"workspace",
				"brain",
			),
		).toBe(
			"http://host:3847/wiki/sources/my%20notes/a.md?scope=workspace&scopeRef=brain",
		)
	})

	it("tolerates a trailing slash on the base", () => {
		expect(wikiPageUrl("http://host:3847/", "a", "s", "r")).toBe(
			"http://host:3847/wiki/a?scope=s&scopeRef=r",
		)
	})

	it("escapes a scopeRef that would otherwise break the query", () => {
		expect(wikiPageUrl("http://h", "a", "workspace", "a&b=c")).toContain(
			"scopeRef=a%26b%3Dc",
		)
	})
})

describe("wikiIndexUrl", () => {
	it("points at the scope index", () => {
		expect(wikiIndexUrl("http://host:3847", "workspace", "brain")).toBe(
			"http://host:3847/wiki/?scope=workspace&scopeRef=brain",
		)
	})
})
