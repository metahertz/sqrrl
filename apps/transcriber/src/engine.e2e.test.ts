// Runs the real model. Opt-in: needs a speech sample and model files, so
// set TRANSCRIBER_E2E_WAV (a WAV of the JFK "ask not" line) and optionally
// TRANSCRIBER_CACHE_DIR to reuse downloaded weights.

import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { createDecoder, resolveFfmpeg } from "./decode.js"
import { loadWhisper } from "./engine.js"

const wav = process.env.TRANSCRIBER_E2E_WAV

describe.skipIf(!wav)("whisper on this CPU", () => {
	it("transcribes the JFK sample", async () => {
		const engine = await loadWhisper({
			modelId:
				process.env.TRANSCRIBER_MODEL || "onnx-community/whisper-base.en",
			dtype: "q8",
			cacheDir: process.env.TRANSCRIBER_CACHE_DIR || "./models",
			threads: 1,
		})
		const decode = createDecoder(resolveFfmpeg(""), 120)
		const audio = await decode(new Uint8Array(await readFile(wav as string)))
		const t = await engine.transcribe(audio, {})
		expect(t.text.toLowerCase()).toContain(
			"ask not what your country can do for you",
		)
		expect(t.duration).toBeGreaterThan(10)
		expect(t.segments.length).toBeGreaterThan(0)

		// Cancelled mid-job: stops promptly and leaves the engine usable.
		const long = new Float32Array(audio.length * 8)
		for (let i = 0; i < 8; i++) long.set(audio, i * audio.length)
		const ac = new AbortController()
		const job = engine.transcribe(long, { signal: ac.signal })
		setTimeout(() => ac.abort(new Error("cancelled")), 1000)
		await expect(job).rejects.toThrow("cancelled")
		const again = await engine.transcribe(audio, {})
		expect(again.text).toBe(t.text)
	}, 300_000)
})
