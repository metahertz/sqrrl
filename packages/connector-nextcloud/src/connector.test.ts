import { strToU8 } from "fflate"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type AiClient, AiUnavailableError } from "@sqrrl/extract"
import { NextcloudConnector, partPath, slugForSourcePath } from "./connector.js"
import { EXTRACTOR_VERSION } from "@sqrrl/extract"
import { emptyState, type SyncState } from "./state.js"
import {
	BASE,
	FakeNextcloud,
	makePdf,
	PNG_1PX,
} from "./testing/fake-nextcloud.js"
import {
	config,
	fakeAi,
	fakeWriter,
	seed,
	type Writes,
} from "./testing/connector-harness.js"

let nc: FakeNextcloud
let state: SyncState
let writes: Writes
let ai: AiClient

function connector(cfg = config(), writer = fakeWriter(writes)) {
	return new NextcloudConnector(cfg, writer, ai, state, {
		fetchFn: nc.fetch,
		persist: async () => {},
	})
}

beforeEach(() => {
	nc = new FakeNextcloud()
	state = emptyState()
	writes = { raw: [], maintenance: [], frontmatter: [] }
	ai = fakeAi()
	seed(nc)
})

describe("first run", () => {
	it("syncs files from folders and tags plus selected notes", async () => {
		const report = await connector().run()
		expect(report).toMatchObject({
			discovered: 3,
			changed: 3,
			synced: 3,
			failed: [],
			discoveryErrors: [],
		})
		expect(writes.maintenance.map((m) => m.path).sort()).toEqual([
			"nextcloud/files/11",
			"nextcloud/files/12",
			"nextcloud/notes/5",
		])
	})

	it("writes each item's extracted text to Layer 1 before distilling it", async () => {
		const order: string[] = []
		const writer = fakeWriter(writes)
		const rawWrite = writer.rawWrite
		const wikiMaintenance = writer.wikiMaintenance
		writer.rawWrite = async (input) => {
			order.push(`raw:${input.items[0].sourceId}`)
			return rawWrite(input)
		}
		writer.wikiMaintenance = async (input, opts) => {
			order.push(`wiki:${input.changedSources[0].path}`)
			return wikiMaintenance(input, opts)
		}
		await connector(config(), writer).run()
		expect(order.indexOf("raw:file:11#1")).toBeLessThan(
			order.indexOf("wiki:nextcloud/files/11"),
		)
		const policy = writes.raw.find((r) => r.sourceId === "file:11#1")
		expect(policy).toMatchObject({
			source: "nextcloud",
			kind: "file",
			unit: "file:11",
			scope: "workspace",
			metadata: { part: 1, parts: 1 },
		})
		// The raw text is what was extracted, without the wiki page header.
		const page = writes.maintenance.find((m) => m.path === "nextcloud/files/11")
		expect(page?.content.endsWith(policy?.text ?? "∅")).toBe(true)
		expect(page?.content.length).toBeGreaterThan(policy?.text.length ?? 0)
		expect(policy?.metadata).not.toHaveProperty("etag")
		expect(policy?.attachments?.[0]).toMatchObject({ name: policy?.title })
		expect(new Date(policy?.occurredAt ?? "").getTime()).not.toBeNaN()
		expect(writes.raw.find((r) => r.sourceId === "note:5#1")?.kind).toBe("note")
	})

	it("leaves out notes in unselected categories", async () => {
		await connector().run()
		expect(writes.maintenance.some((m) => m.content.includes("milk"))).toBe(
			false,
		)
	})

	it("prefixes content with a header the wiki LLM can title from", async () => {
		await connector().run()
		const policy = writes.maintenance.find(
			(m) => m.path === "nextcloud/files/11",
		)
		expect(policy?.content).toMatch(
			/^# Policy\.md\n\nSource: Nextcloud file "Company\/Policy\.md", last modified 2026-09-15\./,
		)
		expect(policy?.content).toContain("Remote work is allowed.")
		const audio = writes.maintenance.find(
			(m) => m.path === "nextcloud/files/12",
		)
		expect(audio?.content).toContain(
			"Content: machine transcript of a recording.",
		)
		expect(audio?.content).toContain("Alice: we ship Friday.")
	})

	it("anchors relative dates to the file's own modification day", async () => {
		await connector().run()
		expect(
			writes.maintenance.find((m) => m.path === "nextcloud/files/11")?.noteDate,
		).toBe("2026-09-15")
	})

	it("records provenance in schema-defined frontmatter", async () => {
		await connector().run()
		const fm = writes.frontmatter.find(
			(f) => f.slug === "sources/nextcloud/files/12",
		)?.frontmatter
		expect(fm).toMatchObject({
			type: "source",
			title: "standup.mp3",
			status: "stable",
			privacyTier: "internal",
			generated: {
				by: `sqrrl-connector-nextcloud/transcription@${EXTRACTOR_VERSION}`,
			},
			sources: [
				{
					resource: `${BASE}/f/12`,
					id: "file:12",
					title: "Recordings/standup.mp3",
				},
			],
		})
		expect(fm?.tags).toEqual(["nextcloud", "meetings"])
	})

	it("records the synced bytes' hash for phase 2", async () => {
		await connector().run()
		expect(state.items["file:11"].sha256).toMatch(/^[0-9a-f]{64}$/)
	})

	it("skips everything whose etag has not moved", async () => {
		await connector().run()
		writes.maintenance = []
		const report = await connector().run()
		expect(report).toMatchObject({ changed: 0, synced: 0 })
		expect(writes.maintenance).toEqual([])
	})

	it("uses pruneBefore on the second notes listing", async () => {
		await connector().run()
		nc.requests = []
		await connector().run()
		expect(
			nc.requests.find((r) => r.url.includes("/apps/notes/"))?.url,
		).toContain("pruneBefore=")
	})

	it("re-lists every note when the category selection changes", async () => {
		await connector().run()
		nc.requests = []
		await connector(config({ noteCategories: ["Work", "Personal"] })).run()
		expect(
			nc.requests.find((r) => r.url.includes("/apps/notes/"))?.url,
		).not.toContain("pruneBefore")
		expect(writes.maintenance.some((m) => m.content.includes("milk"))).toBe(
			true,
		)
	})

	it("re-syncs a file whose etag changed", async () => {
		await connector().run()
		writes.maintenance = []
		const f = nc.files.get("Company/Policy.md")
		if (!f) throw new Error("fixture")
		f.etag = "p2"
		f.bytes = strToU8("Remote work is allowed two days a week.")
		const report = await connector().run()
		expect(report.synced).toBe(1)
		expect(writes.maintenance[0].content).toContain("two days a week")
	})

	it("keeps a renamed file on the same page", async () => {
		await connector().run()
		const f = nc.files.get("Company/Policy.md")
		if (!f) throw new Error("fixture")
		nc.files.delete("Company/Policy.md")
		nc.files.set("Company/Handbook/Remote Policy.md", { ...f, etag: "p9" })
		writes.maintenance = []
		const report = await connector().run()
		expect(report.markedStale).toBe(0)
		expect(writes.maintenance.map((m) => m.path)).toEqual([
			"nextcloud/files/11",
		])
	})
})

describe("deletions", () => {
	it("deprecates pages of a vanished file instead of deleting them", async () => {
		await connector().run()
		nc.files.delete("Company/Policy.md")
		writes.frontmatter = []
		const report = await connector().run()
		expect(report.markedStale).toBe(1)
		expect(writes.frontmatter).toEqual([
			{
				slug: "sources/nextcloud/files/11",
				frontmatter: { type: "source", status: "deprecated" },
			},
		])
		expect(state.items["file:11"].stale).toBe(true)
		// Layer 1 keeps the history: a tombstone version, not a delete.
		expect(writes.raw.at(-1)).toMatchObject({
			sourceId: "file:11#1",
			text: "",
			metadata: { retired: true },
		})
		expect(writes.raw.at(-1)?.invalidAt).toBeTruthy()
	})

	it("does not deprecate twice", async () => {
		await connector().run()
		nc.files.delete("Company/Policy.md")
		await connector().run()
		writes.frontmatter = []
		expect((await connector().run()).markedStale).toBe(0)
	})

	it("restores a file that comes back", async () => {
		await connector().run()
		const f = nc.files.get("Company/Policy.md")
		if (!f) throw new Error("fixture")
		nc.files.delete("Company/Policy.md")
		await connector().run()
		nc.files.set("Company/Policy.md", f)
		const report = await connector().run()
		expect(report.restored).toBe(1)
		expect(writes.frontmatter.at(-1)?.frontmatter.status).toBe("stable")
		expect(state.items["file:11"].stale).toBe(false)
	})

	it("marks nothing stale when a folder listing fails", async () => {
		await connector().run()
		nc.failPaths.add("Company")
		const report = await connector().run()
		expect(report.markedStale).toBe(0)
		expect(report.discoveryErrors[0]).toContain('folder "Company"')
		expect(state.items["file:11"].stale).toBe(false)
	})

	it("treats a missing tag as a discovery error, not an empty selection", async () => {
		await connector().run()
		nc.tags.delete("meetings")
		const report = await connector().run()
		expect(report.discoveryErrors).toContain(
			'tag "meetings" does not exist in Nextcloud',
		)
		expect(state.items["file:12"].stale).toBe(false)
	})

	it("does not mistake a pruned note for a deleted one", async () => {
		await connector().run()
		const report = await connector().run()
		expect(report.markedStale).toBe(0)
		expect(state.items["note:5"].stale).toBe(false)
	})

	it("deprecates a note that was deleted", async () => {
		await connector().run()
		nc.notes = nc.notes.filter((n) => n.id !== 5)
		const report = await connector().run()
		expect(report.markedStale).toBe(1)
		expect(state.items["note:5"].stale).toBe(true)
	})

	it("withholds note stale marking when the notes listing fails", async () => {
		await connector().run()
		nc.notesInstalled = false
		const report = await connector().run()
		expect(report.markedStale).toBe(0)
		expect(report.discoveryErrors[0]).toContain("notes:")
	})
})

describe("failures and skips", () => {
	it("skips an unsupported file once, and not again at the same etag", async () => {
		nc.addFile("Company/archive.zip", {
			fileId: "20",
			etag: "z1",
			bytes: new Uint8Array([1]),
			mimeType: "application/zip",
		})
		const first = await connector().run()
		expect(first.skipped.map((s) => s.key)).toEqual(["file:20"])
		const second = await connector().run()
		expect(second.skipped).toEqual([])
		expect(second.changed).toBe(0)
	})

	it("parks an image until a vision model is configured, without re-downloading it", async () => {
		nc.addFile("Company/board.png", {
			fileId: "21",
			etag: "i1",
			bytes: PNG_1PX,
			mimeType: "image/png",
		})
		ai.caption = vi.fn(async () => {
			throw new AiUnavailableError("no vision model configured")
		})
		const first = await connector().run()
		expect(first.waiting.map((w) => w.key)).toEqual(["file:21"])
		expect(first.failed).toEqual([])
		expect(state.items["file:21"].pending).toBe("vision")

		nc.requests = []
		const second = await connector().run()
		expect(second.changed).toBe(0)
		expect(
			nc.requests.some((r) => r.method === "GET" && r.url.includes("board")),
		).toBe(false)

		ai.caption = vi.fn(async () => "A whiteboard.")
		const withVision = config({ aiBaseUrl: "http://ai", visionModel: "vlm" })
		const third = await connector(withVision).run()
		expect(third.synced).toBe(1)
		expect(state.items["file:21"].pending).toBeUndefined()
		expect(state.items["file:21"].lastError).toBeUndefined()
	})

	it("retries an image whose vision call failed transiently", async () => {
		nc.addFile("Company/board.png", {
			fileId: "21",
			etag: "i1",
			bytes: PNG_1PX,
			mimeType: "image/png",
		})
		ai.caption = vi.fn(async () => {
			throw new Error("AI endpoint /chat/completions returned 502")
		})
		const first = await connector().run()
		expect(first.failed).toMatchObject([{ key: "file:21", retryable: true }])
		ai.caption = vi.fn(async () => "A whiteboard.")
		expect((await connector().run()).synced).toBe(1)
	})

	it("records a maintenance error as a retryable failure", async () => {
		const report = await connector(
			config(),
			fakeWriter(writes, { maintenanceErrors: ["LLM timeout"] }),
		).run()
		expect(report.failed).toHaveLength(3)
		expect(report.failed[0].reason).toContain("LLM timeout")
		expect(report.synced).toBe(0)
	})

	it("skips files over the size limit without downloading them", async () => {
		const report = await connector(config({ maxFileBytes: 5 })).run()
		expect(report.skipped.map((s) => s.key).sort()).toEqual(["file:11"])
		expect(
			nc.requests.some((r) => r.method === "GET" && r.url.includes("Policy")),
		).toBe(false)
	})

	it("reports a PDF's scanned pages in the page header", async () => {
		nc.addFile("Company/scan.pdf", {
			fileId: "22",
			etag: "d1",
			bytes: makePdf(["Cover", null]),
			mimeType: "application/pdf",
		})
		await connector().run()
		const pdf = writes.maintenance.find((m) => m.path === "nextcloud/files/22")
		expect(pdf?.content).toContain(
			"Note: 1 of 2 page(s) are scanned and could not be rendered",
		)
	})
})

describe("large documents", () => {
	it("splits long text into part pages and retires parts when it shrinks", async () => {
		const long = Array.from({ length: 6 }, (_, i) =>
			`Section ${i} `.repeat(40),
		).join("\n\n")
		nc.files.clear()
		nc.addFile("Company/Handbook.md", {
			fileId: "30",
			etag: "h1",
			bytes: strToU8(long),
			mimeType: "text/markdown",
		})
		const cfg = config({ maxPartChars: 600, tags: [], noteCategories: [] })
		await connector(cfg).run()
		const paths = writes.maintenance.map((m) => m.path)
		expect(paths[0]).toBe("nextcloud/files/30")
		expect(paths.length).toBe(state.items["file:30"].parts)
		expect(paths.length).toBeGreaterThan(1)
		expect(writes.maintenance[1].content).toContain(
			`Part 2 of ${paths.length}.`,
		)

		const f = nc.files.get("Company/Handbook.md")
		if (!f) throw new Error("fixture")
		f.etag = "h2"
		f.bytes = strToU8("Short now.")
		writes.frontmatter = []
		await connector(cfg).run()
		const deprecated = writes.frontmatter
			.filter((w) => w.frontmatter.status === "deprecated")
			.map((w) => w.slug)
		expect(deprecated).toEqual(
			Array.from({ length: paths.length - 1 }, (_, i) =>
				slugForSourcePath(partPath("nextcloud/files/30", i + 1)),
			),
		)
		expect(state.items["file:30"].parts).toBe(1)
		const retired = writes.raw
			.filter((r) => r.metadata?.retired)
			.map((r) => r.sourceId)
		expect(retired).toEqual(
			Array.from({ length: paths.length - 1 }, (_, i) => `file:30#${i + 2}`),
		)
	})
})

describe("SourceConnector contract", () => {
	it("authenticates against WebDAV", async () => {
		expect(await connector().authenticate()).toMatchObject({
			authenticated: true,
		})
	})

	it("reports bad credentials as unauthenticated", async () => {
		const c = new NextcloudConnector(config(), fakeWriter(writes), ai, state, {
			fetchFn: async () => new Response("no", { status: 401 }),
			persist: async () => {},
		})
		expect(await c.authenticate()).toMatchObject({ authenticated: false })
	})

	it("discovers without downloading, then ingests only what it is given", async () => {
		const c = connector()
		const found = await c.discover()
		expect(found.sources.map((s) => s.id).sort()).toEqual([
			"file:11",
			"file:12",
			"note:5",
		])
		expect(
			nc.requests.some(
				(r) => r.method === "GET" && !r.url.includes("/apps/notes/"),
			),
		).toBe(false)
		const result = await c.ingest(
			found.sources.filter((s) => s.id === "note:5"),
		)
		expect(result.pagesUpdated).toBe(1)
		expect(writes.maintenance.map((m) => m.path)).toEqual(["nextcloud/notes/5"])
	})

	it("uses the configured privacy tier for every source", () => {
		expect(
			connector(config({ privacyTier: "confidential" })).mapPermissions(
				{} as never,
			),
		).toEqual({
			privacyTier: "confidential",
		})
	})
})
