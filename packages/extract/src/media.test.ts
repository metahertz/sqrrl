import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { type AiClient, AiUnavailableError } from "./ai.js"
import { type MediaOptions, transcribeRecording } from "./media.js"
import {
	FFMPEG,
	fixtureDir,
	isMp3,
	makeTone,
	makeVideo,
} from "./testing/media-fixtures.js"

let dir: string
beforeAll(async () => {
	dir = await fixtureDir()
})

const opts = (over: Partial<MediaOptions> = {}): MediaOptions => ({
	ffmpeg: FFMPEG,
	segmentSeconds: 10,
	maxRawUploadBytes: 1024 * 1024,
	timeoutMs: 60_000,
	extractorTag: "transcription@2",
	...over,
})

function ai(transcribe: AiClient["transcribe"]): AiClient {
	return { caption: vi.fn(), transcribe: vi.fn(transcribe) }
}

describe.skipIf(!FFMPEG)("transcribeRecording with ffmpeg", () => {
	it("transcribes each segment and marks where it starts", async () => {
		const tone = await makeTone(dir, 25)
		let n = 0
		const client = ai(async () => `segment ${++n}`)
		const r = await transcribeRecording(
			tone,
			0,
			"audio/wav",
			"standup.wav",
			"audio",
			client,
			opts(),
		)
		expect(r).toMatchObject({ ok: true, extractor: "transcription@2" })
		if (!r.ok) return
		expect(r.text).toBe(
			"[00:00:00]\nsegment 1\n\n[00:00:10]\nsegment 2\n\n[00:00:20]\nsegment 3",
		)
		expect(r.notes[0]).toContain("3 segments")
		const calls = vi.mocked(client.transcribe).mock.calls
		expect(calls.map((c) => c[1])).toEqual([
			"audio/mpeg",
			"audio/mpeg",
			"audio/mpeg",
		])
		expect(calls.every((c) => isMp3(c[0]))).toBe(true)
		expect(calls[0][2]).toBe("standup.wav.part-001.mp3")
	}, 60_000)

	it("leaves a single-segment transcript unmarked", async () => {
		const tone = await makeTone(dir, 5)
		const r = await transcribeRecording(
			tone,
			0,
			"audio/wav",
			"a.wav",
			"audio",
			ai(async () => "hello"),
			opts(),
		)
		expect(r).toMatchObject({ ok: true, text: "hello", notes: [] })
	}, 60_000)

	it("transcribes the sound of a video", async () => {
		const video = await makeVideo(dir, true)
		const r = await transcribeRecording(
			video,
			0,
			"video/mp4",
			"call.mp4",
			"video",
			ai(async () => "we ship"),
			opts(),
		)
		expect(r).toMatchObject({ ok: true, kind: "video", text: "we ship" })
	}, 60_000)

	it("fails permanently on a video with no sound", async () => {
		const video = await makeVideo(dir, false)
		const client = ai(async () => "x")
		const r = await transcribeRecording(
			video,
			0,
			"video/mp4",
			"silent.mp4",
			"video",
			client,
			opts(),
		)
		expect(r).toMatchObject({ ok: false, retryable: false })
		expect(client.transcribe).not.toHaveBeenCalled()
	}, 60_000)

	it("parks the recording when no transcription model is configured", async () => {
		const tone = await makeTone(dir, 3)
		const r = await transcribeRecording(
			tone,
			0,
			"audio/wav",
			"a.wav",
			"audio",
			ai(async () => {
				throw new AiUnavailableError("no transcription model configured")
			}),
			opts(),
		)
		expect(r).toMatchObject({
			ok: false,
			retryable: false,
			waitingFor: "transcription",
		})
	}, 60_000)

	it("retries when the endpoint fails, naming where", async () => {
		const tone = await makeTone(dir, 15)
		let n = 0
		const r = await transcribeRecording(
			tone,
			0,
			"audio/wav",
			"a.wav",
			"audio",
			ai(async () => {
				if (++n === 2) throw new Error("502 Bad Gateway")
				return "ok"
			}),
			opts(),
		)
		expect(r).toMatchObject({ ok: false, retryable: true })
		expect(!r.ok && r.reason).toContain("at 00:00:10")
	}, 60_000)
})

describe("transcribeRecording without ffmpeg", () => {
	it("uploads a small recording whole, keeping its type", async () => {
		const path = join(dir, "raw.m4a")
		await writeFile(path, new Uint8Array([1, 2, 3]))
		const client = ai(async () => "raw transcript")
		const r = await transcribeRecording(
			path,
			3,
			"audio/mp4",
			"memo.m4a",
			"audio",
			client,
			opts({ ffmpeg: null }),
		)
		expect(r).toMatchObject({ ok: true, text: "raw transcript" })
		expect(vi.mocked(client.transcribe).mock.calls[0].slice(1)).toEqual([
			"audio/mp4",
			"memo.m4a",
		])
	})

	it("refuses a recording too large to upload unsplit", async () => {
		const client = ai(async () => "x")
		const r = await transcribeRecording(
			"/unused",
			5_000_000,
			"audio/mp4",
			"long.m4a",
			"audio",
			client,
			opts({ ffmpeg: null }),
		)
		expect(r).toMatchObject({ ok: false, retryable: false })
		expect(!r.ok && r.reason).toContain("ffmpeg is unavailable")
		expect(client.transcribe).not.toHaveBeenCalled()
	})
})
