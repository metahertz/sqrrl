import { readdirSync, statSync } from "node:fs"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { InvalidBodyError, stageUpload, UploadTooLargeError } from "./upload.js"

const BOUNDARY = "----tx-upload-test"
const enc = new TextEncoder()

let dir: string
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "tx-upload-test-"))
})

/** Scratch entries stageUpload has left in `dir`. */
const leftovers = () => readdir(dir)

function part(name: string, value: string) {
	return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
}

function fileHead(name = "file", filename = "clip.mp3") {
	return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`
}

const END = `--${BOUNDARY}--\r\n`

function request(
	body: string | ReadableStream<Uint8Array> | null,
	type = `multipart/form-data; boundary=${BOUNDARY}`,
) {
	return new Request("http://t/upload", {
		method: "POST",
		headers: { "Content-Type": type },
		body,
		duplex: "half",
	} as RequestInit)
}

/** A body produced on demand, 64 KiB per pull, with a hook run before each
 *  pull so a test can look at the disk while the upload is in progress. */
function streamed(
	fileBytes: number,
	opts: { before?: string; onPull?: (pulled: number) => void } = {},
) {
	const chunks: Array<() => Uint8Array> = [
		() => enc.encode((opts.before ?? "") + fileHead()),
	]
	for (let sent = 0; sent < fileBytes; sent += 64 * 1024) {
		const n = Math.min(64 * 1024, fileBytes - sent)
		chunks.push(() => new Uint8Array(n).fill(sent % 251))
	}
	chunks.push(() => enc.encode(`\r\n${END}`))
	let pulled = 0
	let i = 0
	const body = new ReadableStream<Uint8Array>(
		{
			pull(ctl) {
				opts.onPull?.(pulled)
				const next = chunks[i++]
				if (!next) {
					ctl.close()
					return
				}
				const chunk = next()
				pulled += chunk.byteLength
				ctl.enqueue(chunk)
				if (i === chunks.length) ctl.close()
			},
		},
		{ highWaterMark: 0 },
	)
	return {
		body,
		get pulled() {
			return pulled
		},
	}
}

/** Size of the staged file on disk right now, 0 if not created yet. */
function stagedBytes(): number {
	for (const sub of readdirSync(dir)) {
		try {
			return statSync(join(dir, sub, "upload")).size
		} catch {}
	}
	return 0
}

describe("stageUpload", () => {
	it("writes the file part to disk and parses the fields", async () => {
		const body =
			part("model", " whisper-1 ") +
			part("response_format", "srt") +
			part("language", "en") +
			part("model", "ignored-second-value") +
			fileHead() +
			"audio-bytes\r\n" +
			END
		const staged = await stageUpload(request(body), {
			maxFileBytes: 1024,
			tmpDir: dir,
		})
		expect(staged.fields).toEqual({
			model: " whisper-1 ",
			response_format: "srt",
			language: "en",
		})
		expect(staged.file?.name).toBe("clip.mp3")
		expect(staged.file?.size).toBe(11)
		expect(await readFile(staged.file?.path as string, "utf8")).toBe(
			"audio-bytes",
		)
		await staged.cleanup()
		await staged.cleanup()
		expect(await leftovers()).toEqual([])
	})

	it("streams a large upload to disk instead of buffering it", async () => {
		// 32 MiB offered; at every pull, what has been read but is not yet on
		// disk must stay small. Buffering the body would let it reach 32 MiB.
		let maxAhead = 0
		const up = streamed(32 * 1024 * 1024, {
			onPull: (pulled) => {
				maxAhead = Math.max(maxAhead, pulled - stagedBytes())
			},
		})
		const staged = await stageUpload(request(up.body), {
			maxFileBytes: 64 * 1024 * 1024,
			tmpDir: dir,
		})
		expect(staged.file?.size).toBe(32 * 1024 * 1024)
		expect(statSync(staged.file?.path as string).size).toBe(32 * 1024 * 1024)
		expect(maxAhead).toBeLessThan(2 * 1024 * 1024)
		await staged.cleanup()
	}, 60_000)

	it("reports no file when the form has only fields", async () => {
		const staged = await stageUpload(
			request(part("model", "whisper-1") + END),
			{
				maxFileBytes: 1024,
				tmpDir: dir,
			},
		)
		expect(staged.file).toBeUndefined()
		expect(staged.fields.model).toBe("whisper-1")
		await staged.cleanup()
		expect(await leftovers()).toEqual([])
	})

	it("ignores file parts under other names", async () => {
		const body =
			fileHead("attachment", "a.bin") + "xx\r\n" + fileHead() + "yy\r\n" + END
		const staged = await stageUpload(request(body), {
			maxFileBytes: 1024,
			tmpDir: dir,
		})
		expect(await readFile(staged.file?.path as string, "utf8")).toBe("yy")
		await staged.cleanup()
	})

	it("stops at the size limit, without reading the rest, and cleans up", async () => {
		const up = streamed(16 * 1024 * 1024)
		await expect(
			stageUpload(request(up.body), { maxFileBytes: 100_000, tmpDir: dir }),
		).rejects.toBeInstanceOf(UploadTooLargeError)
		expect(up.pulled).toBeLessThan(1024 * 1024)
		expect(await leftovers()).toEqual([])
	})

	it("accepts a file of exactly the limit", async () => {
		const staged = await stageUpload(
			request(`${fileHead()}${"x".repeat(1000)}\r\n${END}`),
			{ maxFileBytes: 1000, tmpDir: dir },
		)
		expect(staged.file?.size).toBe(1000)
		await staged.cleanup()
	})

	it("refuses a body that is not multipart, before creating anything", async () => {
		for (const req of [
			request(null),
			request(JSON.stringify({ file: "x" }), "application/json"),
			request("x", "multipart/form-data"), // no boundary
		]) {
			await expect(
				stageUpload(req, { maxFileBytes: 1024, tmpDir: dir }),
			).rejects.toBeInstanceOf(InvalidBodyError)
		}
		expect(await leftovers()).toEqual([])
	})

	it("refuses a truncated multipart body and cleans up", async () => {
		await expect(
			stageUpload(request(`${fileHead()}partial audio`), {
				maxFileBytes: 1024,
				tmpDir: dir,
			}),
		).rejects.toBeInstanceOf(InvalidBodyError)
		expect(await leftovers()).toEqual([])
	})

	it("stops when the client goes away mid-upload and cleans up", async () => {
		const ac = new AbortController()
		const up = streamed(16 * 1024 * 1024, {
			onPull: (pulled) => {
				if (pulled > 256 * 1024) ac.abort(new Error("client gone"))
			},
		})
		await expect(
			stageUpload(request(up.body), {
				maxFileBytes: 64 * 1024 * 1024,
				tmpDir: dir,
				signal: ac.signal,
			}),
		).rejects.toThrow("client gone")
		expect(up.pulled).toBeLessThan(1024 * 1024)
		expect(await leftovers()).toEqual([])
	})
})
