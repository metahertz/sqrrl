// Renderer tests — link construction, document shape and escaping.
//
// These matter because the HTML renderer's links were dead for the whole of
// the wiki's life before this: they pointed at /wiki/<slug>, a route that did
// not exist, and dropped the scope the store is partitioned by. A renderer
// that emits a link nobody can follow looks correct in a unit test that only
// asserts "contains an <a>", so these assert the whole href.

import { describe, expect, it } from "vitest"
import {
	renderWikiPageHtml,
	renderWikiPageDocument,
	renderWikiIndexDocument,
	wikiPageHref,
	wikiIndexHref,
} from "./wiki-renderer.js"
import type { WikiPageView } from "./wiki-bridge.js"

function view(overrides: Partial<WikiPageView> = {}): WikiPageView {
	return {
		_id: "1",
		kind: "source",
		title: "Recording issues",
		slug: "sources/notes/recording.md",
		aliases: [],
		summary: "A summary.",
		body: "Body text.",
		frontmatter: {},
		claims: [],
		contradictions: [],
		questions: [],
		relationships: [],
		personCard: null,
		taskCard: null,
		scope: "workspace",
		scopeRef: "brain",
		trustTier: "standard",
		permissions: {},
		state: "active",
		revision: 3,
		validFrom: "2026-01-01T00:00:00.000Z",
		freshness: "fresh",
		backlinks: [],
		transcludes: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		...overrides,
	}
}

describe("wikiPageHref", () => {
	it("carries scope and scopeRef as query params", () => {
		expect(
			wikiPageHref("people/lauren", { scope: "workspace", scopeRef: "brain" }),
		).toBe("/wiki/people/lauren?scope=workspace&scopeRef=brain")
	})

	it("keeps slug slashes as path separators but encodes each segment", () => {
		const href = wikiPageHref("sources/my notes/a+b.md", {
			scope: "workspace",
			scopeRef: "brain",
		})
		expect(href.startsWith("/wiki/sources/my%20notes/a%2Bb.md")).toBe(true)
	})

	it("honours a custom base path", () => {
		expect(
			wikiPageHref("a", { basePath: "/w", scope: "s", scopeRef: "r" }),
		).toBe("/w/a?scope=s&scopeRef=r")
	})

	it("builds an index href", () => {
		expect(wikiIndexHref({ scope: "workspace", scopeRef: "brain" })).toBe(
			"/wiki/?scope=workspace&scopeRef=brain",
		)
	})
})

describe("renderWikiPageHtml", () => {
	it("defaults links to the page's own scope", () => {
		const html = renderWikiPageHtml(
			view({
				relationships: [
					{
						kind: "relates_to",
						targetPageSlug: "topics/audio",
						targetTitle: "audio",
					},
				],
			}),
		)
		expect(html).toContain(
			'<a href="/wiki/topics/audio?scope=workspace&amp;scopeRef=brain">audio</a>',
		)
	})

	it("gives backlinks a followable href", () => {
		const html = renderWikiPageHtml(
			view({
				backlinks: [
					{ sourcePageSlug: "tasks/fix-mic", sourceTitle: "Fix the mic" },
				],
			}),
		)
		expect(html).toContain(
			"/wiki/tasks/fix-mic?scope=workspace&amp;scopeRef=brain",
		)
	})

	it("resolves [[wikilinks]] in the body to scoped links", () => {
		const html = renderWikiPageHtml(
			view({ body: "See [[people/lauren]] about it." }),
		)
		expect(html).toContain(
			'href="/wiki/people/lauren?scope=workspace&amp;scopeRef=brain"',
		)
	})

	it("escapes a hostile title rather than emitting it as markup", () => {
		const html = renderWikiPageHtml(
			view({ title: "<script>alert(1)</script>" }),
		)
		expect(html).not.toContain("<script>")
		expect(html).toContain("&lt;script&gt;")
	})

	it("escapes a hostile slug inside a relationship href", () => {
		const html = renderWikiPageHtml(
			view({
				relationships: [
					{
						kind: "k",
						targetPageSlug: 'a"><script>x</script>',
						targetTitle: "t",
					},
				],
			}),
		)
		expect(html).not.toContain("<script>")
	})

	it("stays a fragment — no doctype", () => {
		expect(renderWikiPageHtml(view())).not.toContain("<!doctype html>")
	})
})

describe("renderWikiPageDocument", () => {
	it("is a complete document a browser can render", () => {
		const html = renderWikiPageDocument(view())
		expect(html.startsWith("<!doctype html>")).toBe(true)
		expect(html).toContain('<meta charset="utf-8">')
		expect(html).toContain("<title>Recording issues — sqrrl wiki</title>")
		expect(html).toContain("<style>")
	})

	it("links into the console's wiki only when its address is known", () => {
		expect(renderWikiPageDocument(view())).not.toContain("Open in console")
		const html = renderWikiPageDocument(view(), {
			consoleUrl: "http://host:3040/",
		})
		expect(html).toContain(
			`href="http://host:3040/dashboard#wiki/${view().slug}"`,
		)
	})

	it("keeps private pages out of search engines", () => {
		expect(renderWikiPageDocument(view())).toContain(
			'<meta name="robots" content="noindex, nofollow">',
		)
	})

	it("links back to the scope index", () => {
		expect(renderWikiPageDocument(view())).toContain(
			'href="/wiki/?scope=workspace&amp;scopeRef=brain"',
		)
	})

	it("escapes the title in <title> as well as the body", () => {
		const html = renderWikiPageDocument(
			view({ title: "</title><script>x</script>" }),
		)
		expect(html).not.toContain("<script>")
	})
})

describe("renderWikiIndexDocument", () => {
	const entries = [
		{ slug: "people/lauren", title: "Lauren", kind: "entity" },
		{ slug: "topics/audio", title: "audio", kind: "concept" },
		{ slug: "people/priya", title: "Priya", kind: "entity" },
	]

	it("groups pages by kind", () => {
		const html = renderWikiIndexDocument(entries, {
			scope: "workspace",
			scopeRef: "brain",
		})
		expect(html).toContain(">entity <")
		expect(html).toContain(">concept <")
	})

	it("links every entry with the scope carried through", () => {
		const html = renderWikiIndexDocument(entries, {
			scope: "workspace",
			scopeRef: "brain",
		})
		expect(html).toContain(
			'href="/wiki/people/lauren?scope=workspace&amp;scopeRef=brain"',
		)
		expect(html).toContain(
			'href="/wiki/topics/audio?scope=workspace&amp;scopeRef=brain"',
		)
	})

	it("says so when a scope is empty instead of rendering a bare shell", () => {
		const html = renderWikiIndexDocument([], { scope: "s", scopeRef: "r" })
		expect(html).toContain("No pages in this scope yet.")
	})

	it("escapes hostile titles", () => {
		const html = renderWikiIndexDocument(
			[{ slug: "a", title: "<img onerror=x>", kind: "entity" }],
			{ scope: "s", scopeRef: "r" },
		)
		expect(html).not.toContain("<img onerror")
	})
})
