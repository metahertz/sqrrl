// POST /v1/wiki/answer: a cited answer from the brain (roadmap, Phase 5).
//
//   1. wiki search (hybrid, graphExpansion, governed) and raw search run in
//      parallel, both reranked when VOYAGE_API_KEY is set;
//   2. the hits become labelled evidence (lib/answer.ts);
//   3. the LLM answers from that evidence alone, citing labels;
//   4. citations are checked against the evidence and rewritten to [slug]
//      and [raw:<id>]. No evidence, or an answer that cites none, is
//      "Not in the brain." and costs no LLM call in the first case.
//
// Needs only the read capability: the answer is derived from what the
// caller could already search, and nothing is written. Local addition, not
// upstream.

import { Hono } from "hono"
import { RawSearchUnavailableError, searchRawItems } from "@sqrrl/source-layer"
import {
	createVoyageReranker,
	searchWikiPages,
	WikiSearchUnavailableError,
} from "@sqrrl/wiki-engine"
import type { ApiEnvironment } from "../api-context.js"
import {
	ANSWER_SYSTEM_PROMPT,
	type AnswerEvidence,
	buildAnswerPrompt,
	labelEvidence,
	NOT_IN_BRAIN,
	readAnswerReply,
	resolveCitations,
} from "../lib/answer.js"
import { type PeopleContext, peopleContext } from "../lib/answer-people.js"
import { jsonError } from "../lib/errors.js"
import {
	createAnswerCompletion,
	LlmCallError,
	LlmNotConfiguredError,
} from "../lib/llm-generate.js"
import { getWikiStoreHandle } from "../wiki-store-runtime.js"
import { rawHandle, readScope } from "./raw.js"
import { buildWikiGovContext } from "./wiki-context.js"

export const ANSWER_MAX_DEPTH = 2
const DEFAULT_PAGES = 6
const MAX_PAGES = 10
const DEFAULT_RAW = 5
const MAX_RAW = 10
/** Linked pages enter as short summaries; past a few they crowd out hits. */
const MAX_GRAPH_PAGES = 4

function boundedInt(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number | "invalid" {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isInteger(value)) return "invalid"
	if (value < min || value > max) return "invalid"
	return value
}

export function createAnswerRouter(): Hono<ApiEnvironment> {
	const answer = new Hono<ApiEnvironment>()

	answer.post("/", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const query = String(body.query ?? "").trim()
		if (!query)
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		const scope = readScope(body)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const maxDepth = boundedInt(body.maxDepth, 1, 0, ANSWER_MAX_DEPTH)
		const maxPages = boundedInt(body.maxPages, DEFAULT_PAGES, 1, MAX_PAGES)
		const maxRaw = boundedInt(body.maxRaw, DEFAULT_RAW, 0, MAX_RAW)
		for (const [name, value, max, min] of [
			["maxDepth", maxDepth, ANSWER_MAX_DEPTH, 0],
			["maxPages", maxPages, MAX_PAGES, 1],
			["maxRaw", maxRaw, MAX_RAW, 0],
		] as const) {
			if (value === "invalid")
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					`${name} must be an integer ${min}..${max}`,
				)
		}

		// Fail before retrieval, so a misconfigured server costs no searches.
		let complete: ReturnType<typeof createAnswerCompletion>
		try {
			complete = createAnswerCompletion()
		} catch (err) {
			if (err instanceof LlmNotConfiguredError)
				return jsonError(c, 503, "LLM_NOT_CONFIGURED", err.message)
			throw err
		}

		const voyageKey = process.env.VOYAGE_API_KEY?.trim()
		const rerank = voyageKey
			? createVoyageReranker({ apiKey: voyageKey })
			: undefined

		const governance = buildWikiGovContext(c, scope.scope, scope.scopeRef)
		// People the question names, however it spells them. Best effort:
		// a failure here only loses the extra context.
		const people: PeopleContext = await getWikiStoreHandle()
			.then((handle) => peopleContext(handle, { query, ...scope, governance }))
			.catch(() => ({ mentions: [], note: "", rawQueries: [], pages: [] }))

		const [wiki, raw, rawPeople] = await Promise.allSettled([
			getWikiStoreHandle().then((handle) =>
				searchWikiPages(handle, {
					query,
					...scope,
					maxResults: maxPages as number,
					graphExpansion: { maxDepth: maxDepth as number },
					rerank,
					governance,
				}),
			),
			maxRaw === 0
				? Promise.resolve([])
				: rawHandle().then((handle) =>
						searchRawItems(handle, {
							query,
							...scope,
							limit: maxRaw as number,
							rerank,
						}),
					),
			maxRaw === 0 || !people.rawQueries.length
				? Promise.resolve([])
				: rawHandle().then(async (handle) =>
						(
							await Promise.all(
								people.rawQueries.map((q) =>
									searchRawItems(handle, {
										query: q,
										...scope,
										limit: Math.min(maxRaw as number, 4),
										rerank,
									}),
								),
							)
						).flat(),
					),
		])

		// The wiki is the primary evidence: without it an answer would rest
		// on raw text alone, so its outage is the caller's 503. Raw search
		// only adds quotes; its outage degrades the answer and says so.
		if (wiki.status === "rejected") {
			if (wiki.reason instanceof WikiSearchUnavailableError)
				return jsonError(
					c,
					503,
					"SEARCH_UNAVAILABLE",
					"wiki search is currently unavailable",
				)
			const message =
				wiki.reason instanceof Error ? wiki.reason.message : String(wiki.reason)
			return jsonError(c, 500, "WIKI_ANSWER_FAILED", message)
		}
		const degraded: string[] = []
		if (raw.status === "rejected") {
			if (!(raw.reason instanceof RawSearchUnavailableError)) {
				const message =
					raw.reason instanceof Error ? raw.reason.message : String(raw.reason)
				return jsonError(c, 500, "WIKI_ANSWER_FAILED", message)
			}
			degraded.push("raw")
		}

		const hits = wiki.value.results.filter((r) => r.source !== "graph")
		const linked = wiki.value.results
			.filter((r) => r.source === "graph")
			.slice(0, MAX_GRAPH_PAGES)
		// Pages linked to the people named, after the hits and before plain
		// graph neighbors; raw items found by full name after the rest.
		const hitSlugs = new Set(hits.map((h) => h.page.slug))
		const personPages = people.pages
			.filter((page) => !hitSlugs.has(page.slug))
			.map((page) => ({ page, source: "person", score: 0 }))
		const taken = new Set([...hitSlugs, ...personPages.map((p) => p.page.slug)])
		const rawHits = raw.status === "fulfilled" ? raw.value : []
		const rawIds = new Set(rawHits.map((r) => r.item.id))
		const rawExtra = (rawPeople.status === "fulfilled" ? rawPeople.value : [])
			.filter((r) => !rawIds.has(r.item.id) && rawIds.add(r.item.id))
			.slice(0, 4)
		const evidence: AnswerEvidence = {
			pages: [
				...hits,
				...personPages,
				...linked.filter((l) => !taken.has(l.page.slug)),
			],
			raw: [...rawHits, ...rawExtra],
		}

		const base = {
			...scope,
			query,
			rerank: rerank ? "on" : "unavailable",
			...(degraded.length ? { degraded } : {}),
			...(people.mentions.length
				? {
						people: people.mentions.map((m) => ({
							text: m.text,
							...(m.person
								? { slug: m.person.slug, title: m.person.title }
								: {
										candidates: (m.candidates ?? []).map((c) => ({
											slug: c.slug,
											title: c.title,
										})),
									}),
						})),
					}
				: {}),
		}
		const listing = (cited: Set<string>) => ({
			pages: evidence.pages.map(({ page, source, score }) => ({
				slug: page.slug,
				title: page.title,
				kind: page.kind,
				source,
				score,
				cited: cited.has(page.slug),
			})),
			raw: evidence.raw.map(({ item, score }) => ({
				id: item.id,
				source: item.source,
				sourceId: item.sourceId,
				...(item.title ? { title: item.title } : {}),
				score,
				cited: cited.has(item.id),
			})),
		})

		if (evidence.pages.length === 0 && evidence.raw.length === 0) {
			return c.json({
				...base,
				answer: NOT_IN_BRAIN,
				found: false,
				citations: [],
				...listing(new Set()),
			})
		}

		const { labels, text } = labelEvidence(evidence)
		let reply: unknown
		try {
			reply = await complete(
				ANSWER_SYSTEM_PROMPT,
				buildAnswerPrompt(
					query,
					text,
					new Date().toISOString().slice(0, 10),
					people.note,
				),
			)
		} catch (err) {
			if (err instanceof LlmCallError)
				return jsonError(c, 502, "LLM_CALL_FAILED", err.message)
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WIKI_ANSWER_FAILED", message)
		}
		const modelReply = readAnswerReply(reply)
		const parsed = resolveCitations(
			modelReply.answer,
			modelReply.found,
			labels,
			modelReply.cited,
		)
		const cited = new Set(
			parsed.citations.map((x) => (x.type === "page" ? x.slug : x.id)),
		)
		return c.json({
			...base,
			answer: parsed.answer,
			found: parsed.found,
			citations: parsed.citations,
			...(parsed.unknownRefs.length
				? { droppedCitations: parsed.unknownRefs }
				: {}),
			...listing(cited),
		})
	})

	return answer
}
