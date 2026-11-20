// @sqrrl/wiki-engine — app-side cross-encoder reranking via Voyage.
//
// Atlas 8.0.30 has no $rerank stage (8.3+), so reranking is an HTTP call.
// Ported from memongo's crossEncoderRerank
// (memongo/packages/memory-engine/src/mongodb-reranker.ts), keeping its
// endpoint routing and dropping its telemetry and memory-specific boosts.
// Returns a WikiRerankFn, which both wiki search and raw search accept; the
// callers own the fallback (an error here keeps their fusion order).

import type { WikiRerankFn } from "./wiki-search.js"

// Same routing as the Voyage SDK: Atlas Model API keys (al-...) go through
// MongoDB's proxy, direct Voyage keys (pa-...) to Voyage.
const RERANK_URL_ATLAS = "https://ai.mongodb.com/v1/rerank"
const RERANK_URL_DIRECT = "https://api.voyageai.com/v1/rerank"

export interface VoyageRerankOptions {
	apiKey: string
	model?: "rerank-2.5" | "rerank-2.5-lite"
	/** memongo used 2 s inline in every search; a caller asking explicitly
	 *  for reranking can wait longer. */
	timeoutMs?: number
	fetchFn?: typeof globalThis.fetch
}

export class VoyageRerankError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "VoyageRerankError"
	}
}

export function voyageRerankUrl(apiKey: string): string {
	return apiKey.startsWith("al-") ? RERANK_URL_ATLAS : RERANK_URL_DIRECT
}

export function createVoyageReranker(
	options: VoyageRerankOptions,
): WikiRerankFn {
	const fetchFn = options.fetchFn ?? globalThis.fetch
	const model = options.model ?? "rerank-2.5"
	const timeoutMs = options.timeoutMs ?? 5000
	const url = voyageRerankUrl(options.apiKey)
	return async (query, docs) => {
		// Blank documents carry nothing to score; send the rest.
		const candidates = docs
			.map((doc, index) => ({ doc, index }))
			.filter(({ doc }) => doc.text.trim().length > 0)
		if (candidates.length <= 1) return docs
		let response: Response
		try {
			response = await fetchFn(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${options.apiKey}`,
				},
				body: JSON.stringify({
					model,
					query,
					documents: candidates.map(({ doc }) => doc.text),
					top_k: candidates.length,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (err) {
			throw new VoyageRerankError("rerank request failed", { cause: err })
		}
		if (!response.ok)
			throw new VoyageRerankError(`rerank returned HTTP ${response.status}`)
		const body = (await response.json().catch(() => null)) as {
			data?: Array<{ index?: unknown; relevance_score?: unknown }>
		} | null
		if (!body || !Array.isArray(body.data))
			throw new VoyageRerankError("rerank response has no data array")
		const out: Array<{ text: string; score: number }> = []
		for (const row of body.data) {
			const candidate =
				typeof row.index === "number" ? candidates[row.index] : undefined
			if (!candidate || typeof row.relevance_score !== "number") continue
			out.push({ text: candidate.doc.text, score: row.relevance_score })
		}
		return out
	}
}
