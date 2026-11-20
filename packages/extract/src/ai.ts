// Vision captioning and audio transcription against an OpenAI-compatible
// endpoint (the LiteLLM proxy by default). "Local" here means self-hosted
// infrastructure, not this process: captioning and transcription need a GPU
// box, and the sqrrl host has neither the cores nor the models for it.

export type FetchFn = typeof globalThis.fetch

/** What an image is, which decides how it is read. */
export type ImagePurpose = "picture" | "document-page"

export interface AiClient {
	/** Describes an image and transcribes any text in it. A scanned document
	 *  page is transcribed instead of described. With `verificationCode`, the
	 *  image carries that code in a stamp (see stampImage) and the answer is
	 *  rejected unless the model reads it back. */
	caption(
		image: Uint8Array,
		mimeType: string,
		name: string,
		purpose?: ImagePurpose,
		verificationCode?: string,
	): Promise<string>
	/** Speech to text for audio, or for video containers carrying audio. */
	transcribe(media: Uint8Array, mimeType: string, name: string): Promise<string>
}

export class AiUnavailableError extends Error {}

/** The model answered, but not about the image it was sent: the stamp's
 *  code did not come back. Evidence of cross-request contamination on the
 *  serving node. */
export class ResponseMismatchError extends Error {}

/** Prepended to the prompt of a stamped image. */
export const VERIFICATION_INSTRUCTION = [
	"The black band along the bottom edge is a verification stamp added by the indexer; it is not part of the content.",
	"Begin your answer with exactly one line: 'Verification: ' followed by the six characters printed after VERIFY, without spaces.",
	"Then continue as instructed below, ignoring the band entirely.",
].join("\n")

/** Checks a stamped answer and returns it without the verification line.
 *  Returns null when the code is missing or wrong. */
export function checkVerification(answer: string, code: string): string | null {
	const lines = answer.split("\n")
	const at = lines.findIndex((l) => /^\W*verification\W*:/i.test(l.trim()))
	if (at === -1 || at > 2) return null
	const read = lines[at]
		.replace(/^\W*verification\W*:/i, "")
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
	if (read !== code.toUpperCase()) return null
	// The line was asked for first, so anything above it is preamble
	// ("Based on the image provided, here is…").
	return lines
		.slice(at + 1)
		.filter((l) => !/VERIFY(\s*[A-Z0-9]){6}\b/.test(l))
		.join("\n")
		.trim()
}

/** One prompt for both jobs a picture can hold: what it shows, and what it
 *  says. Screenshots, whiteboards and scanned pages are mostly the latter, and
 *  search needs the words verbatim, not paraphrased. */
export const CAPTION_PROMPT = [
	"You are indexing a file for a company knowledge base.",
	"1. Describe what the image shows in 2-4 sentences: subject, setting, and any chart, diagram or UI and what it conveys.",
	"2. Then, under the heading 'Text in image:', transcribe all legible text verbatim, preserving line breaks. Write 'none' if there is no text.",
	"Do not speculate about anything you cannot see.",
].join("\n")

/** What a vision model answers for a scanned page with nothing on it. */
export const NO_TEXT_MARKER = "[no text]"

/** For scanned pages: transcription only.
 *
 *  Measured against qwen3.5-122b on 2026-09-16 with a text-only scanned
 *  page. A prompt that asked to describe the page, or to list figures,
 *  produced an invented "Figure:" line in 3-4 of 4 rounds. Each time it was
 *  an image from an earlier, unrelated request (a red square, an orange
 *  triangle), and it persisted with prompt caching disabled. Asking only
 *  for the text gave an exact transcription in 5 of 5 rounds. A chart on a
 *  scanned page therefore gets no description; standalone images still do,
 *  via CAPTION_PROMPT. */
export const DOCUMENT_PAGE_PROMPT = [
	"This is one scanned page of a document, being indexed for search.",
	"Transcribe all legible text verbatim, in reading order, preserving headings, lists and line breaks. Render tables as tab-separated rows.",
	`Output only the transcription. Write [illegible] where text cannot be read and ${NO_TEXT_MARKER} if the page has none.`,
].join("\n")

export interface HttpAiClientOptions {
	baseUrl: string
	apiKey: string
	visionModel: string
	transcriptionModel: string
	/** Separate endpoint for transcription; defaults to baseUrl / apiKey. */
	transcriptionBaseUrl?: string
	transcriptionApiKey?: string
	timeoutMs: number
	visionExtraBody?: Record<string, unknown>
	/** Extra attempts after a verification mismatch. */
	verifyRetries?: number
	fetchFn?: FetchFn
}

export class HttpAiClient implements AiClient {
	private readonly fetchFn: FetchFn

	constructor(private readonly opts: HttpAiClientOptions) {
		this.fetchFn = opts.fetchFn ?? globalThis.fetch
	}

	private async call(
		path: string,
		init: RequestInit,
		target: { baseUrl: string; apiKey: string } = {
			baseUrl: this.opts.baseUrl,
			apiKey: this.opts.apiKey,
		},
	): Promise<Response> {
		if (!target.baseUrl) {
			throw new AiUnavailableError(
				"no AI endpoint configured (NEXTCLOUD_AI_BASE_URL / SQRRL_LLM_BASE_URL)",
			)
		}
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs)
		try {
			const res = await this.fetchFn(`${target.baseUrl}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${target.apiKey}`,
					...(init.headers as Record<string, string>),
				},
				signal: controller.signal,
			})
			if (!res.ok) {
				const detail = (await res.text().catch(() => "")).slice(0, 300)
				throw new Error(`AI endpoint ${path} returned ${res.status}: ${detail}`)
			}
			return res
		} catch (err) {
			if (controller.signal.aborted) {
				throw new Error(
					`AI endpoint ${path} timed out after ${this.opts.timeoutMs}ms`,
				)
			}
			throw err
		} finally {
			clearTimeout(timer)
		}
	}

	async caption(
		image: Uint8Array,
		mimeType: string,
		_name: string,
		purpose: ImagePurpose = "picture",
		verificationCode?: string,
	): Promise<string> {
		if (!this.opts.visionModel) {
			throw new AiUnavailableError(
				"no vision model configured (NEXTCLOUD_VISION_MODEL)",
			)
		}
		const prompt =
			purpose === "document-page" ? DOCUMENT_PAGE_PROMPT : CAPTION_PROMPT
		// No per-image tag here: an earlier version led each prompt with a hash
		// of the image to defeat prompt-cache reuse, but the servers report
		// cache_n=0 on every vision request (nothing is reused from the prompt
		// cache), contamination was seen with the tag in place, and the model
		// copied the hex into the verification line instead of reading the stamp.
		const text = [
			...(verificationCode ? [VERIFICATION_INSTRUCTION] : []),
			prompt,
		].join("\n")
		const attempts = verificationCode ? 1 + (this.opts.verifyRetries ?? 2) : 1
		const mismatches: string[] = []
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const { answer, backend } = await this.chatWithImage(
				image,
				mimeType,
				text,
			)
			if (!verificationCode) return answer
			const verified = checkVerification(answer, verificationCode)
			if (verified !== null) {
				if (!verified)
					throw new Error("vision model returned only the verification line")
				return verified
			}
			const said =
				/verification\W*:\s*(\S[^\n]{0,20})/i.exec(answer)?.[1] ?? "no code"
			mismatches.push(`${backend}: read "${said.trim()}"`)
		}
		throw new ResponseMismatchError(
			`vision answers did not match the image sent (expected ${verificationCode}; ${mismatches.join("; ")})`,
		)
	}

	private async chatWithImage(
		image: Uint8Array,
		mimeType: string,
		text: string,
	): Promise<{ answer: string; backend: string }> {
		const dataUrl = `data:${mimeType};base64,${Buffer.from(image).toString("base64")}`
		const res = await this.call("/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.opts.visionModel,
				max_tokens: 2048,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text },
							{ type: "image_url", image_url: { url: dataUrl } },
						],
					},
				],
				...(this.opts.visionExtraBody ?? {}),
			}),
		})
		// LiteLLM names the deployment that answered; keep it for diagnosis.
		const backend =
			res.headers.get("x-litellm-model-id") ??
			res.headers.get("x-litellm-model-api-base") ??
			"unknown backend"
		const payload = (await res.json()) as {
			choices?: Array<{ message?: { content?: string | null } }>
		}
		const answer = payload.choices?.[0]?.message?.content?.trim() ?? ""
		if (!answer) throw new Error("vision model returned an empty caption")
		return { answer, backend }
	}

	async transcribe(
		media: Uint8Array,
		mimeType: string,
		name: string,
	): Promise<string> {
		if (!this.opts.transcriptionModel) {
			throw new AiUnavailableError(
				"no transcription model configured (NEXTCLOUD_TRANSCRIPTION_MODEL)",
			)
		}
		const form = new FormData()
		form.set("model", this.opts.transcriptionModel)
		form.set("response_format", "json")
		form.set("file", new Blob([media], { type: mimeType }), name)
		const res = await this.call(
			"/audio/transcriptions",
			{ method: "POST", body: form },
			{
				baseUrl: this.opts.transcriptionBaseUrl || this.opts.baseUrl,
				apiKey: this.opts.transcriptionApiKey || this.opts.apiKey,
			},
		)
		const raw = await res.text()
		let text = raw
		try {
			const parsed = JSON.parse(raw) as { text?: string }
			if (typeof parsed.text === "string") text = parsed.text
		} catch {
			// response_format=text servers answer with the bare transcript.
		}
		text = text.trim()
		if (!text) throw new Error("transcription returned no text")
		return text
	}
}
