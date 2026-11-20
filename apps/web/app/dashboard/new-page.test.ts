import { describe, expect, it } from "vitest"
import {
	buildNewPage,
	NEW_PAGE_KINDS,
	slugify,
	validateNewPage,
} from "./new-page.js"
import type { WikiPage } from "./shared.js"

const topic = NEW_PAGE_KINDS[0]
const person = NEW_PAGE_KINDS[1]

const page = (slug: string, title: string): WikiPage => ({
	slug,
	title,
	kind: "concept",
})

describe("slugify", () => {
	// These are the shapes the engine produces; if this drifts, a hand-made
	// hub and an engine-made one for the same title become two pages.
	it("matches the engine's slugs for real titles", () => {
		expect(slugify("community engagement")).toBe("community-engagement")
		expect(slugify("Marie MOPS")).toBe("marie-mops")
		expect(slugify("Sept / Oct")).toBe("sept-oct")
	})

	it("trims the separators it introduces at both ends", () => {
		expect(slugify("  --Security!  ")).toBe("security")
	})

	it("never ends on a hyphen after truncation", () => {
		expect(slugify("ab cdef", 3)).toBe("ab")
	})

	it("falls back rather than returning an empty slug", () => {
		expect(slugify("!!!")).toBe("untitled")
	})
})

describe("buildNewPage", () => {
	it("builds a topic the way ensureHubPage does", () => {
		expect(buildNewPage(topic, "  Security  ")).toEqual({
			kind: "concept",
			title: "Security",
			slug: "topics/security",
			summary: "Topic hub for Security. Sources referencing it link here.",
			body: "",
			frontmatter: { type: "topic" },
			trustTier: "standard",
		})
	})

	it("builds a person under people/ with the person frontmatter type", () => {
		const out = buildNewPage(person, "Marie MOPS")
		expect(out.kind).toBe("entity")
		expect(out.slug).toBe("people/marie-mops")
		expect(out.frontmatter).toEqual({ type: "person" })
		expect(out.summary).toBe(
			"Person hub for Marie MOPS. Tasks they own link here.",
		)
	})
})

describe("validateNewPage", () => {
	const existing = [page("topics/security", "security")]

	it("accepts a title with no clash", () => {
		expect(validateNewPage(topic, "Observability", existing)).toBeNull()
	})

	it("rejects an empty or whitespace title", () => {
		expect(validateNewPage(topic, "", existing)).toBe("Give it a title.")
		expect(validateNewPage(topic, "   ", existing)).toBe("Give it a title.")
	})

	it("refuses a slug that already exists, since wikiApply would upsert", () => {
		expect(validateNewPage(topic, "Security", existing)).toBe(
			'"security" already uses topics/security.',
		)
	})

	it("catches a clash that only appears after slugifying", () => {
		// Different text, same slug — the case the plain title comparison misses.
		expect(validateNewPage(topic, "  SECURITY!  ", existing)).toBe(
			'"security" already uses topics/security.',
		)
	})

	it("does not confuse the two prefixes", () => {
		expect(validateNewPage(person, "Security", existing)).toBeNull()
	})
})
