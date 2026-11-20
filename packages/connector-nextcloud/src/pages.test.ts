import { sourceToSlug } from "@sqrrl/wiki-engine"
import { describe, expect, it } from "vitest"
import type { WorkItem } from "./discovery.js"
import {
	batchSources,
	dayOf,
	pageHeader,
	partPath,
	slugForSourcePath,
} from "./pages.js"

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
	key: "file:1",
	kind: "file",
	basePath: "nextcloud/files/1",
	etag: "e",
	title: "Q3 plan.pdf",
	location: "Company/Q3 plan.pdf",
	lastModified: new Date("2026-09-15T10:00:00Z"),
	origins: ["folder:Company"],
	sourceUrl: "https://cloud.example.com/f/1",
	...over,
})

describe("slugForSourcePath", () => {
	it("matches the engine's own sourceToSlug exactly", () => {
		for (const p of [
			"nextcloud/files/11",
			"nextcloud/notes/5",
			partPath("nextcloud/files/11", 2),
			"Weird Path/Ünïcode!!",
			"--edge--/x",
		]) {
			expect(slugForSourcePath(p)).toBe(sourceToSlug(p))
		}
	})
})

describe("partPath", () => {
	it("keeps part 1 on the base path so a growing document keeps its page", () => {
		expect(partPath("b", 0)).toBe("b")
		expect(partPath("b", 1)).toBe("b/part-02")
		expect(partPath("b", 11)).toBe("b/part-12")
	})
})

describe("pageHeader", () => {
	it("names the file and its day", () => {
		expect(pageHeader(item(), 0, 1, "pdf-text@1", [])).toBe(
			'# Q3 plan.pdf\n\nSource: Nextcloud file "Company/Q3 plan.pdf", last modified 2026-09-15.\n\n',
		)
	})

	it("marks parts, machine-made content and extraction notes", () => {
		const h = pageHeader(item(), 1, 3, "vision-caption@1", ["2 pages unread"])
		expect(h).toContain("Part 2 of 3.")
		expect(h).toContain("Content: machine description of an image.")
		expect(h).toContain("Note: 2 pages unread.")
	})

	it("describes notes by category", () => {
		expect(
			pageHeader(item({ kind: "note", location: "" }), 0, 1, "notes-api@1", []),
		).toContain('Nextcloud note in category "(none)"')
	})
})

describe("dayOf", () => {
	it("falls back to today for an invalid date", () => {
		expect(dayOf(new Date("nope"))).toBe(new Date().toISOString().slice(0, 10))
	})
})

describe("batchSources", () => {
	const s = (n: number) => ({ content: "x".repeat(n) })

	it("keeps each batch under the limit", () => {
		const batches = batchSources([s(4), s(4), s(4)], 9)
		expect(batches.map((b) => b.length)).toEqual([2, 1])
	})

	it("still sends a single oversized source on its own", () => {
		expect(batchSources([s(20)], 9)).toEqual([[s(20)]])
	})

	it("returns nothing for nothing", () => {
		expect(batchSources([], 9)).toEqual([])
	})
})
