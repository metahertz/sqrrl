import { describe, expect, it, vi } from "vitest"
import {
	createVoyageReranker,
	VoyageRerankError,
	voyageRerankUrl,
} from "./voyage-rerank.js"

function okResponse(data: unknown) {
	return { ok: true, status: 200, json: async () => ({ data }) } as Response
}

describe("voyageRerankUrl", () => {
	it("routes Atlas Model API keys through MongoDB and others to Voyage", () => {
		expect(voyageRerankUrl("al-abc")).toBe("https://ai.mongodb.com/v1/rerank")
		expect(voyageRerankUrl("pa-abc")).toBe("https://api.voyageai.com/v1/rerank")
	})
})

describe("createVoyageReranker", () => {
	const docs = [
		{ text: "milk and eggs", score: 0.9 },
		{ text: "   ", score: 0.8 },
		{ text: "OIDC migration plan", score: 0.7 },
	]

	it("sends non-blank docs and returns them in the reranker's order and scores", async () => {
		const fetchFn = vi.fn(async () =>
			// Indexes refer to the documents SENT (blank one dropped).
			okResponse([
				{ index: 1, relevance_score: 0.95 },
				{ index: 0, relevance_score: 0.1 },
			]),
		)
		const rerank = createVoyageReranker({ apiKey: "al-k", fetchFn })
		const out = await rerank("auth migration", docs)
		expect(out).toEqual([
			{ text: "OIDC migration plan", score: 0.95 },
			{ text: "milk and eggs", score: 0.1 },
		])
		const [url, init] = fetchFn.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe("https://ai.mongodb.com/v1/rerank")
		expect(JSON.parse(String(init.body))).toEqual({
			model: "rerank-2.5",
			query: "auth migration",
			documents: ["milk and eggs", "OIDC migration plan"],
			top_k: 2,
		})
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer al-k",
		)
	})

	it("does not call out with fewer than two scorable docs", async () => {
		const fetchFn = vi.fn()
		const rerank = createVoyageReranker({ apiKey: "al-k", fetchFn })
		const single = [
			{ text: "only", score: 1 },
			{ text: "", score: 0 },
		]
		expect(await rerank("q", single)).toBe(single)
		expect(fetchFn).not.toHaveBeenCalled()
	})

	it("ignores rows with an unknown index or no score", async () => {
		const fetchFn = vi.fn(async () =>
			okResponse([
				{ index: 7, relevance_score: 0.9 },
				{ index: 0 },
				{ index: 1, relevance_score: 0.5 },
			]),
		)
		const out = await createVoyageReranker({ apiKey: "pa-k", fetchFn })(
			"q",
			docs,
		)
		expect(out).toEqual([{ text: "OIDC migration plan", score: 0.5 }])
	})

	it("throws a typed error on HTTP failure, network failure and bad bodies", async () => {
		const failing = [
			vi.fn(async () => ({ ok: false, status: 429 }) as Response),
			vi.fn(async () => {
				throw new Error("ECONNRESET")
			}),
			vi.fn(
				async () =>
					({ ok: true, status: 200, json: async () => ({}) }) as Response,
			),
		]
		for (const fetchFn of failing) {
			await expect(
				createVoyageReranker({ apiKey: "al-k", fetchFn })("q", docs),
			).rejects.toBeInstanceOf(VoyageRerankError)
		}
	})
})
