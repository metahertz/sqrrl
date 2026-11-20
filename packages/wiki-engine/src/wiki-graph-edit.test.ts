import { beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({ getWikiPage: vi.fn() }))
const backlinks = vi.hoisted(() => ({ recomputeBacklinksAfterChange: vi.fn() }))
vi.mock("./wiki-bridge.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wiki-bridge.js")>()),
	...bridge,
}))
vi.mock("./wiki-backlinks.js", () => backlinks)

import { purgeWikiPage } from "./wiki-graph-edit.js"

const SCOPE = { scope: "workspace", scopeRef: "ws-1" }

function fakeDb(found: Array<{ slug: string }> = []) {
	const pages = {
		find: vi.fn(() => ({ toArray: async () => found })),
		findOneAndDelete: vi.fn(async (q: { slug: string }) => ({ slug: q.slug })),
	}
	const revisions = { deleteMany: vi.fn(async () => ({ deletedCount: 2 })) }
	const db = {
		collection: (name: string) =>
			name.endsWith("wiki_revisions") ? revisions : pages,
	}
	return { handle: { db, prefix: "t_" } as never, pages, revisions }
}

beforeEach(() => {
	bridge.getWikiPage.mockReset()
	backlinks.recomputeBacklinksAfterChange.mockReset()
	bridge.getWikiPage.mockImplementation(async (_h, slug: string) => ({
		slug,
		backlinks: [],
		relationships: [{ targetPageSlug: "topics/devrel", kind: "relates_to" }],
	}))
})

describe("purgeWikiPage", () => {
	it("deletes the page and its revisions, then clears its backlinks on the pages it linked to", async () => {
		const { handle, pages, revisions } = fakeDb()
		const out = await purgeWikiPage(handle, {
			slug: "sources/apple-notes/a.md",
			...SCOPE,
		})
		expect(out).toMatchObject({
			pagesPurged: ["sources/apple-notes/a.md"],
			revisionsDeleted: 2,
			errors: [],
		})
		expect(revisions.deleteMany).toHaveBeenCalledWith({
			pageSlug: "sources/apple-notes/a.md",
			...SCOPE,
		})
		expect(pages.findOneAndDelete).toHaveBeenCalledWith({
			slug: "sources/apple-notes/a.md",
			...SCOPE,
		})
		// The regression: topics/devrel kept a backlink carrying the purged
		// page's title, which held a credential.
		expect(backlinks.recomputeBacklinksAfterChange).toHaveBeenCalledWith(
			handle,
			"sources/apple-notes/a.md",
			"workspace",
			"ws-1",
			{ deleted: true },
		)
	})

	it("clears backlinks for every cascaded task too", async () => {
		const { handle } = fakeDb([{ slug: "tasks/t1" }])
		const out = await purgeWikiPage(handle, {
			slug: "sources/a.md",
			...SCOPE,
			cascadeTasks: true,
		})
		expect(out.pagesPurged).toEqual(["sources/a.md", "tasks/t1"])
		const purgedSlugs = backlinks.recomputeBacklinksAfterChange.mock.calls.map(
			(c) => c[1],
		)
		expect(purgedSlugs).toEqual(["sources/a.md", "tasks/t1"])
	})

	it("does not recompute when nothing was deleted", async () => {
		const { handle, pages } = fakeDb()
		pages.findOneAndDelete.mockResolvedValue(null as never)
		await purgeWikiPage(handle, { slug: "sources/a.md", ...SCOPE })
		expect(backlinks.recomputeBacklinksAfterChange).not.toHaveBeenCalled()
	})
})
