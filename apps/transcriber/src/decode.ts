// Any audio or video container → 16 kHz mono float32 PCM, which is what
// Whisper consumes. ffmpeg reads from a temporary file rather than stdin so
// formats that need to seek (MP4 with a trailing moov atom) still decode.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const SAMPLE_RATE = 16_000

export class DecodeError extends Error {}

const require = createRequire(import.meta.url)

export function resolveFfmpeg(configured: string): string {
	if (configured) {
		if (!existsSync(configured)) {
			throw new Error(`ffmpeg not found at ${configured}`)
		}
		return configured
	}
	const bundled = require("ffmpeg-static") as string | null
	if (!bundled || !existsSync(bundled)) {
		throw new Error("ffmpeg-static did not install a binary")
	}
	return bundled
}

/** Decodes audio: a path to a file already on disk (a staged upload), or
 *  the bytes themselves. Aborting `signal` kills ffmpeg and rejects with the
 *  signal's reason. */
export type Decoder = (
	input: string | Uint8Array,
	signal?: AbortSignal,
) => Promise<Float32Array>

/** Prefix of every scratch directory this service creates, so a sweep at
 *  startup can find ones a crash left behind. */
export const SCRATCH_PREFIX = "sqrrl-transcriber-"

/** `tmpDir` should be disk-backed: on a tmpfs /tmp, scratch files are RAM
 *  charged to the service's own memory limit. */
export function createDecoder(
	ffmpeg: string,
	maxSeconds: number,
	tmpDir: string = tmpdir(),
): Decoder {
	return async (upload, signal) => {
		signal?.throwIfAborted()
		const dir = await mkdtemp(join(tmpDir, `${SCRATCH_PREFIX}decode-`))
		try {
			let input = upload
			if (typeof input !== "string") {
				input = join(dir, "input")
				await writeFile(input, upload, { signal }).catch((err) => {
					throw signal?.aborted ? signal.reason : err
				})
			}
			// ffmpeg writes the samples to a file rather than a pipe: a piped
			// result is gathered in chunks and then concatenated, two full
			// copies of up to ~700 MB (3 h) at the peak. Read back, it is one.
			const output = join(dir, "pcm.f32")
			await new Promise<void>((resolve, reject) => {
				execFile(
					ffmpeg,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-nostdin",
						"-i",
						input,
						"-t",
						String(maxSeconds + 1),
						"-vn",
						"-ac",
						"1",
						"-ar",
						String(SAMPLE_RATE),
						"-f",
						"f32le",
						"-y",
						output,
					],
					{ signal },
					(err, _stdout, stderr) => {
						if (signal?.aborted) {
							reject(signal.reason)
							return
						}
						if (err) {
							const detail = String(stderr).trim().split("\n").slice(-1)[0]
							reject(
								new DecodeError(
									`not decodable audio${detail ? `: ${detail}` : ""}`,
								),
							)
							return
						}
						resolve()
					},
				)
			})
			const bytes = (await stat(output)).size
			if (bytes < 4) throw new DecodeError("file contains no audio")
			const samples = Math.floor(bytes / 4)
			if (samples / SAMPLE_RATE > maxSeconds) {
				throw new DecodeError(
					`audio is longer than TRANSCRIBER_MAX_AUDIO_SECONDS (${maxSeconds})`,
				)
			}
			const pcm = await readFile(output, { signal }).catch((err) => {
				throw signal?.aborted ? signal.reason : err
			})
			// The samples must sit alone in their own ArrayBuffer: the engine
			// transfers that buffer to its worker thread, which would detach
			// anything else sharing it. A file this size is read into a
			// dedicated buffer, so a view is enough; copy only if not.
			if (pcm.byteOffset === 0 && pcm.buffer.byteLength === samples * 4) {
				return new Float32Array(pcm.buffer, 0, samples)
			}
			return new Float32Array(
				pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + samples * 4),
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}
}

/** The container's declared duration in seconds, without decoding; undefined
 *  when ffmpeg cannot tell. Cheap (header only), used to estimate backlog. */
export function probeDuration(
	ffmpeg: string,
	path: string,
	signal?: AbortSignal,
): Promise<number | undefined> {
	return new Promise((resolve) => {
		// With no output named, ffmpeg prints the input's header and exits
		// non-zero; the header is all that is wanted.
		execFile(
			ffmpeg,
			["-hide_banner", "-nostdin", "-i", path],
			{ signal, timeout: 10_000 },
			(_err, _stdout, stderr) => {
				const m = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(
					String(stderr),
				)
				resolve(
					m
						? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
						: undefined,
				)
			},
		)
	})
}

/** Removes scratch directories older than `olderThanMs` that a crash left
 *  behind (a clean exit removes its own). Age-based, so another instance
 *  sharing the directory keeps the ones it is still using. */
export async function sweepScratch(
	tmpDir: string,
	olderThanMs: number,
	now = Date.now(),
): Promise<string[]> {
	const removed: string[] = []
	for (const name of await readdir(tmpDir).catch(() => [])) {
		if (!name.startsWith(SCRATCH_PREFIX)) continue
		const path = join(tmpDir, name)
		const info = await stat(path).catch(() => undefined)
		if (!info?.isDirectory() || now - info.mtimeMs < olderThanMs) continue
		await rm(path, { recursive: true, force: true })
		removed.push(name)
	}
	return removed
}
