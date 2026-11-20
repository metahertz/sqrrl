import { strToU8, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import {
	type AiClient,
	AiUnavailableError,
	ResponseMismatchError,
} from "./ai.js"
import {
	classify,
	DEFAULT_EXTRACT_OPTIONS,
	EXTRACTOR_VERSION,
	type ExtractOptions,
	extract,
	splitText,
} from "./extract.js"
import { makeDocx, makePdf, PNG_1PX } from "./testing/doc-fixtures.js"
import { isJpeg, isPng, makePng, pngSize } from "./testing/media-fixtures.js"

/** Extraction with this host's real tools switched on. */
const withTools = (over: Partial<ExtractOptions> = {}): ExtractOptions => ({
	...DEFAULT_EXTRACT_OPTIONS,
	tools: { canvas: true, heic: true, ffmpeg: null },
	...over,
})

function fakeAi(overrides: Partial<AiClient> = {}): AiClient {
	return {
		caption: vi.fn(async () => "A red square.\nText in image: none"),
		transcribe: vi.fn(async () => "Hello team, let's start the standup."),
		...overrides,
	}
}

const ai = fakeAi()

describe("classify", () => {
	it.each([
		["application/pdf", "a.pdf", "pdf"],
		[
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"a.docx",
			"office",
		],
		["application/vnd.oasis.opendocument.text", "a.odt", "office"],
		["application/octet-stream", "deck.pptx", "office"],
		["image/png", "a.png", "image"],
		["audio/mpeg", "a.mp3", "audio"],
		["video/mp4", "call.mp4", "video"],
		["text/markdown", "a.md", "text"],
		["application/octet-stream", "notes.md", "text"],
		["application/zip", "a.zip", "unsupported"],
	])("%s %s → %s", (mime, name, kind) => {
		expect(classify(mime, name)).toBe(kind)
	})
})

describe("extract: text", () => {
	it("decodes plain text", async () => {
		const r = await extract(
			strToU8("# Title\n\nbody"),
			"text/markdown",
			"a.md",
			ai,
		)
		expect(r).toMatchObject({ ok: true, kind: "text", text: "# Title\n\nbody" })
	})

	it("strips HTML, dropping scripts", async () => {
		const r = await extract(
			strToU8("<p>Hi &amp; bye</p><script>alert(1)</script><p>two</p>"),
			"text/html",
			"a.html",
			ai,
		)
		expect(r.ok && r.text).toBe("Hi & bye\ntwo")
	})

	it("refuses an empty file without retrying", async () => {
		expect(
			await extract(strToU8("  \n"), "text/plain", "a.txt", ai),
		).toMatchObject({
			ok: false,
			retryable: false,
		})
	})

	it("tags output with the extractor version", async () => {
		const r = await extract(strToU8("x"), "text/plain", "a.txt", ai)
		expect(r.ok && r.extractor).toBe(`text@${EXTRACTOR_VERSION}`)
	})
})

describe("extract: pdf", () => {
	it("reads the text layer, page by page", async () => {
		const r = await extract(
			makePdf(["Quarterly plan", "Hiring freeze"]),
			"application/pdf",
			"q.pdf",
			ai,
		)
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.text).toContain("## Page 1\nQuarterly plan")
		expect(r.text).toContain("## Page 2\nHiring freeze")
		expect(r.notes).toEqual([])
	})

	it("records scanned pages instead of silently dropping them", async () => {
		const r = await extract(
			makePdf(["Cover", null]),
			"application/pdf",
			"q.pdf",
			ai,
		)
		expect(r.ok && r.notes[0]).toContain(
			"1 of 2 page(s) are scanned and could not be rendered",
		)
	})

	it("fails cleanly on a fully scanned PDF", async () => {
		const r = await extract(makePdf([null]), "application/pdf", "scan.pdf", ai)
		expect(r).toMatchObject({ ok: false, kind: "pdf", retryable: false })
		expect(!r.ok && r.reason).toContain("scanned")
	})

	it("does not detach the caller's buffer", async () => {
		const bytes = makePdf(["x"])
		await extract(bytes, "application/pdf", "a.pdf", ai)
		expect(bytes.byteLength).toBeGreaterThan(0)
	})

	it("reports a corrupt PDF as a non-retryable failure", async () => {
		const r = await extract(
			strToU8("%PDF-1.4 garbage"),
			"application/pdf",
			"bad.pdf",
			ai,
		)
		expect(r).toMatchObject({ ok: false, retryable: false })
	})
})

describe("extract: office", () => {
	it("reads docx paragraphs and decodes entities", async () => {
		const r = await extract(
			makeDocx(["Minutes", "Budget & headcount <draft>"]),
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"m.docx",
			ai,
		)
		expect(r.ok && r.text).toBe("Minutes\nBudget & headcount <draft>")
	})

	it("reads pptx slides in numeric order", async () => {
		const slide = (t: string) =>
			strToU8(
				`<p:sld xmlns:a="a"><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`,
			)
		const bytes = zipSync({
			"ppt/slides/slide10.xml": slide("Ten"),
			"ppt/slides/slide2.xml": slide("Two"),
			"ppt/slides/slide1.xml": slide("One"),
		})
		const r = await extract(bytes, "application/octet-stream", "deck.pptx", ai)
		expect(r.ok && r.text).toBe(
			"## Slide 1\nOne\n\n## Slide 2\nTwo\n\n## Slide 3\nTen",
		)
	})

	it("reads xlsx rows with shared and inline strings", async () => {
		const bytes = zipSync({
			"xl/sharedStrings.xml": strToU8(
				"<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>",
			),
			"xl/worksheets/sheet1.xml": strToU8(
				'<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c><c t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>',
			),
		})
		const r = await extract(
			bytes,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"s.xlsx",
			ai,
		)
		expect(r.ok && r.text).toBe("## Sheet 1\nName\t42\nAda\tok")
	})

	it("reads OpenDocument content.xml", async () => {
		const bytes = zipSync({
			"content.xml": strToU8(
				"<office:document-content><text:h>Plan</text:h><text:p>Ship it<text:tab/>soon</text:p></office:document-content>",
			),
		})
		const r = await extract(
			bytes,
			"application/vnd.oasis.opendocument.text",
			"p.odt",
			ai,
		)
		expect(r.ok && r.text).toBe("Plan\nShip it\tsoon")
	})
})

describe("extract: images and media", () => {
	it("captions supported images through the vision model", async () => {
		const local = fakeAi()
		const r = await extract(PNG_1PX, "image/png", "whiteboard.png", local)
		expect(r).toMatchObject({
			ok: true,
			kind: "image",
			extractor: `vision-caption@${EXTRACTOR_VERSION}`,
		})
		expect(vi.mocked(local.caption).mock.calls[0].slice(0, 3)).toEqual([
			PNG_1PX,
			"image/png",
			"whiteboard.png",
		])
	})

	it("skips HEIC rather than sending a format models reject", async () => {
		const local = fakeAi()
		const r = await extract(PNG_1PX, "image/heic", "IMG_1.heic", local)
		expect(r).toMatchObject({ ok: false, retryable: false })
		expect(local.caption).not.toHaveBeenCalled()
	})

	it("transcribes audio and video", async () => {
		for (const [mime, name] of [
			["audio/mpeg", "standup.mp3"],
			["video/mp4", "call.mp4"],
		]) {
			const r = await extract(new Uint8Array([1, 2]), mime, name, ai)
			expect(r).toMatchObject({
				ok: true,
				text: "Hello team, let's start the standup.",
			})
		}
	})

	it("parks an image when no vision model is configured", async () => {
		const local = fakeAi({
			caption: async () => {
				throw new AiUnavailableError("no vision model configured")
			},
		})
		expect(await extract(PNG_1PX, "image/png", "a.png", local)).toMatchObject({
			ok: false,
			retryable: false,
			waitingFor: "vision",
		})
	})

	it("marks an endpoint failure as retryable", async () => {
		const local = fakeAi({
			transcribe: async () => {
				throw new Error("AI endpoint /audio/transcriptions returned 502")
			},
		})
		expect(
			await extract(new Uint8Array([1]), "audio/wav", "a.wav", local),
		).toMatchObject({
			ok: false,
			retryable: true,
		})
	})

	it("refuses unsupported types", async () => {
		expect(
			await extract(new Uint8Array([1]), "application/zip", "a.zip", ai),
		).toMatchObject({
			ok: false,
			kind: "unsupported",
		})
	})
})

describe("splitText", () => {
	it("leaves short text alone", () => {
		expect(splitText("abc", 10)).toEqual(["abc"])
	})

	it("splits on paragraph boundaries within the limit", () => {
		const parts = splitText("aaaa\n\nbbbb\n\ncccc", 10)
		expect(parts).toEqual(["aaaa\n\nbbbb", "cccc"])
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(10)
	})

	it("hard-splits a single paragraph that is too long", () => {
		const parts = splitText("x".repeat(25), 10)
		expect(parts.map((p) => p.length)).toEqual([10, 10, 5])
	})

	it("loses no text", () => {
		const text = Array.from({ length: 50 }, (_, i) =>
			`para ${i} `.repeat(i + 1),
		).join("\n\n")
		const parts = splitText(text, 200)
		expect(parts.join("\n\n").replace(/\s+/g, "")).toBe(
			text.replace(/\s+/g, ""),
		)
	})
})

describe("extract: scanned PDF pages (with rendering)", () => {
	it("renders scanned pages and captions them", async () => {
		const local = fakeAi({
			caption: vi.fn(async () => "Signed contract, page 2."),
		})
		const r = await extract(
			makePdf(["Cover", null]),
			"application/pdf",
			"c.pdf",
			local,
			withTools(),
		)
		expect(r).toMatchObject({
			ok: true,
			extractor: `pdf-text+vision@${EXTRACTOR_VERSION}`,
			notes: [],
		})
		if (!r.ok) return
		expect(r.text).toContain("## Page 1\nCover")
		expect(r.text).toContain(
			"## Page 2\n(Scanned page, read by a vision model.)\nSigned contract, page 2.",
		)
		const [image, mime, name, purpose] = vi.mocked(local.caption).mock.calls[0]
		expect(isPng(image)).toBe(true)
		expect(mime).toBe("image/png")
		expect(name).toBe("c.pdf page 2")
		expect(purpose).toBe("document-page")
	})

	it("treats a page the model reports as blank as having no text", async () => {
		const local = fakeAi({ caption: vi.fn(async () => " [no text] ") })
		const r = await extract(
			makePdf(["Cover", null]),
			"application/pdf",
			"c.pdf",
			local,
			withTools(),
		)
		expect(r.ok && r.text).toBe("## Page 1\nCover")
	})

	it("captions a fully scanned PDF", async () => {
		const r = await extract(
			makePdf([null, null]),
			"application/pdf",
			"s.pdf",
			ai,
			withTools(),
		)
		expect(r.ok).toBe(true)
		expect(vi.mocked(ai.caption)).toHaveBeenCalled()
	})

	it("keeps the text pages and parks the rest when no vision model is set", async () => {
		const local = fakeAi({
			caption: async () => {
				throw new AiUnavailableError("no vision model configured")
			},
		})
		const r = await extract(
			makePdf(["Cover", null, null]),
			"application/pdf",
			"c.pdf",
			local,
			withTools(),
		)
		expect(r).toMatchObject({ ok: true, waitingFor: "vision" })
		expect(r.ok && r.notes).toEqual([
			"2 scanned page(s) are waiting for a vision model",
		])
	})

	it("parks a fully scanned PDF when no vision model is set", async () => {
		const local = fakeAi({
			caption: async () => {
				throw new AiUnavailableError("no vision model configured")
			},
		})
		const r = await extract(
			makePdf([null]),
			"application/pdf",
			"s.pdf",
			local,
			withTools(),
		)
		expect(r).toMatchObject({
			ok: false,
			retryable: false,
			waitingFor: "vision",
		})
	})

	it("retries when the vision endpoint fails mid-document", async () => {
		const local = fakeAi({
			caption: async () => {
				throw new Error("502")
			},
		})
		const r = await extract(
			makePdf(["x", null]),
			"application/pdf",
			"c.pdf",
			local,
			withTools(),
		)
		expect(r).toMatchObject({ ok: false, retryable: true })
		expect(!r.ok && r.reason).toContain("page 2")
	})

	it("caps how many scanned pages one document may cost", async () => {
		const local = fakeAi()
		const r = await extract(
			makePdf([null, null, null]),
			"application/pdf",
			"s.pdf",
			local,
			withTools({ maxScannedPages: 1 }),
		)
		expect(vi.mocked(local.caption)).toHaveBeenCalledTimes(1)
		expect(r.ok && r.notes[0]).toContain(
			"2 further scanned page(s) were not read",
		)
	})
})

describe("extract: images (with conversion)", () => {
	it("downscales a large photo before captioning", async () => {
		const local = fakeAi()
		await extract(
			await makePng(4000, 3000),
			"image/png",
			"photo.png",
			local,
			withTools({ maxImageEdge: 1024 }),
		)
		const [image, mime] = vi.mocked(local.caption).mock.calls[0]
		expect(mime).toBe("image/png")
		expect(pngSize(image)).toEqual({ width: 1024, height: 768 })
	})

	it("sends JPEGs to the model as PNG", async () => {
		const local = fakeAi()
		const { createCanvas } = await import("@napi-rs/canvas")
		const canvas = createCanvas(200, 100)
		canvas.getContext("2d").fillRect(0, 0, 200, 100)
		const jpeg = new Uint8Array(await canvas.encode("jpeg", 85))
		await extract(jpeg, "image/jpeg", "p.jpg", local, withTools())
		const [image, mime] = vi.mocked(local.caption).mock.calls[0]
		expect(mime).toBe("image/png")
		expect(isPng(image)).toBe(true)
		expect(isJpeg(jpeg)).toBe(true)
	})

	it("recognizes HEIC by extension as well as type", () => {
		expect(classify("application/octet-stream", "IMG_0001.HEIC")).toBe("image")
	})

	it("refuses HEIC permanently when the decoder is unavailable", async () => {
		const r = await extract(
			PNG_1PX,
			"image/heic",
			"a.heic",
			ai,
			withTools({ tools: { canvas: true, heic: false, ffmpeg: null } }),
		)
		expect(r).toMatchObject({ ok: false, retryable: false })
	})

	it("reports a corrupt HEIC as undecodable, not retryable", async () => {
		const local = fakeAi()
		const r = await extract(
			new Uint8Array([0, 1, 2, 3]),
			"image/heic",
			"a.heic",
			local,
			withTools(),
		)
		expect(r).toMatchObject({ ok: false, retryable: false })
		expect(!r.ok && r.reason).toContain("could not decode image")
		expect(local.caption).not.toHaveBeenCalled()
	})

	it("refuses image formats the model cannot take", async () => {
		const r = await extract(PNG_1PX, "image/tiff", "scan.tiff", ai, withTools())
		expect(r).toMatchObject({ ok: false, retryable: false })
	})
})

describe("extract: image verification", () => {
	const verified = (over: Partial<ExtractOptions> = {}) =>
		withTools({
			tools: { canvas: true, heic: true, ffmpeg: null, stamps: true },
			verifyImages: true,
			...over,
		})

	it("stamps pictures and hands the code to the model", async () => {
		const local = fakeAi()
		await extract(
			await makePng(300, 200),
			"image/png",
			"p.png",
			local,
			verified(),
		)
		const [image, mime, , purpose, code] = vi.mocked(local.caption).mock
			.calls[0]
		expect(mime).toBe("image/png")
		expect(purpose).toBe("picture")
		expect(code).toMatch(/^[A-Z0-9]{6}$/)
		expect(pngSize(image).height).toBeGreaterThan(200)
	})

	it("stamps scanned pages too", async () => {
		const local = fakeAi()
		await extract(
			makePdf([null]),
			"application/pdf",
			"s.pdf",
			local,
			verified(),
		)
		expect(vi.mocked(local.caption).mock.calls[0][4]).toMatch(/^[A-Z0-9]{6}$/)
	})

	it("retries later when the model answered about another image", async () => {
		const local = fakeAi({
			caption: async () => {
				throw new ResponseMismatchError(
					'expected HJKL34; inference2: read "no code"',
				)
			},
		})
		const pic = await extract(
			await makePng(50, 50),
			"image/png",
			"p.png",
			local,
			verified(),
		)
		expect(pic).toMatchObject({ ok: false, retryable: true })
		const pdf = await extract(
			makePdf(["x", null]),
			"application/pdf",
			"s.pdf",
			local,
			verified(),
		)
		expect(pdf).toMatchObject({ ok: false, retryable: true })
		expect(!pdf.ok && pdf.reason).toContain(
			"unverifiable vision answer on page 2",
		)
	})

	it("sends no code when verification is off", async () => {
		const local = fakeAi()
		await extract(
			await makePng(50, 50),
			"image/png",
			"p.png",
			local,
			verified({ verifyImages: false }),
		)
		expect(vi.mocked(local.caption).mock.calls[0][4]).toBeUndefined()
	})
})
