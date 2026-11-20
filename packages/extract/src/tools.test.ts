import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { getDocumentProxy } from "unpdf"
import { beforeAll, describe, expect, it } from "vitest"
import { makePdf } from "./testing/doc-fixtures.js"
import {
	FFMPEG,
	fixtureDir,
	isJpeg,
	isMp3,
	isPng,
	makePng,
	makeTone,
	makeVideo,
	pngSize,
} from "./testing/media-fixtures.js"
import {
	ensureStampFont,
	heicToPng,
	newVerificationCode,
	probeTools,
	pdfDocumentOptions,
	renderPdfPage,
	resolveFfmpeg,
	splitRecording,
	stampImage,
	timestamp,
	toVisionPng,
} from "./tools.js"

let dir: string
beforeAll(async () => {
	dir = await fixtureDir()
})

describe("resolveFfmpeg", () => {
	it("uses the binary bundled by ffmpeg-static by default", () => {
		const path = resolveFfmpeg("")
		expect(path).toBeTruthy()
		expect(existsSync(path as string)).toBe(true)
	})

	it("can be disabled, and ignores a path that does not exist", () => {
		expect(resolveFfmpeg("none")).toBeNull()
		expect(resolveFfmpeg("/no/such/ffmpeg")).toBeNull()
	})
})

describe("probeTools", () => {
	it("finds every tool this package ships", async () => {
		const tools = await probeTools("")
		expect(tools).toMatchObject({
			canvas: true,
			heic: true,
			pdfFonts: true,
			stamps: true,
		})
		expect(tools.ffmpeg).toBeTruthy()
	})
})

describe("timestamp", () => {
	it("formats hh:mm:ss", () => {
		expect(timestamp(0)).toBe("00:00:00")
		expect(timestamp(600)).toBe("00:10:00")
		expect(timestamp(3725.9)).toBe("01:02:05")
	})
})

describe.skipIf(!FFMPEG)("splitRecording", () => {
	const ffmpeg = FFMPEG as string

	it("cuts a recording into 16 kHz mono MP3 segments with offsets", async () => {
		const tone = await makeTone(dir, 25)
		const segments = await splitRecording(ffmpeg, tone, 10, 60_000)
		expect(segments.map((s) => s.startSeconds)).toEqual([0, 10, 20])
		for (const s of segments) expect(isMp3(s.bytes)).toBe(true)
	}, 60_000)

	it("shrinks audio well below the source size", async () => {
		const tone = await makeTone(dir, 20)
		const [seg] = await splitRecording(ffmpeg, tone, 600, 60_000)
		const wavSize = (await readFile(tone)).byteLength
		expect(seg.bytes.byteLength).toBeLessThan(wavSize / 5)
	}, 60_000)

	it("keeps only the sound of a video", async () => {
		const video = await makeVideo(dir, true)
		const segments = await splitRecording(ffmpeg, video, 600, 60_000)
		expect(segments).toHaveLength(1)
		expect(isMp3(segments[0].bytes)).toBe(true)
	}, 60_000)

	it("fails on a video with no audio track", async () => {
		const video = await makeVideo(dir, false)
		await expect(splitRecording(ffmpeg, video, 600, 60_000)).rejects.toThrow()
	}, 60_000)

	it("fails on a file that is not media", async () => {
		const bogus = `${dir}/bogus.mp3`
		await import("node:fs/promises").then((fs) =>
			fs.writeFile(bogus, "not audio"),
		)
		await expect(splitRecording(ffmpeg, bogus, 600, 60_000)).rejects.toThrow(
			"ffmpeg could not read the recording",
		)
	}, 60_000)
})

describe("toVisionPng", () => {
	it("downscales a large image to the longest-edge limit", async () => {
		const out = await toVisionPng(await makePng(3000, 1000), 1000)
		expect(isPng(out)).toBe(true)
		expect(pngSize(out)).toEqual({ width: 1000, height: 333 })
	})

	it("re-encodes a JPEG as PNG even when it is already small", async () => {
		const { createCanvas } = await import("@napi-rs/canvas")
		const canvas = createCanvas(300, 200)
		canvas.getContext("2d").fillRect(0, 0, 300, 200)
		const jpeg = new Uint8Array(await canvas.encode("jpeg", 85))
		expect(isJpeg(jpeg)).toBe(true)
		const out = await toVisionPng(jpeg, 1000)
		expect(isPng(out)).toBe(true)
		expect(pngSize(out)).toEqual({ width: 300, height: 200 })
	})

	it("converts WebP, which llama.cpp cannot decode", async () => {
		const { createCanvas } = await import("@napi-rs/canvas")
		const canvas = createCanvas(64, 32)
		canvas.getContext("2d").fillRect(0, 0, 64, 32)
		const webp = new Uint8Array(await canvas.encode("webp", 80))
		expect(pngSize(await toVisionPng(webp, 1000))).toEqual({
			width: 64,
			height: 32,
		})
	})
})

describe("renderPdfPage", () => {
	it("renders a page to PNG at the requested scale", async () => {
		const doc = await getDocumentProxy(makePdf([null]))
		const png = await renderPdfPage(doc, 1, 2)
		expect(isPng(png)).toBe(true)
		expect(pngSize(png)).toEqual({ width: 1224, height: 1584 })
	})
})

describe("rendering text without system fonts", () => {
	async function darkPixels(png: Uint8Array): Promise<number> {
		const { loadImage, createCanvas } = await import("@napi-rs/canvas")
		const img = await loadImage(Buffer.from(png))
		const canvas = createCanvas(img.width, img.height)
		const ctx = canvas.getContext("2d")
		ctx.drawImage(img, 0, 0)
		const data = ctx.getImageData(0, 0, img.width, img.height).data
		let dark = 0
		for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++
		return dark
	}

	it("draws non-embedded standard-font text using the bundled fonts", async () => {
		const doc = await getDocumentProxy(
			makePdf(["Q3 GOALS"]),
			pdfDocumentOptions() as Parameters<typeof getDocumentProxy>[1],
		)
		expect(await darkPixels(await renderPdfPage(doc, 1, 2))).toBeGreaterThan(
			500,
		)
	})

	it("points pdf.js at the bundled font directory", () => {
		const opts = pdfDocumentOptions()
		expect(opts.useSystemFonts).toBe(false)
		expect(existsSync(String(opts.standardFontDataUrl))).toBe(true)
	})
})

describe("verification stamps", () => {
	it("makes codes from an unambiguous alphabet", () => {
		const codes = new Set(
			Array.from({ length: 200 }, () => newVerificationCode()),
		)
		expect(codes.size).toBeGreaterThan(195)
		for (const c of codes) expect(c).toMatch(/^[ACDEFHJKLMNPRTUVWXY3479]{6}$/)
	})

	it("finds a font to draw with on a host that has none", async () => {
		expect(await ensureStampFont()).toBe(true)
	})

	it("scales narrow images up to the minimum stamped width", async () => {
		const out = await stampImage(await makePng(512, 256), "HJKL34")
		expect(pngSize(out)).toEqual({ width: 1024, height: 512 + 96 })
	})

	it("adds a band below the image with the code drawn in it", async () => {
		const src = await makePng(2000, 400)
		const out = await stampImage(src, "HJKL34")
		expect(isPng(out)).toBe(true)
		const { width, height } = pngSize(out)
		expect(width).toBe(2000)
		expect(height).toBe(400 + 120)
		const { loadImage, createCanvas } = await import("@napi-rs/canvas")
		const img = await loadImage(Buffer.from(out))
		const canvas = createCanvas(width, height)
		const ctx = canvas.getContext("2d")
		ctx.drawImage(img, 0, 0)
		const band = ctx.getImageData(0, 400, width, 120).data
		let white = 0
		for (let i = 0; i < band.length; i += 4) if (band[i] > 200) white++
		expect(white).toBeGreaterThan(300)
		// The original pixels are untouched.
		expect([...ctx.getImageData(10, 10, 1, 1).data.slice(0, 3)]).toEqual([
			204, 0, 0,
		])
	})
})

describe("heicToPng", () => {
	it("rejects bytes that are not HEIC", async () => {
		await expect(heicToPng(new Uint8Array([1, 2, 3]), 1024)).rejects.toThrow()
	})

	// No HEIC encoder is available to generate a fixture, and a real photo is
	// too large to commit. Point HEIC_FIXTURE at one to exercise decoding.
	it.skipIf(!process.env.HEIC_FIXTURE)(
		"decodes a real HEIC photo",
		async () => {
			const bytes = new Uint8Array(
				await readFile(process.env.HEIC_FIXTURE as string),
			)
			const png = await heicToPng(bytes, 512)
			expect(isPng(png)).toBe(true)
			const { width, height } = pngSize(png)
			expect(Math.max(width, height)).toBe(512)
		},
		60_000,
	)
})
