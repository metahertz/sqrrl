import { execFile } from "node:child_process"
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { beforeAll, describe, expect, it } from "vitest"
import {
	createDecoder,
	DecodeError,
	probeDuration,
	resolveFfmpeg,
	SAMPLE_RATE,
	SCRATCH_PREFIX,
	sweepScratch,
} from "./decode.js"

const run = promisify(execFile)
const ffmpeg = resolveFfmpeg("")
let dir: string

async function generate(name: string, args: string[]): Promise<Uint8Array> {
	const out = join(dir, name)
	await run(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args, "-y", out])
	return new Uint8Array(await readFile(out))
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "decode-test-"))
})

describe("createDecoder", () => {
	const decode = createDecoder(ffmpeg, 60)

	it("turns stereo 44.1 kHz audio into 16 kHz mono float samples", async () => {
		const mp3 = await generate("tone.mp3", [
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2:sample_rate=44100",
			"-ac",
			"2",
		])
		const pcm = await decode(mp3)
		expect(pcm).toBeInstanceOf(Float32Array)
		expect(pcm.length / SAMPLE_RATE).toBeGreaterThan(1.9)
		expect(pcm.length / SAMPLE_RATE).toBeLessThan(2.2)
		expect(Math.max(...pcm.subarray(0, 4000))).toBeGreaterThan(0.1)
	}, 30_000)

	it("takes the sound out of a video", async () => {
		const mp4 = await generate("clip.mp4", [
			"-f",
			"lavfi",
			"-i",
			"testsrc=size=64x48:rate=5:duration=2",
			"-f",
			"lavfi",
			"-i",
			"sine=duration=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-shortest",
		])
		expect((await decode(mp4)).length).toBeGreaterThan(SAMPLE_RATE)
	}, 30_000)

	it("rejects bytes that are not media", async () => {
		await expect(
			decode(new TextEncoder().encode("not audio")),
		).rejects.toBeInstanceOf(DecodeError)
	})

	it("rejects a video with no sound", async () => {
		const silent = await generate("silent.mp4", [
			"-f",
			"lavfi",
			"-i",
			"testsrc=size=64x48:rate=5:duration=1",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
		])
		await expect(decode(silent)).rejects.toBeInstanceOf(DecodeError)
	}, 30_000)

	it("refuses audio longer than the limit", async () => {
		const long = await generate("long.wav", [
			"-f",
			"lavfi",
			"-i",
			"sine=duration=4",
		])
		await expect(createDecoder(ffmpeg, 2)(long)).rejects.toThrow("longer than")
	}, 30_000)

	it("gives each call its own buffer", async () => {
		const wav = await generate("short.wav", [
			"-f",
			"lavfi",
			"-i",
			"sine=duration=1",
		])
		const [a, b] = await Promise.all([decode(wav), decode(wav)])
		expect(a.buffer).not.toBe(b.buffer)
		a.fill(0)
		expect(Math.max(...b.subarray(0, 4000))).toBeGreaterThan(0.1)
	}, 30_000)

	it("decodes a file on disk the same as its bytes, leaving the file", async () => {
		const wav = await generate("path.wav", [
			"-f",
			"lavfi",
			"-i",
			"sine=duration=1",
		])
		const path = join(dir, "path.wav")
		expect(await decode(path)).toEqual(await decode(wav))
		// The caller owns the staged file; the decoder must not remove it.
		expect((await readFile(path)).byteLength).toBe(wav.byteLength)
	}, 30_000)

	it("returns samples that own their whole buffer, so it can be transferred", async () => {
		const wav = await generate("own.wav", [
			"-f",
			"lavfi",
			"-i",
			"sine=duration=2",
		])
		const pcm = await decode(wav)
		expect(pcm.byteOffset).toBe(0)
		expect(pcm.buffer.byteLength).toBe(pcm.byteLength)
	}, 30_000)

	it("leaves no scratch directory behind, on success or failure", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "decode-scratch-"))
		const scoped = createDecoder(ffmpeg, 60, scratch)
		const wav = await generate("scratch.wav", [
			"-f",
			"lavfi",
			"-i",
			"sine=duration=1",
		])
		await scoped(wav)
		await expect(scoped(new TextEncoder().encode("junk"))).rejects.toThrow(
			DecodeError,
		)
		expect(await readdir(scratch)).toEqual([])
	}, 30_000)

	it("rejects with the abort reason, not as undecodable audio", async () => {
		const wav = await generate("abort.wav", [
			"-f",
			"lavfi",
			"-i",
			"sine=duration=1",
		])
		const already = new AbortController()
		already.abort(new Error("gone before"))
		await expect(decode(wav, already.signal)).rejects.toThrow("gone before")
		// Aborted while the bytes are still being staged.
		const during = new AbortController()
		const job = decode(wav, during.signal)
		during.abort(new Error("gone during"))
		await expect(job).rejects.toThrow("gone during")
	}, 30_000)
})

describe("probeDuration", () => {
	it("reads the declared duration without decoding", async () => {
		await generate("probe.mp3", ["-f", "lavfi", "-i", "sine=duration=7"])
		const d = await probeDuration(ffmpeg, join(dir, "probe.mp3"))
		expect(d).toBeGreaterThan(6.9)
		expect(d).toBeLessThan(7.2)
	}, 30_000)

	it("is undefined for something that is not media", async () => {
		const junk = join(dir, "junk.bin")
		await writeFile(junk, "not audio")
		expect(await probeDuration(ffmpeg, junk)).toBeUndefined()
	}, 30_000)
})

describe("sweepScratch", () => {
	it("removes only this service's scratch dirs, and only old ones", async () => {
		const root = await mkdtemp(join(tmpdir(), "sweep-test-"))
		const old = join(root, `${SCRATCH_PREFIX}upload-old`)
		const fresh = join(root, `${SCRATCH_PREFIX}upload-fresh`)
		const other = join(root, "someone-else")
		for (const d of [old, fresh, other]) await mkdir(d)
		const hourAgo = new Date(Date.now() - 3600_000)
		await utimes(old, hourAgo, hourAgo)
		await utimes(other, hourAgo, hourAgo)
		const removed = await sweepScratch(root, 30 * 60_000)
		expect(removed).toEqual([`${SCRATCH_PREFIX}upload-old`])
		expect((await readdir(root)).sort()).toEqual(
			[`${SCRATCH_PREFIX}upload-fresh`, "someone-else"].sort(),
		)
	})
})
