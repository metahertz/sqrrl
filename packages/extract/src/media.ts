// Recordings → transcript. Audio and video are streamed to disk by the
// connector and handed over as a path, so a two-hour meeting never has to
// fit in memory.

import { readFile } from "node:fs/promises"
import { type AiClient, AiUnavailableError } from "./ai.js"
import type { ExtractKind, ExtractResult } from "./extract.js"
import { splitRecording, timestamp } from "./tools.js"

export interface MediaOptions {
	/** ffmpeg binary, or null when unavailable. */
	ffmpeg: string | null
	segmentSeconds: number
	/** Without ffmpeg the file is uploaded as-is; refuse above this. */
	maxRawUploadBytes: number
	/** Upper bound on the ffmpeg run. */
	timeoutMs: number
	extractorTag: string
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export async function transcribeRecording(
	path: string,
	size: number,
	mimeType: string,
	name: string,
	kind: Extract<ExtractKind, "audio" | "video">,
	ai: AiClient,
	opts: MediaOptions,
): Promise<ExtractResult> {
	const fail = (
		reason: string,
		retryable: boolean,
		waitingFor?: "transcription",
	): ExtractResult => ({
		ok: false,
		kind,
		reason,
		retryable,
		...(waitingFor ? { waitingFor } : {}),
	})

	let segments: Array<{
		startSeconds: number
		bytes: Uint8Array
		mime: string
		name: string
	}>
	if (opts.ffmpeg) {
		try {
			segments = (
				await splitRecording(
					opts.ffmpeg,
					path,
					opts.segmentSeconds,
					opts.timeoutMs,
				)
			).map((s, i) => ({
				...s,
				mime: "audio/mpeg",
				name: `${name}.part-${String(i + 1).padStart(3, "0")}.mp3`,
			}))
		} catch (err) {
			// The file itself is unreadable or silent; it will fail the same way
			// until it changes.
			return fail(message(err), false)
		}
	} else {
		if (size > opts.maxRawUploadBytes) {
			return fail(
				`${size} bytes is over NEXTCLOUD_MAX_RAW_UPLOAD_BYTES and ffmpeg is unavailable to split it`,
				false,
			)
		}
		segments = [
			{
				startSeconds: 0,
				bytes: new Uint8Array(await readFile(path)),
				mime: mimeType,
				name,
			},
		]
	}

	const parts: string[] = []
	for (const seg of segments) {
		try {
			const text = await ai.transcribe(seg.bytes, seg.mime, seg.name)
			parts.push(
				segments.length > 1
					? `[${timestamp(seg.startSeconds)}]\n${text}`
					: text,
			)
		} catch (err) {
			if (err instanceof AiUnavailableError) {
				return fail(err.message, false, "transcription")
			}
			// Endpoint down, timeout, rate limit: worth another pass.
			return fail(
				`transcription failed at ${timestamp(seg.startSeconds)}: ${message(err)}`,
				true,
			)
		}
	}
	const text = parts.join("\n\n").trim()
	if (!text) return fail("the recording transcribed to no text", false)
	const minutes = Math.round((segments.length * opts.segmentSeconds) / 60)
	return {
		ok: true,
		kind,
		extractor: opts.extractorTag,
		text,
		notes:
			segments.length > 1
				? [`transcribed in ${segments.length} segments (up to ${minutes} min)`]
				: [],
	}
}
