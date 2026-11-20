import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { Markdown, parseBlocks, renderInline } from "./markdown.js"

const html = (md: string) =>
	renderToStaticMarkup(<Markdown text={md} onWikiLink={vi.fn()} />)

describe("parseBlocks", () => {
	it("splits headings, lists, quotes, code and paragraphs", () => {
		expect(
			parseBlocks(
				"# Title\n\nline one\nline two\n\n- a\n- b\n\n1. x\n\n> q\n\n```\ncode\n```",
			).map((b) => b.type),
		).toEqual(["heading", "para", "list", "list", "quote", "code"])
	})
})

describe("Markdown", () => {
	it("escapes HTML in bodies rather than rendering it", () => {
		const out = html('<img src=x onerror="alert(1)"> **bold**')
		expect(out).not.toContain("<img")
		expect(out).toContain("&lt;img")
		expect(out).toContain("<strong>bold</strong>")
	})

	it("links only http(s) and mailto", () => {
		expect(
			html("[ok](https://example.com) [bad](javascript:alert(1))"),
		).toContain('href="https://example.com"')
		expect(html("[bad](javascript:alert(1))")).not.toContain("href")
	})

	it("turns [[slug]] into an in-app link with its label", () => {
		const onWikiLink = vi.fn()
		const parts = renderInline(
			"see [[people/kai|Kai]] and [[topics/x]]",
			onWikiLink,
		)
		const out = renderToStaticMarkup(<>{parts}</>)
		expect(out).toContain(">Kai</button>")
		expect(out).toContain(">topics/x</button>")
	})

	it("autolinks bare URLs without trailing punctuation", () => {
		expect(html("go to https://zoom.us/j/123.")).toContain(
			'href="https://zoom.us/j/123"',
		)
	})
})
