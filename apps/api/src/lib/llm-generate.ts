// LlmGenerateFn adapter for wiki maintenance.
//
// wiki-engine's runGitDiffMaintenance takes an LlmGenerateFn but the engine
// ships no implementation — upstream leaves the caller to supply one. This
// builds it from the SQRRL_ENRICHMENT_* environment, which .env.example
// documents but which nothing else in the API consumes.
//
// Local addition, not upstream.

import type { LlmGenerateFn } from "@sqrrl/wiki-engine"
import {
	renderTopicVocabulary,
	TASK_EXTRACTION_PROMPT,
	type TaskExtractFn,
	type TaskExtractionResult,
} from "@sqrrl/source-layer"

export class LlmNotConfiguredError extends Error {}
export class LlmCallError extends Error {}

type AuthStyle = "authorization-bearer" | "api-key" | "x-api-key"

/** Reasoning models spend tokens on hidden reasoning before emitting content,
 *  so a small budget yields an empty completion with finish_reason "length"
 *  rather than an error. Default high enough to survive that. */
const DEFAULT_MAX_TOKENS = 4096

/** Caps LLM requests in flight across the whole process.
 *
 *  Ingestion makes two LLM calls per note and a batch fans those out, so
 *  without a cap a large batch opens one connection per note at once. This
 *  lets the gateway decide how much it can take: raise
 *  SQRRL_ENRICHMENT_CONCURRENCY to match what the model server will serve
 *  simultaneously and the surplus queues here instead of at the socket.
 *
 *  Default 1 preserves the strictly-serial behaviour, so raising it is an
 *  explicit choice made against a backend known to handle it. */
class LlmGate {
	private active = 0
	private readonly waiting: Array<() => void> = []

	constructor(readonly limit: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active < this.limit) {
			this.active++
		} else {
			// The slot is handed over by release() rather than re-counted here.
			// Decrementing and then waking a waiter would let a caller arriving
			// in between take the free slot and push us over the limit.
			await new Promise<void>((resolve) => {
				this.waiting.push(resolve)
			})
		}
		try {
			return await fn()
		} finally {
			const next = this.waiting.shift()
			if (next) next()
			else this.active--
		}
	}
}

/** One gate per process, so every adapter shares the same budget: separate
 *  gates would each allow `limit` calls and multiply the real concurrency. */
let sharedGate: LlmGate | undefined

function resolveGate(env: NodeJS.ProcessEnv): LlmGate {
	const raw = env.SQRRL_ENRICHMENT_CONCURRENCY?.trim()
	const parsed = raw ? Number(raw) : 1
	if (raw && (!Number.isFinite(parsed) || parsed < 1)) {
		throw new LlmNotConfiguredError(
			`SQRRL_ENRICHMENT_CONCURRENCY must be an integer >= 1, got "${raw}"`,
		)
	}
	const limit = Math.max(1, Math.floor(parsed))
	if (!sharedGate || sharedGate.limit !== limit) sharedGate = new LlmGate(limit)
	return sharedGate
}

function authHeaders(style: AuthStyle, apiKey: string): Record<string, string> {
	switch (style) {
		case "api-key":
			return { "api-key": apiKey }
		case "x-api-key":
			return { "x-api-key": apiKey }
		default:
			return { authorization: `Bearer ${apiKey}` }
	}
}

/** Pulls the first balanced JSON object out of a completion. Models often
 *  wrap JSON in prose or fenced code blocks even when asked not to. */
function extractJsonObject(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidate = fenced ? fenced[1] : text
	const start = candidate.indexOf("{")
	if (start === -1) throw new LlmCallError("no JSON object in LLM response")
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i]
		if (escaped) {
			escaped = false
			continue
		}
		if (ch === "\\") {
			escaped = true
			continue
		}
		if (ch === '"') inString = !inString
		if (inString) continue
		if (ch === "{") depth++
		else if (ch === "}") {
			depth--
			if (depth === 0) {
				return JSON.parse(candidate.slice(start, i + 1))
			}
		}
	}
	throw new LlmCallError("unterminated JSON object in LLM response")
}

const SYSTEM_PROMPT = [
	"You maintain a knowledge wiki. Given a changed source file and the",
	"current wiki page (if any), regenerate the page.",
	"Respond with ONLY a JSON object, no prose and no code fences:",
	'{"title":string,"summary":string,"body":string,',
	'"claims":[{"text":string,"confidence":number}]}',
	"Each claim must be one self-contained factual statement.",
	"confidence is 0..1. Return [] for claims if none are warranted.",
].join(" ")

export function isLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(
		env.SQRRL_ENRICHMENT_API_KEY?.trim() &&
			env.SQRRL_ENRICHMENT_BASE_URL?.trim() &&
			env.SQRRL_ENRICHMENT_MODEL?.trim(),
	)
}

/** Builds an LlmGenerateFn from SQRRL_ENRICHMENT_*. Throws
 *  LlmNotConfiguredError when credentials are absent, so callers can return a
 *  clear 400 instead of failing deep inside the maintenance loop. */
/** The shared chat-completion call behind both adapters. */
function createChatCompletion(
	env: NodeJS.ProcessEnv,
	fetchFn: typeof globalThis.fetch,
): (system: string, user: string) => Promise<string> {
	const baseUrl = env.SQRRL_ENRICHMENT_BASE_URL?.trim()
	const apiKey = env.SQRRL_ENRICHMENT_API_KEY?.trim()
	const model = env.SQRRL_ENRICHMENT_MODEL?.trim()
	if (!baseUrl || !apiKey || !model) {
		throw new LlmNotConfiguredError(
			"this operation needs an LLM: set SQRRL_ENRICHMENT_BASE_URL, SQRRL_ENRICHMENT_API_KEY and SQRRL_ENRICHMENT_MODEL",
		)
	}
	const authStyle = (env.SQRRL_ENRICHMENT_AUTH_STYLE?.trim() ??
		"authorization-bearer") as AuthStyle
	const tokenParam =
		env.SQRRL_ENRICHMENT_TOKEN_PARAM?.trim() === "max_completion_tokens"
			? "max_completion_tokens"
			: "max_tokens"
	const maxTokens = Number(
		env.SQRRL_ENRICHMENT_MAX_TOKENS ?? DEFAULT_MAX_TOKENS,
	)
	const timeoutMs = Number(env.SQRRL_ENRICHMENT_TIMEOUT_MS ?? 60_000)
	let extraBody: Record<string, unknown> = {}
	const rawExtra = env.SQRRL_ENRICHMENT_EXTRA_BODY?.trim()
	if (rawExtra) {
		try {
			const parsed: unknown = JSON.parse(rawExtra)
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("must be a JSON object")
			}
			extraBody = parsed as Record<string, unknown>
		} catch (err) {
			throw new LlmNotConfiguredError(
				`SQRRL_ENRICHMENT_EXTRA_BODY must be a JSON object: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	const gate = resolveGate(env)

	return async (system, user) =>
		gate.run(async () => {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), timeoutMs)
			let res: Response
			try {
				res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...authHeaders(authStyle, apiKey),
					},
					body: JSON.stringify({
						model,
						messages: [
							{ role: "system", content: system },
							{ role: "user", content: user },
						],
						[tokenParam]: maxTokens,
						...extraBody,
					}),
					signal: controller.signal,
				})
			} catch (err) {
				throw new LlmCallError(
					`LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			} finally {
				clearTimeout(timer)
			}
			if (!res.ok) {
				const detail = await res.text().catch(() => "")
				throw new LlmCallError(
					`LLM returned ${res.status}: ${detail.slice(0, 300)}`,
				)
			}
			const payload = (await res.json()) as {
				choices?: Array<{
					finish_reason?: string
					message?: { content?: string | null }
				}>
			}
			const choice = payload.choices?.[0]
			const content = choice?.message?.content ?? ""
			if (!content.trim()) {
				throw new LlmCallError(
					`LLM returned empty content (finish_reason=${choice?.finish_reason ?? "unknown"}); raise SQRRL_ENRICHMENT_MAX_TOKENS if this is a reasoning model`,
				)
			}
			return content
		})
}

export function createLlmGenerate(
	env: NodeJS.ProcessEnv = process.env,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): LlmGenerateFn {
	const complete = createChatCompletion(env, fetchFn)
	return async (input) => {
		const current = input.currentPage
		const content = await complete(
			SYSTEM_PROMPT,
			[
				`Source file: ${input.sourceFile}`,
				"",
				"Changed content:",
				input.changedSnippet,
				"",
				current
					? `Current page:\n${JSON.stringify(current, null, 2)}`
					: "No existing page — create one.",
			].join("\n"),
		)
		const parsed = extractJsonObject(content) as {
			title?: unknown
			summary?: unknown
			body?: unknown
			claims?: unknown
		}
		const claims = Array.isArray(parsed.claims)
			? parsed.claims
					.filter(
						(x): x is { text: string; confidence?: number } =>
							Boolean(x) &&
							typeof x === "object" &&
							typeof (x as { text?: unknown }).text === "string" &&
							(x as { text: string }).text.trim().length > 0,
					)
					.map((x) => ({
						text: x.text,
						...(typeof x.confidence === "number"
							? { confidence: x.confidence }
							: {}),
					}))
			: []
		return {
			...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
			summary: typeof parsed.summary === "string" ? parsed.summary : "",
			body: typeof parsed.body === "string" ? parsed.body : "",
			claims,
		}
	}
}

/** Builds a TaskExtractFn from the same SQRRL_ENRICHMENT_* configuration.
 *
 *  The prompt lives in @sqrrl/wiki-engine, not here, so every ingestion path
 *  extracts tasks identically rather than each caller inventing its own. */
export function createTaskExtractor(
	env: NodeJS.ProcessEnv = process.env,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): TaskExtractFn {
	const complete = createChatCompletion(env, fetchFn)
	return async (input) => {
		const content = await complete(
			TASK_EXTRACTION_PROMPT,
			[
				renderTopicVocabulary(input.existingTopics ?? []),
				"",
				`Note date: ${input.noteDate}`,
				`Note path: ${input.sourcePath}`,
				"",
				"---",
				input.text,
				"---",
			].join("\n"),
		)
		const parsed = extractJsonObject(content) as {
			tasks?: unknown
			topics?: unknown
		}
		const tasks = Array.isArray(parsed.tasks)
			? parsed.tasks
					.filter(
						(t): t is Record<string, unknown> =>
							Boolean(t) && typeof t === "object" && !Array.isArray(t),
					)
					.filter((t) => typeof t.task === "string" && t.task.trim().length > 0)
					.map((t) => ({
						task: String(t.task).trim(),
						owner:
							typeof t.owner === "string" && t.owner.trim()
								? String(t.owner).trim()
								: undefined,
						due:
							typeof t.due === "string" && t.due.trim().toLowerCase() !== "null"
								? String(t.due).trim()
								: null,
						sourceQuote:
							typeof t.source_quote === "string" ? t.source_quote : undefined,
					}))
			: []
		const topics = Array.isArray(parsed.topics)
			? parsed.topics.filter((t): t is string => typeof t === "string")
			: []
		return { tasks, topics } satisfies TaskExtractionResult
	}
}

/** Someone is waiting on an answer, unlike ingestion, so it gets its own
 *  shorter timeout (SQRRL_ANSWER_TIMEOUT_MS) instead of ingestion's. */
const DEFAULT_ANSWER_TIMEOUT_MS = 120_000

/** The same question should get the same answer: at the server's default
 *  temperature a model asked twice can find the answer once and miss it
 *  once (measured). Adds temperature 0 unless the extra body sets one; a
 *  malformed extra body is passed through for createChatCompletion to
 *  reject with its usual message. */
function withDefaultTemperature(raw: string | undefined): string {
	const text = raw?.trim()
	if (!text) return JSON.stringify({ temperature: 0 })
	try {
		const parsed: unknown = JSON.parse(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return text
		return JSON.stringify({ temperature: 0, ...parsed })
	} catch {
		return text
	}
}

/** Builds the completion behind POST /v1/wiki/answer from the same
 *  SQRRL_ENRICHMENT_* configuration. Returns the parsed JSON reply, or the
 *  bare text when the model sent no JSON; lib/answer.ts reads either. */
export function createAnswerCompletion(
	env: NodeJS.ProcessEnv = process.env,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
): (system: string, user: string) => Promise<unknown> {
	const complete = createChatCompletion(
		{
			...env,
			SQRRL_ENRICHMENT_TIMEOUT_MS:
				env.SQRRL_ANSWER_TIMEOUT_MS?.trim() ||
				String(DEFAULT_ANSWER_TIMEOUT_MS),
			SQRRL_ENRICHMENT_EXTRA_BODY: withDefaultTemperature(
				env.SQRRL_ENRICHMENT_EXTRA_BODY,
			),
		},
		fetchFn,
	)
	return async (system, user) => {
		const content = await complete(system, user)
		try {
			return extractJsonObject(content)
		} catch (err) {
			if (err instanceof LlmCallError || err instanceof SyntaxError)
				return content
			throw err
		}
	}
}

/** The task-review judge: the same temperature-0, JSON-reading completion
 *  as answers, since both must say the same thing twice and cite their
 *  evidence. */
export const createTaskJudge = createAnswerCompletion
