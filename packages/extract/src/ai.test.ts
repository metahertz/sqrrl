import { describe, expect, it, vi } from "vitest"
import {
	AiUnavailableError,
	CAPTION_PROMPT,
	DOCUMENT_PAGE_PROMPT,
	checkVerification,
	HttpAiClient,
	type HttpAiClientOptions,
	ResponseMismatchError,
	VERIFICATION_INSTRUCTION,
} from "./ai.js"

function client(
	over: Partial<HttpAiClientOptions> = {},
	fetchFn?: typeof fetch,
) {
	return new HttpAiClient({
		baseUrl: "http://ai/v1",
		apiKey: "sk-test",
		visionModel: "vlm",
		transcriptionModel: "asr",
		timeoutMs: 5_000,
		...over,
		...(fetchFn ? { fetchFn } : {}),
	})
}

const chat = (content: string) =>
	vi.fn<typeof fetch>(async () =>
		Response.json({ choices: [{ message: { content } }] }),
	)

describe("HttpAiClient.caption", () => {
	it("sends the image as a data URL with the picture prompt", async () => {
		const f = chat(" A cat. ")
		const text = await client(
			{ visionExtraBody: { chat_template_kwargs: { enable_thinking: false } } },
			f,
		).caption(new Uint8Array([1, 2, 3]), "image/png", "cat.png")
		expect(text).toBe("A cat.")
		const [url, init] = f.mock.calls[0]
		expect(url).toBe("http://ai/v1/chat/completions")
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer sk-test",
		)
		const body = JSON.parse(String(init?.body))
		expect(body.model).toBe("vlm")
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
		expect(body.messages[0].content[0].text).toBe(CAPTION_PROMPT)
		expect(body.messages[0].content[1].image_url.url).toBe(
			"data:image/png;base64,AQID",
		)
	})

	it("transcribes rather than describes a document page", async () => {
		const f = chat("Page text")
		await client({}, f).caption(
			new Uint8Array([1]),
			"image/png",
			"p1",
			"document-page",
		)
		const body = JSON.parse(String(f.mock.calls[0][1]?.body))
		expect(body.messages[0].content[0].text).toBe(DOCUMENT_PAGE_PROMPT)
	})

	it("is unavailable without a model or an endpoint", async () => {
		await expect(
			client({ visionModel: "" }).caption(new Uint8Array(), "image/png", "x"),
		).rejects.toBeInstanceOf(AiUnavailableError)
		await expect(
			client({ baseUrl: "" }).caption(new Uint8Array(), "image/png", "x"),
		).rejects.toBeInstanceOf(AiUnavailableError)
	})

	it("reports the endpoint's error body", async () => {
		const f = vi.fn<typeof fetch>(
			async () => new Response("image input is not supported", { status: 500 }),
		)
		await expect(
			client({}, f).caption(new Uint8Array(), "image/png", "x"),
		).rejects.toThrow("returned 500: image input is not supported")
	})

	it("treats an empty caption as a failure", async () => {
		await expect(
			client({}, chat("  ")).caption(new Uint8Array(), "image/png", "x"),
		).rejects.toThrow("empty caption")
	})

	it("times out", async () => {
		const hang = vi.fn<typeof fetch>(
			(_u, init) =>
				new Promise((_r, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					),
				),
		)
		await expect(
			client({ timeoutMs: 20 }, hang).caption(
				new Uint8Array(),
				"image/png",
				"x",
			),
		).rejects.toThrow("timed out after 20ms")
	})
})

describe("HttpAiClient.transcribe", () => {
	it("posts multipart audio and reads a JSON transcript", async () => {
		const f = vi.fn<typeof fetch>(async () =>
			Response.json({ text: " hello " }),
		)
		const text = await client({}, f).transcribe(
			new Uint8Array([9]),
			"audio/mpeg",
			"a.mp3",
		)
		expect(text).toBe("hello")
		const [url, init] = f.mock.calls[0]
		expect(url).toBe("http://ai/v1/audio/transcriptions")
		const form = init?.body as FormData
		expect(form.get("model")).toBe("asr")
		expect((form.get("file") as File).name).toBe("a.mp3")
		expect((form.get("file") as File).type).toBe("audio/mpeg")
	})

	it("can send transcription to its own endpoint and key", async () => {
		const f = vi.fn<typeof fetch>(async () => Response.json({ text: "local" }))
		await client(
			{
				transcriptionBaseUrl: "http://127.0.0.1:3960/v1",
				transcriptionApiKey: "tx-key",
			},
			f,
		).transcribe(new Uint8Array([9]), "audio/mpeg", "a.mp3")
		const [url, init] = f.mock.calls[0]
		expect(url).toBe("http://127.0.0.1:3960/v1/audio/transcriptions")
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer tx-key",
		)
	})

	it("accepts a plain-text transcript", async () => {
		const f = vi.fn<typeof fetch>(async () => new Response("plain words"))
		expect(
			await client({}, f).transcribe(
				new Uint8Array([9]),
				"audio/mpeg",
				"a.mp3",
			),
		).toBe("plain words")
	})

	it("is unavailable without a transcription model", async () => {
		await expect(
			client({ transcriptionModel: "" }).transcribe(
				new Uint8Array(),
				"audio/mpeg",
				"a",
			),
		).rejects.toBeInstanceOf(AiUnavailableError)
	})
})

describe("checkVerification", () => {
	it("accepts the code with spacing or case differences and strips the line", () => {
		expect(
			checkVerification(
				"Verification: a b c d e f\nA town by a river.",
				"ABCDEF",
			),
		).toBe("A town by a river.")
		expect(checkVerification("**Verification:** ABCDEF\nText.", "ABCDEF")).toBe(
			"Text.",
		)
	})

	it("drops any preamble above the verification line", () => {
		expect(
			checkVerification(
				"Based on the image provided, here is the transcription:\nVerification: ABCDEF\nINVOICE 4471",
				"ABCDEF",
			),
		).toBe("INVOICE 4471")
	})

	it("drops a transcribed copy of the stamp", () => {
		expect(
			checkVerification(
				"Verification: ABCDEF\nPage text\nVERIFY A B C D E F",
				"ABCDEF",
			),
		).toBe("Page text")
	})

	it("rejects a wrong or missing code", () => {
		expect(checkVerification("Verification: ABCDEX\ntext", "ABCDEF")).toBeNull()
		expect(checkVerification("A magenta circle.", "ABCDEF")).toBeNull()
	})

	it("only trusts a verification line at the top", () => {
		expect(
			checkVerification("a\nb\nc\nVerification: ABCDEF", "ABCDEF"),
		).toBeNull()
	})
})

describe("HttpAiClient.caption with verification", () => {
	const answer = (content: string, backend: string) =>
		Response.json(
			{ choices: [{ message: { content } }] },
			{ headers: { "x-litellm-model-id": backend } },
		)

	it("asks for the code and returns the verified answer", async () => {
		const f = vi.fn<typeof fetch>(async () =>
			answer("Verification: HJKL34\nA river town.", "inference1"),
		)
		const text = await client({}, f).caption(
			new Uint8Array([1]),
			"image/png",
			"x",
			"picture",
			"HJKL34",
		)
		expect(text).toBe("A river town.")
		const prompt = JSON.parse(String(f.mock.calls[0][1]?.body)).messages[0]
			.content[0].text
		expect(prompt.startsWith(VERIFICATION_INSTRUCTION)).toBe(true)
		expect(prompt).not.toMatch(/[0-9a-f]{16}/)
	})

	it("retries after a mismatch and accepts a later correct answer", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(answer("A magenta circle.", "inference2"))
			.mockResolvedValueOnce(
				answer("Verification: HJKL34\nA river town.", "inference1"),
			)
		expect(
			await client({}, f).caption(
				new Uint8Array([1]),
				"image/png",
				"x",
				"picture",
				"HJKL34",
			),
		).toBe("A river town.")
		expect(f).toHaveBeenCalledTimes(2)
	})

	it("gives up after its retries, naming the backends", async () => {
		const f = vi.fn<typeof fetch>(async () =>
			answer("Verification: ZZZZZZ\nA magenta circle.", "inference2"),
		)
		const err = await client({ verifyRetries: 1 }, f)
			.caption(new Uint8Array([1]), "image/png", "x", "picture", "HJKL34")
			.catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ResponseMismatchError)
		expect(String((err as Error).message)).toContain(
			'inference2: read "ZZZZZZ"',
		)
		expect(f).toHaveBeenCalledTimes(2)
	})

	it("does not ask for a code when none is given", async () => {
		const f = chat("A river town.")
		await client({}, f).caption(new Uint8Array([1]), "image/png", "x")
		const prompt = JSON.parse(String(f.mock.calls[0][1]?.body)).messages[0]
			.content[0].text
		expect(prompt).not.toContain("Verification")
	})
})
