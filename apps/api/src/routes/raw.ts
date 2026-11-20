// Layer 1 routes: raw source items.
//
//   POST /v1/raw/items   write a batch (write capability)
//   POST /v1/raw/search  hybrid search over current items (read capability)
//   POST /v1/raw/sync    write a complete window of one source, retire what
//                        it no longer contains, distill what changed (write)
//
// Scope authorization happens in the /v1 auth middleware like every other
// data route: the batch-level scope/scopeRef in the body is what a scoped
// key is checked against, so items carry no scope of their own. Local
// addition, not upstream.

import { Hono } from "hono"
import {
	CALENDAR_SOURCE,
	distillCalendarEvents,
	ensureRawItemsSchema,
	listCurrentRawItems,
	type MeetingDistillSummary,
	RAW_ITEM_KINDS,
	RAW_ITEMS_SEARCH_INDEX_TARGETS,
	rawItemsCollection,
	type RawItemInput,
	type RawItemKind,
	RawItemValidationError,
	RawSearchUnavailableError,
	type RawWriteReceipt,
	retireMissingRawItems,
	type RunInTransaction,
	searchRawItems,
	upsertRawItems,
} from "@sqrrl/source-layer"
import { createVoyageReranker, WIKI_SCOPE_VALUES } from "@sqrrl/wiki-engine"
import { type ApiEnvironment, getApiPrincipal } from "../api-context.js"
import { jsonError } from "../lib/errors.js"
import {
	getWikiStoreHandle,
	withWikiTransaction,
} from "../wiki-store-runtime.js"

export async function rawHandle() {
	const handle = await getWikiStoreHandle()
	await ensureRawItemsSchema(handle.db, handle.prefix)
	return handle
}

/** For /ready: the raw store answers and both search indexes can serve
 *  queries. Listing index status needs no embedding call, so it is cheap
 *  enough to run on every (cached) readiness check. */
export async function checkRawStoreReadiness(): Promise<{ search: true }> {
	const handle = await rawHandle()
	const indexes = (await rawItemsCollection(handle.db, handle.prefix)
		.listSearchIndexes()
		.toArray()) as Array<{ name: string; queryable?: boolean; status?: string }>
	for (const target of Object.values(RAW_ITEMS_SEARCH_INDEX_TARGETS)) {
		const index = indexes.find((i) => i.name === target.name)
		if (!index || (index.queryable !== true && index.status !== "READY"))
			throw new Error(`raw search index ${target.name} is not queryable`)
	}
	return { search: true }
}

export function readScope(
	body: Record<string, unknown>,
): { scope: string; scopeRef: string } | { error: string } {
	const scope = String(body.scope ?? "")
	const scopeRef = String(body.scopeRef ?? "").trim()
	if (!(WIKI_SCOPE_VALUES as readonly string[]).includes(scope))
		return { error: `scope must be one of ${WIKI_SCOPE_VALUES.join("|")}` }
	if (!scopeRef) return { error: "scopeRef is required" }
	return { scope, scopeRef }
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined
}

export function createRawRouter(): Hono<ApiEnvironment> {
	const raw = new Hono<ApiEnvironment>()

	raw.post("/items", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scope = readScope(body)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		if (!Array.isArray(body.items))
			return jsonError(c, 400, "VALIDATION_ERROR", "items must be an array")
		try {
			const handle = await rawHandle()
			const receipts = await upsertRawItems(
				handle,
				body.items as RawItemInput[],
				{ ...scope, writer: getApiPrincipal(c).subjectId },
				(fn) => withWikiTransaction((_h, session) => fn(session)),
			)
			const counts = { created: 0, updated: 0, unchanged: 0 }
			for (const r of receipts) counts[r.status]++
			return c.json({ ...scope, ...counts, items: receipts })
		} catch (err) {
			if (err instanceof RawItemValidationError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RAW_WRITE_FAILED", message)
		}
	})

	raw.post("/search", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scope = readScope(body)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const query = String(body.query ?? "").trim()
		if (!query)
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		if (
			body.kind !== undefined &&
			!RAW_ITEM_KINDS.includes(body.kind as RawItemKind)
		)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`kind must be one of ${RAW_ITEM_KINDS.join("|")}`,
			)
		// Opt-in, and only with a key: rerank is an extra paid HTTP call.
		const voyageKey = process.env.VOYAGE_API_KEY?.trim()
		const rerankRequested = body.rerank === true
		const rerank =
			rerankRequested && voyageKey
				? createVoyageReranker({ apiKey: voyageKey })
				: undefined
		try {
			const handle = await rawHandle()
			const results = await searchRawItems(handle, {
				query,
				...scope,
				source: optionalString(body.source),
				kind: body.kind as RawItemKind | undefined,
				channel: optionalString(body.channel),
				thread: optionalString(body.thread),
				author: optionalString(body.author),
				from: optionalString(body.from),
				to: optionalString(body.to),
				includeHistory: body.includeHistory === true,
				limit: typeof body.limit === "number" ? body.limit : undefined,
				rerank,
			})
			return c.json({
				...scope,
				rerank: !rerankRequested
					? "off"
					: !voyageKey
						? "unavailable"
						: results.length <= 1
							? "skipped"
							: results.some((r) => r.reranked)
								? "applied"
								: "failed",
				results,
			})
		} catch (err) {
			if (err instanceof RawItemValidationError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			if (err instanceof RawSearchUnavailableError)
				return jsonError(
					c,
					503,
					"SEARCH_UNAVAILABLE",
					"raw search is currently unavailable",
				)
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RAW_SEARCH_FAILED", message)
		}
	})

	raw.post("/sync", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scope = readScope(body)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const source = optionalString(body.source)?.trim()
		if (!source)
			return jsonError(c, 400, "VALIDATION_ERROR", "source is required")
		if (!Array.isArray(body.items))
			return jsonError(c, 400, "VALIDATION_ERROR", "items must be an array")
		const items = body.items as RawItemInput[]
		if (items.some((i) => i?.source !== source))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`every item must have source "${source}"`,
			)
		const window = readWindow(body.window)
		if (window === "invalid")
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"window must be { from, to } ISO dates with from < to",
			)
		if (window) {
			// Retirement trusts the window to be complete, so an item outside
			// it means the caller's window and items disagree.
			const outside = items.find((i) => {
				const at = Date.parse(String(i.occurredAt ?? ""))
				return !(at >= window.from.getTime() && at < window.to.getTime())
			})
			if (outside)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					`item ${outside.sourceId} has no occurredAt inside the window`,
				)
		}
		const channel = optionalString(body.channel)
		if (channel && items.some((i) => i.channel !== channel))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`every item must have channel "${channel}"`,
			)
		const writer = getApiPrincipal(c).subjectId
		const inTx: RunInTransaction = (fn) =>
			withWikiTransaction((_h, session) => fn(session))
		try {
			const handle = await rawHandle()
			const written: RawWriteReceipt[] = items.length
				? await upsertRawItems(handle, items, { ...scope, writer }, inTx)
				: []
			const retired = window
				? await retireMissingRawItems(
						handle,
						{
							...scope,
							source,
							...window,
							presentIds: items.map((i) => i.sourceId),
							writer,
							...(channel ? { channel } : {}),
							...(body.excludeReplies === true ? { excludeReplies: true } : {}),
						},
						inTx,
					)
				: []
			const counts = { created: 0, updated: 0, unchanged: 0 }
			for (const r of written) counts[r.status]++
			const changed = [
				...written.filter(
					(r) => body.redistill === true || r.status !== "unchanged",
				),
				...retired,
			].map((r) => r.sourceId)
			const toDistill = await listCurrentRawItems(handle, {
				...scope,
				source,
				sourceIds: changed,
			})
			// One distiller per kind of source; items with none stay in
			// Layer 1 only, searchable but not yet in the wiki.
			const events = toDistill.filter((i) => i.kind === "event")
			let meetings: MeetingDistillSummary | undefined
			if (events.length && source === CALENDAR_SOURCE)
				meetings = await distillCalendarEvents(handle, events, {
					...scope,
					...(typeof body.maxNewPeople === "number"
						? { maxNewPeople: body.maxNewPeople }
						: {}),
				})
			return c.json({
				...scope,
				source,
				...counts,
				retired: retired.length,
				distilled: {
					...(meetings ? { meetings } : {}),
					undistilled: toDistill.length - (meetings ? events.length : 0),
				},
				items: written,
			})
		} catch (err) {
			if (err instanceof RawItemValidationError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RAW_SYNC_FAILED", message)
		}
	})

	return raw
}

/** A sync window: [from, to). Absent means nothing is retired. */
function readWindow(
	raw: unknown,
): { from: Date; to: Date } | undefined | "invalid" {
	if (raw === undefined || raw === null) return undefined
	if (typeof raw !== "object") return "invalid"
	const { from, to } = raw as { from?: unknown; to?: unknown }
	const f = new Date(String(from ?? ""))
	const t = new Date(String(to ?? ""))
	if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f >= t)
		return "invalid"
	return { from: f, to: t }
}
