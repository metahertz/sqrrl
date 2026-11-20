import { describe, expect, it, vi } from "vitest"
import {
	app,
	fingerprint,
	fingerprintEngine,
	heldEngine,
	KEY,
	upload,
	until,
} from "./app.testkit.js"
import { type Decoder, DecodeError } from "./decode.js"
import type { Engine, Transcript } from "./engine.js"
import { JobQueue } from "./queue.js"
import { formatTranscript } from "./app.js"

describe("auth", () => {
	it("rejects a wrong key", async () => {
		const res = await app().fetch(upload(new Uint8Array([1]), {}, "nope"))
		expect(res.status).toBe(401)
	})

	it("leaves /health open", async () => {
		const res = await app().fetch(new Request("http://t/health"))
		expect(await res.json()).toMatchObject({ ok: true, busy: false, queued: 0 })
	})

	it("lists the served model", async () => {
		const res = await app().fetch(
			new Request("http://t/v1/models", {
				headers: { Authorization: `Bearer ${KEY}` },
			}),
		)
		expect(await res.json()).toMatchObject({
			data: [{ id: "whisper-base.en" }],
		})
	})
})

describe("POST /v1/audio/transcriptions", () => {
	it("returns OpenAI-shaped JSON by default", async () => {
		const res = await app().fetch(
			upload(new Uint8Array([1, 2, 3]), { model: "whisper-1" }),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			text: `heard ${fingerprint(new Uint8Array([1, 2, 3]))}`,
		})
	})

	it("returns plain text", async () => {
		const res = await app().fetch(
			upload(new Uint8Array([1]), { response_format: "text" }),
		)
		expect(res.headers.get("content-type")).toContain("text/plain")
		expect(await res.text()).toMatch(/^heard [0-9a-f]{12}$/)
	})

	it("refuses a model it does not serve instead of substituting one", async () => {
		const res = await app().fetch(
			upload(new Uint8Array([1]), { model: "whisper-large-v3" }),
		)
		expect(res.status).toBe(404)
		expect(await res.json()).toMatchObject({
			error: { code: "model_not_found" },
		})
	})

	it("requires a file", async () => {
		const form = new FormData()
		form.set("model", "whisper-1")
		const res = await app().fetch(
			new Request("http://t/v1/audio/transcriptions", {
				method: "POST",
				headers: { Authorization: `Bearer ${KEY}` },
				body: form,
			}),
		)
		expect(res.status).toBe(400)
	})

	it("refuses an oversized upload", async () => {
		const res = await app().fetch(upload(new Uint8Array(2048)))
		expect(res.status).toBe(413)
	})

	it("rejects an unknown response format", async () => {
		const res = await app().fetch(
			upload(new Uint8Array([1]), { response_format: "docx" }),
		)
		expect(res.status).toBe(400)
	})

	it("reports undecodable audio as a client error", async () => {
		const decode: Decoder = async () => {
			throw new DecodeError("not decodable audio")
		}
		const res = await app({ decode }).fetch(upload(new Uint8Array([1])))
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: { code: "invalid_audio" } })
	})

	it("reports an engine failure as a server error", async () => {
		const engine: Engine = {
			modelId: "m",
			transcribe: vi.fn(async () => {
				throw new Error("onnx exploded")
			}),
		}
		const res = await app({ engine }).fetch(upload(new Uint8Array([1])))
		expect(res.status).toBe(500)
	})

	it("sheds load with 503 and Retry-After when the queue is full", async () => {
		const { engine, started } = heldEngine()
		const queue = new JobQueue(1)
		const server = app({ engine, queue })
		const first = server.fetch(upload(new Uint8Array([1])))
		const second = server.fetch(upload(new Uint8Array([2])))
		// One job running and one waiting: no clock involved.
		await until(() => started.length === 1 && queue.depth === 1)
		expect([queue.busy, queue.depth]).toEqual([true, 1])
		const third = await server.fetch(upload(new Uint8Array([3])))
		expect(third.status).toBe(503)
		expect(third.headers.get("retry-after")).toBe("60")
		started[0].release()
		await until(() => started.length === 2)
		started[1].release()
		expect((await first).status).toBe(200)
		expect((await second).status).toBe(200)
	})
})

describe("cross-request isolation", () => {
	it("answers every concurrent request with its own audio's transcript", async () => {
		const server = app({
			engine: fingerprintEngine(5),
			queue: new JobQueue(50),
		})
		const uploads = Array.from({ length: 12 }, (_, i) =>
			Uint8Array.from({ length: 64 }, (_, j) => (i * 31 + j) % 256),
		)
		const responses = await Promise.all(
			uploads.map((u) => server.fetch(upload(u))),
		)
		const texts = await Promise.all(
			responses.map((r) => r.json() as Promise<{ text: string }>),
		)
		texts.forEach((t, i) => {
			expect(t.text).toBe(`heard ${fingerprint(uploads[i])}`)
		})
	})
})

describe("formatTranscript", () => {
	const t: Transcript = {
		text: "Hello there. General Kenobi.",
		duration: 3.5,
		segments: [
			{ start: 0, end: 1.25, text: "Hello there." },
			{ start: 1.25, end: 3.5, text: "General Kenobi." },
		],
	}

	it("verbose_json carries duration and numbered segments", () => {
		expect(
			JSON.parse(formatTranscript(t, "verbose_json", "en").body),
		).toMatchObject({
			duration: 3.5,
			language: "en",
			segments: [
				{ id: 0, start: 0 },
				{ id: 1, text: "General Kenobi." },
			],
		})
	})

	it("srt uses comma milliseconds", () => {
		expect(formatTranscript(t, "srt", "en").body).toBe(
			"1\n00:00:00,000 --> 00:00:01,250\nHello there.\n\n2\n00:00:01,250 --> 00:00:03,500\nGeneral Kenobi.\n",
		)
	})

	it("vtt has a header and dot milliseconds", () => {
		expect(
			formatTranscript(t, "vtt", "en").body.startsWith(
				"WEBVTT\n\n00:00:00.000 --> 00:00:01.250",
			),
		).toBe(true)
	})
})
