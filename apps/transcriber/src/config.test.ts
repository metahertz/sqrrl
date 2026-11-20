import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig } from "./config.js"

describe("loadConfig", () => {
	it("defaults to whisper-base.en on loopback", () => {
		const c = loadConfig({ TRANSCRIBER_API_KEY: "k" }, 4)
		expect(c).toMatchObject({
			host: "127.0.0.1",
			port: 3960,
			modelId: "onnx-community/whisper-base.en",
			dtype: "q8",
			// threads is PER WORKER now: 4 cores split across 2 workers.
			threads: 2,
			workers: 2,
		})
		expect(c.modelAliases).toEqual([
			"whisper-base.en",
			"onnx-community/whisper-base.en",
		])
	})

	it("requires a key unless explicitly opted out on loopback", () => {
		expect(() => loadConfig({})).toThrow(ConfigError)
		expect(loadConfig({ TRANSCRIBER_ALLOW_NO_AUTH: "1" }).apiKey).toBe("")
		expect(() =>
			loadConfig({
				TRANSCRIBER_ALLOW_NO_AUTH: "1",
				TRANSCRIBER_HOST: "0.0.0.0",
			}),
		).toThrow("loopback")
	})

	it("adds extra aliases such as whisper-1", () => {
		const c = loadConfig({
			TRANSCRIBER_API_KEY: "k",
			TRANSCRIBER_MODEL_ALIASES: "whisper-1, local",
		})
		expect(c.modelAliases).toContain("whisper-1")
		expect(c.modelAliases).toContain("local")
	})

	it("rejects bad values", () => {
		expect(() =>
			loadConfig({ TRANSCRIBER_API_KEY: "k", TRANSCRIBER_DTYPE: "q3" }),
		).toThrow(ConfigError)
		expect(() =>
			loadConfig({ TRANSCRIBER_API_KEY: "k", TRANSCRIBER_PORT: "zero" }),
		).toThrow(ConfigError)
	})

	it("keeps scratch files on disk, not tmpfs, unless told otherwise", () => {
		expect(loadConfig({ TRANSCRIBER_API_KEY: "k" }).tmpDir).toBe("/var/tmp")
		expect(
			loadConfig({
				TRANSCRIBER_API_KEY: "k",
				TRANSCRIBER_TMP_DIR: " /srv/scratch ",
			}).tmpDir,
		).toBe("/srv/scratch")
	})

	it("bounds a job's running time, 30 minutes by default", () => {
		expect(loadConfig({ TRANSCRIBER_API_KEY: "k" }).maxJobSeconds).toBe(1800)
		expect(
			loadConfig({
				TRANSCRIBER_API_KEY: "k",
				TRANSCRIBER_MAX_JOB_SECONDS: "600",
			}).maxJobSeconds,
		).toBe(600)
		for (const bad of ["0", "-5", "soon", "Infinity"]) {
			expect(() =>
				loadConfig({
					TRANSCRIBER_API_KEY: "k",
					TRANSCRIBER_MAX_JOB_SECONDS: bad,
				}),
			).toThrow("TRANSCRIBER_MAX_JOB_SECONDS")
		}
	})
})

describe("worker pool sizing", () => {
	const base = { TRANSCRIBER_API_KEY: "k" }

	it("is a single worker on a one-core host, as the serial queue was", () => {
		const c = loadConfig(base, 1)
		expect(c.workers).toBe(1)
		expect(c.threads).toBe(1)
	})

	it("gives each worker two cores, so a job still scales a little", () => {
		expect(loadConfig(base, 8)).toMatchObject({ workers: 4, threads: 2 })
	})

	it("caps the default, because each worker is another copy of the weights", () => {
		// 32 cores would otherwise mean ~23 GB resident for base.en.
		expect(loadConfig(base, 32).workers).toBe(4)
	})

	it("takes an explicit worker count over the default", () => {
		const c = loadConfig({ ...base, TRANSCRIBER_WORKERS: "6" }, 12)
		expect(c.workers).toBe(6)
		expect(c.threads).toBe(2)
	})

	it("lets threads be set independently of the split", () => {
		const c = loadConfig(
			{ ...base, TRANSCRIBER_WORKERS: "2", TRANSCRIBER_THREADS: "3" },
			4,
		)
		expect(c).toMatchObject({ workers: 2, threads: 3 })
	})

	it("rejects a non-positive worker count rather than silently flooring it", () => {
		expect(() => loadConfig({ ...base, TRANSCRIBER_WORKERS: "0" }, 4)).toThrow(
			ConfigError,
		)
	})
})
