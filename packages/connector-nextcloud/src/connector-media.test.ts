import { beforeEach, describe, expect, it, vi } from "vitest"
import { type AiClient, AiUnavailableError } from "@sqrrl/extract"
import { NextcloudConnector } from "./connector.js"
import { emptyState, type SyncState } from "./state.js"
import {
	config,
	fakeAi,
	fakeWriter,
	seed,
	type Writes,
} from "./testing/connector-harness.js"
import { FakeNextcloud, makePdf } from "./testing/fake-nextcloud.js"
import { FFMPEG, fixtureDir, makeTone, readBytes } from "@sqrrl/extract/testing"

let nc: FakeNextcloud
let state: SyncState
let writes: Writes
let ai: AiClient

beforeEach(() => {
	nc = new FakeNextcloud()
	state = emptyState()
	writes = { raw: [], maintenance: [], frontmatter: [] }
	ai = fakeAi()
	seed(nc)
})

describe("local tools in a full sync", () => {
	const withTools = (cfg = config(), ffmpeg: string | null = FFMPEG) =>
		new NextcloudConnector(cfg, fakeWriter(writes), ai, state, {
			fetchFn: nc.fetch,
			persist: async () => {},
			tools: { canvas: true, heic: true, ffmpeg },
		})

	it("streams recordings under their own size limit, not the document one", async () => {
		// Without ffmpeg: the fixture "recording" is three placeholder bytes,
		// which ffmpeg would rightly reject.
		const report = await withTools(config({ maxFileBytes: 2 }), null).run()
		expect(report.synced).toBe(2)
		expect(report.skipped.map((s) => s.key)).toEqual(["file:11"])
		expect(
			writes.maintenance.some((m) => m.path === "nextcloud/files/12"),
		).toBe(true)
	})

	it("refuses a recording over the media limit without downloading it", async () => {
		const report = await withTools(config({ maxMediaBytes: 2 })).run()
		expect(report.skipped.map((s) => s.key)).toContain("file:12")
		expect(
			nc.requests.some((r) => r.method === "GET" && r.url.includes("standup")),
		).toBe(false)
	})

	it.skipIf(!FFMPEG)(
		"segments a long recording end to end",
		async () => {
			const dir = await fixtureDir()
			const tone = await readBytes(await makeTone(dir, 25))
			nc.files.clear()
			nc.addFile("Company/allhands.wav", {
				fileId: "40",
				etag: "w1",
				bytes: tone,
				mimeType: "audio/wav",
			})
			let n = 0
			ai.transcribe = vi.fn(async () => `part ${++n}`)
			const cfg = config({
				tags: [],
				noteCategories: [],
				audioSegmentSeconds: 10,
			})
			const report = await withTools(cfg).run()
			expect(report.synced).toBe(1)
			const page = writes.maintenance.find(
				(m) => m.path === "nextcloud/files/40",
			)
			expect(page?.content).toContain("[00:00:20]\npart 3")
			expect(page?.content).toContain("Note: transcribed in 3 segments")
		},
		60_000,
	)

	it("syncs the text of a partly scanned PDF now and the rest once vision is configured", async () => {
		nc.files.clear()
		nc.addFile("Company/contract.pdf", {
			fileId: "41",
			etag: "c1",
			bytes: makePdf(["Terms", null]),
			mimeType: "application/pdf",
		})
		const cfg = config({ tags: [], noteCategories: [] })
		ai.caption = vi.fn(async () => {
			throw new AiUnavailableError("no vision model configured")
		})
		const first = await withTools(cfg).run()
		expect(first.synced).toBe(1)
		expect(state.items["file:41"].pending).toBe("vision")
		expect(writes.maintenance[0].content).toContain(
			"1 scanned page(s) are waiting for a vision model",
		)

		expect((await withTools(cfg).run()).changed).toBe(0)

		ai.caption = vi.fn(async () => "Signature page.")
		writes.maintenance = []
		const ready = await withTools(
			config({
				tags: [],
				noteCategories: [],
				aiBaseUrl: "http://ai",
				visionModel: "vlm",
			}),
		).run()
		expect(ready.synced).toBe(1)
		expect(writes.maintenance[0].content).toContain("Signature page.")
		expect(state.items["file:41"].pending).toBeUndefined()
	})
})
