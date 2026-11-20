// Generates real media for tests with the bundled ffmpeg and canvas, so the
// tool wrappers are exercised against actual encoders rather than mocks.

import { execFile } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { resolveFfmpeg } from "../tools.js"

const run = promisify(execFile)

export const FFMPEG = resolveFfmpeg("")

export async function fixtureDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "nc-fixtures-"))
}

/** A mono sine tone as WAV. */
export async function makeTone(dir: string, seconds: number): Promise<string> {
	if (!FFMPEG) throw new Error("ffmpeg unavailable")
	const out = join(dir, `tone-${seconds}s.wav`)
	await run(FFMPEG, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-y",
		out,
	])
	return out
}

/** A short video, with or without an audio track. */
export async function makeVideo(
	dir: string,
	withAudio: boolean,
): Promise<string> {
	if (!FFMPEG) throw new Error("ffmpeg unavailable")
	const out = join(dir, withAudio ? "with-audio.mp4" : "silent.mp4")
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=160x120:rate=10:duration=3",
	]
	if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=300:duration=3")
	args.push("-c:v", "libx264", "-pix_fmt", "yuv420p")
	if (withAudio) args.push("-c:a", "aac", "-shortest")
	args.push("-y", out)
	await run(FFMPEG, args)
	return out
}

export async function readBytes(path: string): Promise<Uint8Array> {
	return new Uint8Array(await readFile(path))
}

/** A solid-color PNG of the given size. */
export async function makePng(
	width: number,
	height: number,
): Promise<Uint8Array> {
	const { createCanvas } = await import("@napi-rs/canvas")
	const canvas = createCanvas(width, height)
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = "#c00"
	ctx.fillRect(0, 0, width, height)
	return new Uint8Array(await canvas.encode("png"))
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}

export function isPng(bytes: Uint8Array): boolean {
	return (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	)
}

export function isJpeg(bytes: Uint8Array): boolean {
	return bytes[0] === 0xff && bytes[1] === 0xd8
}

/** MP3: an ID3 tag, or an MPEG audio frame sync. */
export function isMp3(bytes: Uint8Array): boolean {
	const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
	const sync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
	return id3 || sync
}
