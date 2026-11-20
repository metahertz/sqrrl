// Streams a multipart upload straight to disk.
//
// Request.formData() holds the whole body in memory (about 3x the upload,
// measured: +617 MB for a 190 MB file), and with a queue place reserved
// before the body is read, every admitted upload could do that at once.
// Here the body is parsed incrementally with busboy and the file part is
// written to a scratch file as it arrives, so an upload costs a few stream
// buffers whatever its size. The size limit is enforced on the stream: the
// upload stops the moment the file part passes it.

import { createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import busboy from "busboy"
import { SCRATCH_PREFIX } from "./decode.js"

export class UploadTooLargeError extends Error {}
/** Not multipart/form-data, or malformed. */
export class InvalidBodyError extends Error {}

export interface StagedUpload {
	/** Text fields, first value of each name. */
	fields: Record<string, string>
	/** The `file` part, on disk; undefined when the request had none. */
	file?: { path: string; name: string; size: number }
	/** Removes the scratch directory. Safe to call more than once. */
	cleanup(): Promise<void>
}

export interface StageOptions {
	/** Largest file part accepted, in bytes. */
	maxFileBytes: number
	/** Where the scratch directory goes; should be disk-backed. */
	tmpDir: string
	signal?: AbortSignal
}

/** Small form fields only: model, response_format, language, a few more. */
const FIELD_LIMITS = { fields: 16, fieldSize: 16 * 1024, parts: 24, files: 4 }

export async function stageUpload(
	req: Request,
	opts: StageOptions,
): Promise<StagedUpload> {
	const { signal } = opts
	signal?.throwIfAborted()
	const contentType = req.headers.get("content-type") ?? ""
	if (!req.body || !/^multipart\/form-data\b/i.test(contentType)) {
		throw new InvalidBodyError("expected multipart/form-data")
	}
	let parser: busboy.Busboy
	try {
		parser = busboy({
			headers: { "content-type": contentType },
			// busboy reports "limit" on reaching fileSize, not passing it;
			// one more byte lets a file of exactly the limit through.
			limits: { ...FIELD_LIMITS, fileSize: opts.maxFileBytes + 1 },
		})
	} catch {
		// No or bad boundary.
		throw new InvalidBodyError("expected multipart/form-data")
	}

	const dir = await mkdtemp(join(opts.tmpDir, `${SCRATCH_PREFIX}upload-`))
	let removed = false
	const cleanup = async () => {
		if (removed) return
		removed = true
		await rm(dir, { recursive: true, force: true })
	}

	const source = Readable.fromWeb(req.body as WebReadableStream<Uint8Array>)
	const fields: Record<string, string> = {}
	let file: StagedUpload["file"]
	let writing: Promise<void> | undefined
	// The first failure wins; it stops reading the request at once.
	let failure: unknown
	const fail = (err: unknown) => {
		if (failure !== undefined) return
		failure = err
		// Not synchronously: this can run inside one of busboy's own events,
		// and busboy keeps using its state after the emit returns.
		queueMicrotask(() => {
			source.destroy()
			parser.destroy()
		})
	}

	parser.on("field", (name, value) => {
		if (!(name in fields)) fields[name] = value
	})
	parser.on("file", (name, stream, info) => {
		if (name !== "file" || file) {
			stream.resume()
			return
		}
		const path = join(dir, "upload")
		const staged = { path, name: info.filename || "upload", size: 0 }
		file = staged
		stream.on("data", (chunk: Buffer) => {
			staged.size += chunk.byteLength
		})
		stream.on("limit", () =>
			fail(
				new UploadTooLargeError(`upload exceeds ${opts.maxFileBytes} bytes`),
			),
		)
		writing = pipeline(stream, createWriteStream(path)).catch((err) => {
			fail(err)
		})
	})

	const onAbort = () => fail(signal?.reason)
	signal?.addEventListener("abort", onAbort, { once: true })
	try {
		await pipeline(source, parser).catch((err) => {
			fail(failure ?? new InvalidBodyError(`malformed multipart body: ${err}`))
		})
		await writing
		if (failure !== undefined) throw failure
		return { fields, file, cleanup }
	} catch (err) {
		await cleanup()
		throw err
	} finally {
		signal?.removeEventListener("abort", onAbort)
	}
}
