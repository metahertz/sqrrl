import { ObjectId, type Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	buildRawPrefilter,
	normalizeRawItem,
	RAW_ITEMS_MAX_BATCH,
	rawContentHash,
	RawItemValidationError,
	RawSearchUnavailableError,
	retireMissingRawItems,
	searchRawItems,
	upsertRawItems,
} from "./raw-items.js"

/** Just enough of a collection for upsertRawItems: equality filters,
 *  $set by _id, insert. Enforces the identity_current partial unique index
 *  so a write that leaves two current versions fails like Atlas would. */
function fakeStore() {
	const docs: Document[] = []
	const matches = (doc: Document, filter: Document) =>
		Object.entries(filter).every(([k, v]) =>
			v instanceof ObjectId ? String(doc[k]) === String(v) : doc[k] === v,
		)
	const coll = {
		docs,
		/** Enough of find for retireMissingRawItems: current items of a
		 *  source in [from, to) outside a set of ids, not tombstoned. */
		find(filter: Document) {
			const range = filter.occurredAt as { $gte: Date; $lt: Date }
			const nin = (filter.sourceId as { $nin: string[] }).$nin
			return {
				toArray: async () =>
					docs.filter(
						(d) =>
							d.current &&
							d.source === filter.source &&
							d.scopeRef === filter.scopeRef &&
							d.text !== "" &&
							d.occurredAt >= range.$gte &&
							d.occurredAt < range.$lt &&
							!nin.includes(d.sourceId) &&
							(filter.channel === undefined || d.channel === filter.channel) &&
							(filter["metadata.isReply"] === undefined ||
								d.metadata?.isReply !== true),
					),
			}
		},
		async findOne(filter: Document) {
			return docs.find((d) => matches(d, filter)) ?? null
		},
		async updateOne(filter: Document, update: { $set: Document }) {
			const doc = docs.find((d) => matches(d, filter))
			if (doc) Object.assign(doc, update.$set)
		},
		async insertOne(doc: Document) {
			const clash = docs.some(
				(d) =>
					d.current &&
					doc.current &&
					d.scope === doc.scope &&
					d.scopeRef === doc.scopeRef &&
					d.source === doc.source &&
					d.sourceId === doc.sourceId,
			)
			if (clash) throw new Error("E11000 duplicate key identity_current")
			const _id = new ObjectId()
			docs.push({ ...doc, _id })
			return { insertedId: _id }
		},
		aggregate: vi.fn(),
	}
	const handle = { db: { collection: () => coll }, prefix: "t_" } as never
	return { coll, handle }
}

const passthrough = <T>(fn: (session: never) => Promise<T>) => fn({} as never)
const SCOPE = { scope: "workspace", scopeRef: "ws-1" }
const NOTE = {
	source: "apple-notes",
	sourceId: "x1",
	kind: "note" as const,
	title: "Standup",
	text: "Dana will ship the OIDC migration by Friday",
	occurredAt: "2026-11-17T09:00:00Z",
}

describe("normalizeRawItem", () => {
	it("keeps only known fields, defaults collections, and parses dates", () => {
		const doc = normalizeRawItem({ ...NOTE, extra: "dropped" } as never)
		expect(doc).toEqual({
			source: "apple-notes",
			sourceId: "x1",
			kind: "note",
			title: "Standup",
			text: NOTE.text,
			occurredAt: new Date("2026-11-17T09:00:00Z"),
			participants: [],
			attachments: [],
			metadata: {},
		})
	})

	it("rejects what the validator would", () => {
		const bad: Array<[Record<string, unknown>, RegExp]> = [
			[{ ...NOTE, source: " " }, /source is required/],
			[{ ...NOTE, kind: "tweet" }, /kind must be one of/],
			[{ ...NOTE, text: 3 }, /text must be a string/],
			[
				{ ...NOTE, occurredAt: "yesterday-ish" },
				/occurredAt is not a valid date/,
			],
			[{ ...NOTE, participants: ["a", 2] }, /participants must be strings/],
			[
				{ ...NOTE, attachments: [{ name: "a.pdf" }] },
				/attachment needs name and ref/,
			],
			[{ ...NOTE, metadata: [] }, /metadata must be an object/],
			[{ ...NOTE, channel: 5 }, /channel must be a string/],
		]
		for (const [input, message] of bad)
			expect(() => normalizeRawItem(input as never)).toThrow(message)
	})
})

describe("rawContentHash", () => {
	it("is stable across key order and date formats, and ignores identity", () => {
		const a = normalizeRawItem(NOTE)
		const b = normalizeRawItem({
			occurredAt: new Date("2026-11-17T09:00:00.000Z"),
			text: NOTE.text,
			title: "Standup",
			kind: "note",
			sourceId: "other-id",
			source: "apple-notes",
		})
		expect(rawContentHash(a)).toBe(rawContentHash(b))
	})

	it("changes when content changes", () => {
		const a = normalizeRawItem(NOTE)
		const b = normalizeRawItem({ ...NOTE, text: `${NOTE.text}!` })
		expect(rawContentHash(a)).not.toBe(rawContentHash(b))
	})
})

describe("upsertRawItems", () => {
	it("creates, then no-ops on identical content, then versions a change", async () => {
		const { coll, handle } = fakeStore()
		const first = await upsertRawItems(
			handle,
			[NOTE],
			{ ...SCOPE, writer: "key-1" },
			passthrough,
		)
		expect(first[0]).toMatchObject({
			status: "created",
			version: 1,
			sourceId: "x1",
		})
		const again = await upsertRawItems(handle, [NOTE], SCOPE, passthrough)
		expect(again[0]).toMatchObject({
			status: "unchanged",
			version: 1,
			id: first[0].id,
		})
		const edited = await upsertRawItems(
			handle,
			[{ ...NOTE, text: "Dana will ship it Monday" }],
			SCOPE,
			passthrough,
		)
		expect(edited[0]).toMatchObject({ status: "updated", version: 2 })
		expect(coll.docs).toHaveLength(2)
		const [v1, v2] = coll.docs
		expect(v1).toMatchObject({ current: false, version: 1, writer: "key-1" })
		expect(String(v1.supersededBy)).toBe(edited[0].id)
		expect(v2).toMatchObject({
			current: true,
			version: 2,
			supersededBy: null,
			...SCOPE,
		})
	})

	it("stores and hashes the redacted text, and says what it redacted", async () => {
		const { coll, handle } = fakeStore()
		const leaky = {
			...NOTE,
			title: "svc@Ab3dEfGh1jKl",
			text: "uri mongodb+srv://svc:Zx9Qw8Er7Ty6@c0.example.net/db",
		}
		const [receipt] = await upsertRawItems(handle, [leaky], SCOPE, passthrough)
		expect(receipt.redacted).toEqual({
			"uri-password": 1,
			"user-at-password": 1,
		})
		const stored = coll.docs[0]
		expect(JSON.stringify(stored)).not.toMatch(/Zx9Qw8Er7Ty6|Ab3dEfGh1jKl/)
		expect(stored.text).toBe(
			"uri mongodb+srv://svc:[REDACTED:uri-password]@c0.example.net/db",
		)
		// Re-sending the same leaky note is still a no-op: the hash is of
		// the redacted content.
		const [again] = await upsertRawItems(handle, [leaky], SCOPE, passthrough)
		expect(again.status).toBe("unchanged")
		const [clean] = await upsertRawItems(
			handle,
			[{ ...NOTE, sourceId: "x2" }],
			SCOPE,
			passthrough,
		)
		expect(clean).not.toHaveProperty("redacted")
	})

	it("redacts metadata strings too, at any depth", async () => {
		const { coll, handle } = fakeStore()
		const [receipt] = await upsertRawItems(
			handle,
			[
				{
					...NOTE,
					metadata: {
						conferenceUrl: "https://zoom.us/j/123?pwd=Zx9Qw8Er7Ty6",
						attendees: [{ note: "passcode: 884213" }],
						count: 3,
					},
				},
			],
			SCOPE,
			passthrough,
		)
		expect(receipt.redacted).toEqual({ assignment: 2 })
		expect(JSON.stringify(coll.docs[0].metadata)).not.toMatch(/Zx9Qw8|884213/)
		expect(coll.docs[0].metadata.count).toBe(3)
	})

	it("keeps the same sourceId in different scopes apart", async () => {
		const { coll, handle } = fakeStore()
		await upsertRawItems(handle, [NOTE], SCOPE, passthrough)
		const other = await upsertRawItems(
			handle,
			[NOTE],
			{ scope: "workspace", scopeRef: "ws-2" },
			passthrough,
		)
		expect(other[0].status).toBe("created")
		expect(coll.docs).toHaveLength(2)
	})

	it("validates the whole batch before writing anything", async () => {
		const { coll, handle } = fakeStore()
		await expect(
			upsertRawItems(
				handle,
				[NOTE, { ...NOTE, kind: "tweet" } as never],
				SCOPE,
				passthrough,
			),
		).rejects.toThrow(/items\[1\]: kind must be one of/)
		expect(coll.docs).toHaveLength(0)
		await expect(
			upsertRawItems(handle, [], SCOPE, passthrough),
		).rejects.toBeInstanceOf(RawItemValidationError)
		const tooMany = Array.from({ length: RAW_ITEMS_MAX_BATCH + 1 }, (_, i) => ({
			...NOTE,
			sourceId: `n${i}`,
		}))
		await expect(
			upsertRawItems(handle, tooMany, SCOPE, passthrough),
		).rejects.toThrow(/at most 500/)
	})
})

describe("buildRawPrefilter", () => {
	it("scopes to current items unless history is asked for, and bounds time", () => {
		expect(
			buildRawPrefilter({
				query: "q",
				...SCOPE,
				channel: "#eng",
				from: "2026-11-01",
				to: "2026-11-30T23:59:59Z",
			}),
		).toEqual({
			...SCOPE,
			current: true,
			channel: "#eng",
			occurredAt: {
				$gte: new Date("2026-11-01"),
				$lte: new Date("2026-11-30T23:59:59Z"),
			},
		})
		expect(
			buildRawPrefilter({ query: "q", ...SCOPE, includeHistory: true }),
		).toEqual(SCOPE)
	})
})

describe("searchRawItems", () => {
	function hit(sourceId: string, text: string, score: number) {
		return {
			_id: new ObjectId(),
			...SCOPE,
			source: "apple-notes",
			sourceId,
			version: 1,
			current: true,
			supersededBy: null,
			kind: "note",
			text,
			participants: [],
			attachments: [],
			metadata: {},
			contentHash: "h",
			createdAt: new Date(),
			searchScore: { value: score },
		}
	}

	it("fuses vector and text under the same filter, mapping scores", async () => {
		const { coll, handle } = fakeStore()
		coll.aggregate.mockReturnValue({
			toArray: async () => [hit("a", "alpha", 0.03)],
		})
		const out = await searchRawItems(handle, {
			query: " oidc ",
			...SCOPE,
			author: "Dana",
			to: "2026-11-30",
		})
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ score: 0.03, reranked: false })
		expect(out[0].item).toMatchObject({ sourceId: "a", supersededBy: null })
		expect(out[0].item).not.toHaveProperty("searchScore")
		const pipeline = coll.aggregate.mock.calls[0][0] as Document[]
		const fusion = pipeline[0].$rankFusion.input.pipelines
		const filter = fusion.vector[0].$vectorSearch.filter
		expect(filter).toEqual({
			...SCOPE,
			current: true,
			author: "Dana",
			occurredAt: { $lte: new Date("2026-11-30") },
		})
		expect(fusion.vector[0].$vectorSearch.query).toEqual({ text: "oidc" })
		const compound = fusion.text[0].$search.compound
		expect(compound.filter).toEqual(
			expect.arrayContaining([
				{ equals: { path: "current", value: true } },
				{ equals: { path: "author", value: "Dana" } },
				{ range: { path: "occurredAt", lte: new Date("2026-11-30") } },
			]),
		)
	})

	it("reorders by the reranker, pairing on text, and keeps dropped hits after", async () => {
		const { coll, handle } = fakeStore()
		coll.aggregate.mockReturnValue({
			toArray: async () => [
				hit("a", "alpha", 0.3),
				hit("b", "beta", 0.2),
				hit("c", "gamma", 0.1),
			],
		})
		const rerank = vi.fn(
			async (_q: string, docs: Array<{ text: string; score: number }>) => [
				{ text: docs[2].text, score: 0.99 },
				{ text: docs[0].text, score: 0.5 },
			],
		)
		const out = await searchRawItems(handle, { query: "q", ...SCOPE, rerank })
		expect(out.map((r) => [r.item.sourceId, r.score, r.reranked])).toEqual([
			["c", 0.99, true],
			["a", 0.5, true],
			["b", 0.2, false],
		])
	})

	it("keeps fusion order when the reranker fails", async () => {
		const { coll, handle } = fakeStore()
		coll.aggregate.mockReturnValue({
			toArray: async () => [hit("a", "alpha", 0.3), hit("b", "beta", 0.2)],
		})
		const rerank = vi.fn(async () => {
			throw new Error("429")
		})
		const out = await searchRawItems(handle, { query: "q", ...SCOPE, rerank })
		expect(out.map((r) => r.item.sourceId)).toEqual(["a", "b"])
	})

	it("reports an outage as unavailable, and an empty query as invalid", async () => {
		const { coll, handle } = fakeStore()
		coll.aggregate.mockImplementation(() => {
			throw new Error("index raw_items_vector not found")
		})
		await expect(
			searchRawItems(handle, { query: "q", ...SCOPE }),
		).rejects.toBeInstanceOf(RawSearchUnavailableError)
		await expect(
			searchRawItems(handle, { query: "  ", ...SCOPE }),
		).rejects.toBeInstanceOf(RawItemValidationError)
	})
})

describe("retireMissingRawItems", () => {
	const EVENT = {
		source: "calendar",
		kind: "event" as const,
		text: "Standup",
		unit: "u",
	}
	const window = {
		from: new Date("2026-11-01T00:00:00Z"),
		to: new Date("2026-12-01T00:00:00Z"),
	}

	it("tombstones what the window no longer contains, once", async () => {
		const { coll, handle } = fakeStore()
		await upsertRawItems(
			handle,
			[
				{ ...EVENT, sourceId: "keep", occurredAt: "2026-11-10T09:00:00Z" },
				{ ...EVENT, sourceId: "gone", occurredAt: "2026-11-11T09:00:00Z" },
				// Outside the window: untouched although absent.
				{ ...EVENT, sourceId: "dec", occurredAt: "2026-12-02T09:00:00Z" },
			],
			SCOPE,
			passthrough,
		)
		const params = {
			...SCOPE,
			source: "calendar",
			...window,
			presentIds: ["keep"],
		}
		const retired = await retireMissingRawItems(handle, params, passthrough)
		expect(retired.map((r) => [r.sourceId, r.status, r.version])).toEqual([
			["gone", "updated", 2],
		])
		const tomb = coll.docs.find((d) => d.sourceId === "gone" && d.current)
		expect(tomb).toMatchObject({
			text: "",
			metadata: { retired: true },
			unit: "u",
		})
		expect(tomb?.invalidAt).toBeInstanceOf(Date)
		expect(tomb?.occurredAt).toEqual(new Date("2026-11-11T09:00:00Z"))
		expect(await retireMissingRawItems(handle, params, passthrough)).toEqual([])
	})

	it("can be limited to one channel and leave thread replies alone", async () => {
		const { coll, handle } = fakeStore()
		const msg = (sourceId: string, channel: string, isReply = false) => ({
			source: "slack",
			sourceId,
			kind: "message" as const,
			text: "hi",
			channel,
			occurredAt: "2026-11-10T09:00:00Z",
			metadata: isReply ? { isReply: true } : {},
		})
		await upsertRawItems(
			handle,
			[msg("a1", "general"), msg("a2", "general", true), msg("b1", "random")],
			SCOPE,
			passthrough,
		)
		const retired = await retireMissingRawItems(
			handle,
			{
				...SCOPE,
				source: "slack",
				...window,
				presentIds: [],
				channel: "general",
				excludeReplies: true,
			},
			passthrough,
		)
		expect(retired.map((r) => r.sourceId)).toEqual(["a1"])
		const tomb = coll.docs.find((d) => d.sourceId === "a1" && d.current)
		expect(tomb).toMatchObject({ text: "", channel: "general" })
	})
})
