import { describe, expect, it } from "vitest"
import type { WikiPage } from "./shared.js"
import {
	groupWiki,
	mostLinked,
	slugFromHash,
	wikiGroupOf,
	wikiHash,
} from "./wiki-index.js"

const page = (slug: string, extra: Partial<WikiPage> = {}): WikiPage => ({
	slug,
	title: slug.split("/").pop() ?? slug,
	kind: "source",
	...extra,
})

describe("groupWiki", () => {
	it("groups by origin in browsing order, hubs alphabetical, sources newest first", () => {
		const groups = groupWiki([
			page("tasks/me-b"),
			page("sources/apple-notes/old.md", { updatedAt: "2026-01-01" }),
			page("topics/zeta"),
			page("sources/slack/eng/2026-11-16"),
			page("sources/apple-notes/new.md", { updatedAt: "2026-11-01" }),
			page("topics/alpha"),
			page("sources/email/2026-11/plan-abc123"),
			page("meetings/2026-11-17-standup"),
			page("people/kai"),
			page("weird/thing"),
		])
		expect(groups.map((g) => g.label)).toEqual([
			"Topics",
			"People",
			"Meetings",
			"Apple Notes",
			"Slack",
			"Email",
			"Tasks",
			"Other",
		])
		expect(groups[0].pages.map((p) => p.title)).toEqual(["alpha", "zeta"])
		expect(groups[3].pages.map((p) => p.title)).toEqual(["new.md", "old.md"])
	})

	it("names a page's group for breadcrumbs", () => {
		expect(wikiGroupOf("sources/nextcloud/files/1").label).toBe("Nextcloud")
		expect(wikiGroupOf("sources/other/x").label).toBe("Other sources")
	})
})

describe("mostLinked", () => {
	it("ranks pages by backlinks and skips unlinked ones", () => {
		const out = mostLinked([
			page("topics/a", { backlinks: [{ sourcePageSlug: "x" }] }),
			page("topics/b", {
				backlinks: [{ sourcePageSlug: "x" }, { sourcePageSlug: "y" }],
			}),
			page("topics/c"),
		])
		expect(out.map((p) => p.slug)).toEqual(["topics/b", "topics/a"])
	})
})

describe("wiki hashes", () => {
	it("round-trips slugs, keeping slashes readable", () => {
		const slug = "sources/apple-notes/8ca75970.md"
		expect(wikiHash(slug)).toBe("#wiki/sources/apple-notes/8ca75970.md")
		expect(slugFromHash(wikiHash(slug))).toBe(slug)
		expect(slugFromHash(wikiHash("topics/a b"))).toBe("topics/a b")
		expect(wikiHash()).toBe("#wiki")
		expect(slugFromHash("#wiki")).toBeUndefined()
		expect(slugFromHash("#graph")).toBeUndefined()
	})
})
