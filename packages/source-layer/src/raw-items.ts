// Raw items: Layer 1's record of what happened.
//
// One document per version of a source item — a note, a file's extracted
// text, and later a Slack message, an email or a calendar event — kept with
// the fields that source has natively (channel, thread, author,
// participants, when it happened). The wiki is distilled FROM these; this
// store keeps the exact words, so a question can be answered with a quote
// and a re-distill never needs the source system again.
//
// Identity is (scope, scopeRef, source, sourceId). Writing the same content
// again is a no-op; writing changed content adds a version and supersedes the
// previous one instead of overwriting it, so edits stay auditable. Only the
// current version of each item is searched unless history is asked for.
//
// Lives in the wiki database next to wiki_pages: same connection, same
// transactions, same Atlas Search (Voyage auto-embedding on `text`).

import { createHash } from "node:crypto"
import type {
	ClientSession,
	Collection,
	Db,
	Document,
	ObjectId,
	SearchIndexDescription,
} from "mongodb"
import { createSubsystemLogger } from "@sqrrl/lib"
import type { WikiDbHandle } from "@sqrrl/wiki-engine"
import { mergeRedactions, redactionCount, redactSecrets } from "./redact.js"

const log = createSubsystemLogger("source-layer:raw-items")

export const RAW_ITEM_KINDS = [
	"note",
	"file",
	"message",
	"email",
	"event",
] as const
export type RawItemKind = (typeof RAW_ITEM_KINDS)[number]

/** Most items a single write may carry. Matches memongo's batch ceiling. */
export const RAW_ITEMS_MAX_BATCH = 500

export interface RawItemAttachment {
	name: string
	contentType?: string
	/** Where the bytes live (a URL or a source-native id); never the bytes. */
	ref: string
}

export interface RawItemInput {
	/** The system it came from: "apple-notes", "nextcloud", "slack", ... */
	source: string
	/** Stable id within that source. Renames must not change it. */
	sourceId: string
	kind: RawItemKind
	text: string
	title?: string
	/** The unit a distiller digests this item in: a note or file is its own
	 *  unit; a Slack message's unit is its channel-day or thread. */
	unit?: string
	occurredAt?: string | Date
	validAt?: string | Date
	invalidAt?: string | Date
	thread?: string
	channel?: string
	author?: string
	participants?: string[]
	attachments?: RawItemAttachment[]
	metadata?: Record<string, unknown>
}

export interface RawItemView {
	id: string
	scope: string
	scopeRef: string
	source: string
	sourceId: string
	version: number
	current: boolean
	supersededBy: string | null
	kind: RawItemKind
	text: string
	title?: string
	unit?: string
	occurredAt?: Date
	validAt?: Date
	invalidAt?: Date
	thread?: string
	channel?: string
	author?: string
	participants: string[]
	attachments: RawItemAttachment[]
	metadata: Record<string, unknown>
	contentHash: string
	writer?: string
	createdAt: Date
}

export type RawWriteStatus = "created" | "updated" | "unchanged"

export interface RawWriteReceipt {
	source: string
	sourceId: string
	version: number
	status: RawWriteStatus
	id: string
	/** Secrets replaced before storing, by kind. Absent when none. */
	redacted?: Record<string, number>
}

/** Runs fn in one transaction. The API passes the wiki store's; tests pass
 *  a passthrough. */
export type RunInTransaction = <T>(
	fn: (session: ClientSession) => Promise<T>,
) => Promise<T>

export class RawItemValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RawItemValidationError"
	}
}

/** Raw search could not run (mongot or the search indexes are down).
 *  Distinct from "matched nothing", like WikiSearchUnavailableError. */
export class RawSearchUnavailableError extends Error {
	constructor(
		message = "raw search unavailable",
		options?: { cause?: unknown },
	) {
		super(message, options)
		this.name = "RawSearchUnavailableError"
	}
}

export function rawItemsCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}raw_items`)
}

// ---------------------------------------------------------------------------
// Schema, indexes, search indexes
// ---------------------------------------------------------------------------

const RAW_ITEMS_VALIDATOR = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"scope",
			"scopeRef",
			"source",
			"sourceId",
			"version",
			"current",
			"kind",
			"text",
			"contentHash",
			"createdAt",
		],
		properties: {
			scope: { bsonType: "string" },
			scopeRef: { bsonType: "string", minLength: 1 },
			source: { bsonType: "string", minLength: 1 },
			sourceId: { bsonType: "string", minLength: 1 },
			version: { bsonType: "int", minimum: 1 },
			current: { bsonType: "bool" },
			supersededBy: { bsonType: ["objectId", "null"] },
			kind: { enum: [...RAW_ITEM_KINDS] },
			text: { bsonType: "string" },
			title: { bsonType: "string" },
			unit: { bsonType: "string" },
			occurredAt: { bsonType: "date" },
			validAt: { bsonType: "date" },
			invalidAt: { bsonType: "date" },
			thread: { bsonType: "string" },
			channel: { bsonType: "string" },
			author: { bsonType: "string" },
			participants: { bsonType: "array", items: { bsonType: "string" } },
			attachments: { bsonType: "array" },
			metadata: { bsonType: "object" },
			contentHash: { bsonType: "string" },
			writer: { bsonType: "string" },
			createdAt: { bsonType: "date" },
		},
	},
}

export const RAW_ITEMS_SEARCH_INDEX_TARGETS = {
	vector: {
		name: "raw_items_vector",
		type: "vectorSearch" as const,
		definition: {
			fields: [
				{
					type: "autoEmbed",
					modality: "text",
					path: "text",
					model: "voyage-4-large",
				},
				{ type: "filter", path: "scope" },
				{ type: "filter", path: "scopeRef" },
				{ type: "filter", path: "current" },
				{ type: "filter", path: "source" },
				{ type: "filter", path: "kind" },
				{ type: "filter", path: "channel" },
				{ type: "filter", path: "thread" },
				{ type: "filter", path: "author" },
				{ type: "filter", path: "occurredAt" },
			],
		},
	},
	text: {
		name: "raw_items_text",
		type: "search" as const,
		definition: {
			mappings: {
				dynamic: false,
				fields: {
					title: [{ type: "string", analyzer: "lucene.standard" }],
					text: [{ type: "string", analyzer: "lucene.standard" }],
					// Filter axes: equals() needs token, range() needs date.
					scope: { type: "token" },
					scopeRef: { type: "token" },
					current: { type: "boolean" },
					source: { type: "token" },
					kind: { type: "token" },
					channel: { type: "token" },
					thread: { type: "token" },
					author: { type: "token" },
					occurredAt: { type: "date" },
				},
			},
		},
	},
}

let schemaEnsured: Promise<void> | undefined

/** Creates the collection, validator, indexes and search indexes once per
 *  process. Search index management failing (no mongot) is logged, not
 *  fatal, as for wiki_pages. */
export function ensureRawItemsSchema(db: Db, prefix: string): Promise<void> {
	schemaEnsured ??= doEnsureRawItemsSchema(db, prefix).catch((err) => {
		schemaEnsured = undefined
		throw err
	})
	return schemaEnsured
}

async function doEnsureRawItemsSchema(db: Db, prefix: string): Promise<void> {
	const name = `${prefix}raw_items`
	const exists = await db
		.listCollections({ name }, { nameOnly: true })
		.hasNext()
	if (!exists) {
		await db.createCollection(name, {
			validator: RAW_ITEMS_VALIDATOR,
			validationLevel: "moderate",
			validationAction: "error",
		})
		log.info(`created collection ${name}`)
	} else {
		await db.command({
			collMod: name,
			validator: RAW_ITEMS_VALIDATOR,
			validationLevel: "moderate",
			validationAction: "error",
		})
	}
	const coll = rawItemsCollection(db, prefix)
	await coll.createIndexes([
		{
			key: { scope: 1, scopeRef: 1, source: 1, sourceId: 1, version: 1 },
			name: "identity_version",
			unique: true,
		},
		{
			// At most one current version per item.
			key: { scope: 1, scopeRef: 1, source: 1, sourceId: 1 },
			name: "identity_current",
			unique: true,
			partialFilterExpression: { current: true },
		},
		{
			key: { scope: 1, scopeRef: 1, current: 1, occurredAt: -1 },
			name: "scope_current_occurredAt",
		},
		{
			key: { scope: 1, scopeRef: 1, unit: 1, current: 1 },
			name: "scope_unit_current",
		},
	])
	for (const target of [
		RAW_ITEMS_SEARCH_INDEX_TARGETS.vector,
		RAW_ITEMS_SEARCH_INDEX_TARGETS.text,
	]) {
		try {
			const existing = await coll.listSearchIndexes(target.name).toArray()
			if (existing.length > 0) continue
			const description: SearchIndexDescription = {
				name: target.name,
				definition: target.definition,
				type: target.type,
			}
			await coll.createSearchIndex(description)
			log.info(`created ${target.type} index ${target.name} on ${name}`)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`search index ${target.name} on ${name} not created: ${msg}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function toDate(
	value: string | Date | undefined,
	field: string,
): Date | undefined {
	if (value === undefined || value === null || value === "") return undefined
	const d = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(d.getTime()))
		throw new RawItemValidationError(`${field} is not a valid date`)
	return d
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new RawItemValidationError(`${field} is required`)
	return value
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined
	if (typeof value !== "string")
		throw new RawItemValidationError(`${field} must be a string`)
	return value
}

/** The content fields, normalized. Identity and bookkeeping are added by
 *  the writer. Exported for the route's validation and for tests. */
export function normalizeRawItem(input: RawItemInput): Document {
	if (!input || typeof input !== "object")
		throw new RawItemValidationError("each item must be an object")
	const source = nonEmpty(input.source, "source")
	const sourceId = nonEmpty(input.sourceId, "sourceId")
	if (!RAW_ITEM_KINDS.includes(input.kind))
		throw new RawItemValidationError(
			`kind must be one of ${RAW_ITEM_KINDS.join("|")}`,
		)
	if (typeof input.text !== "string")
		throw new RawItemValidationError("text must be a string")
	if (input.participants !== undefined) {
		if (
			!Array.isArray(input.participants) ||
			input.participants.some((p) => typeof p !== "string")
		)
			throw new RawItemValidationError("participants must be strings")
	}
	const attachments = input.attachments ?? []
	if (!Array.isArray(attachments))
		throw new RawItemValidationError("attachments must be an array")
	for (const a of attachments) {
		if (!a || typeof a.name !== "string" || typeof a.ref !== "string")
			throw new RawItemValidationError("each attachment needs name and ref")
	}
	if (
		input.metadata !== undefined &&
		(typeof input.metadata !== "object" ||
			input.metadata === null ||
			Array.isArray(input.metadata))
	)
		throw new RawItemValidationError("metadata must be an object")
	const doc: Document = {
		source,
		sourceId,
		kind: input.kind,
		text: input.text,
		participants: input.participants ?? [],
		attachments: attachments.map((a) => ({
			name: a.name,
			ref: a.ref,
			...(a.contentType ? { contentType: a.contentType } : {}),
		})),
		metadata: input.metadata ?? {},
	}
	const strings = ["title", "unit", "thread", "channel", "author"] as const
	for (const field of strings) {
		const v = optionalString(input[field], field)
		if (v !== undefined) doc[field] = v
	}
	const dates = ["occurredAt", "validAt", "invalidAt"] as const
	for (const field of dates) {
		const v = toDate(input[field], field)
		if (v) doc[field] = v
	}
	return doc
}

/** sha256 of the normalized content, keys sorted, so the same content in a
 *  different key order or date format hashes the same. */
export function rawContentHash(normalized: Document): string {
	const canon = (v: unknown): unknown => {
		if (v instanceof Date) return v.toISOString()
		if (Array.isArray(v)) return v.map(canon)
		if (v && typeof v === "object")
			return Object.fromEntries(
				Object.keys(v as object)
					.sort()
					.map((k) => [k, canon((v as Record<string, unknown>)[k])]),
			)
		return v
	}
	const { source: _s, sourceId: _i, ...content } = normalized
	return createHash("sha256")
		.update(JSON.stringify(canon(content)))
		.digest("hex")
}

/** Writes a batch. Each item is its own transaction: a bad item fails the
 *  validation pass up front and nothing is written; a write that fails
 *  half-way through the batch leaves the earlier items written, and
 *  re-sending the batch is safe because unchanged items are no-ops. */
export async function upsertRawItems(
	handle: WikiDbHandle,
	items: RawItemInput[],
	options: { scope: string; scopeRef: string; writer?: string },
	runInTransaction: RunInTransaction,
): Promise<RawWriteReceipt[]> {
	if (!Array.isArray(items) || items.length === 0)
		throw new RawItemValidationError("items must be a non-empty array")
	if (items.length > RAW_ITEMS_MAX_BATCH)
		throw new RawItemValidationError(
			`at most ${RAW_ITEMS_MAX_BATCH} items per write`,
		)
	const normalized = items.map((item, i) => {
		try {
			return normalizeRawItem(item)
		} catch (err) {
			if (err instanceof RawItemValidationError)
				throw new RawItemValidationError(`items[${i}]: ${err.message}`)
			throw err
		}
	})
	const coll = rawItemsCollection(handle.db, handle.prefix)
	const receipts: RawWriteReceipt[] = []
	for (const doc of normalized) {
		// Before hashing and storing: a secret must not reach the store,
		// the embedding index, or a later distill (see redact.ts).
		const redacted: Record<string, number> = {}
		for (const field of ["text", "title"] as const) {
			if (typeof doc[field] !== "string") continue
			const r = redactSecrets(doc[field] as string)
			doc[field] = r.text
			mergeRedactions(redacted, r.found)
		}
		// Metadata carries source-native strings too (a calendar event's
		// conference link, a location), so it is redacted the same way.
		doc.metadata = redactDeep(doc.metadata, redacted)
		if (redactionCount(redacted) > 0)
			log.warn(
				`redacted ${redactionCount(redacted)} secret(s) from ${doc.source}/${doc.sourceId}: ${Object.keys(redacted).join(", ")}`,
			)
		const contentHash = rawContentHash(doc)
		const identity = {
			scope: options.scope,
			scopeRef: options.scopeRef,
			source: doc.source as string,
			sourceId: doc.sourceId as string,
		}
		const receipt = await runInTransaction(async (session) => {
			const current = await coll.findOne(
				{ ...identity, current: true },
				{ session, projection: { _id: 1, version: 1, contentHash: 1 } },
			)
			if (current && current.contentHash === contentHash) {
				return {
					...pick(identity),
					version: current.version as number,
					status: "unchanged" as const,
					id: String(current._id),
				}
			}
			const version = current ? (current.version as number) + 1 : 1
			if (current) {
				// Clear the flag first: the partial unique index allows one
				// current version per item.
				await coll.updateOne(
					{ _id: current._id },
					{ $set: { current: false } },
					{ session },
				)
			}
			const inserted = await coll.insertOne(
				{
					...doc,
					...identity,
					version,
					current: true,
					supersededBy: null,
					contentHash,
					...(options.writer ? { writer: options.writer } : {}),
					createdAt: new Date(),
				},
				{ session },
			)
			if (current) {
				await coll.updateOne(
					{ _id: current._id },
					{ $set: { supersededBy: inserted.insertedId } },
					{ session },
				)
			}
			return {
				...pick(identity),
				version,
				status: current ? ("updated" as const) : ("created" as const),
				id: String(inserted.insertedId),
			}
		})
		receipts.push(
			redactionCount(redacted) > 0 ? { ...receipt, redacted } : receipt,
		)
	}
	return receipts
}

function redactDeep(value: unknown, found: Record<string, number>): unknown {
	if (typeof value === "string") {
		const r = redactSecrets(value)
		mergeRedactions(found, r.found)
		return r.text
	}
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, found))
	if (value && typeof value === "object" && !(value instanceof Date)) {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, found)
		return out
	}
	return value
}

/** Retires the current items of one source whose occurredAt falls in
 *  [from, to) and whose sourceId is not in presentIds: a connector that
 *  re-sends a complete window (a month of calendar events) is saying the
 *  rest no longer exist. Each gets a tombstone version (empty text,
 *  invalidAt) rather than a delete, like the Nextcloud connector's retired
 *  files, so the history stays and the item can come back. Items already
 *  retired are left alone. */
export async function retireMissingRawItems(
	handle: WikiDbHandle,
	params: {
		scope: string
		scopeRef: string
		source: string
		from: Date
		to: Date
		presentIds: string[]
		writer?: string
		/** Limit the window to one channel: a chat connector sends one
		 *  conversation's day at a time. */
		channel?: string
		/** Leave items with metadata.isReply alone. For sources that can list
		 *  every top-level message in a window but not every reply to an
		 *  older thread, an absent reply is not evidence of deletion. */
		excludeReplies?: boolean
	},
	runInTransaction: RunInTransaction,
): Promise<RawWriteReceipt[]> {
	const stale = await rawItemsCollection(handle.db, handle.prefix)
		.find(
			{
				scope: params.scope,
				scopeRef: params.scopeRef,
				source: params.source,
				current: true,
				occurredAt: { $gte: params.from, $lt: params.to },
				sourceId: { $nin: params.presentIds },
				text: { $ne: "" },
				...(params.channel ? { channel: params.channel } : {}),
				...(params.excludeReplies ? { "metadata.isReply": { $ne: true } } : {}),
			},
			{
				projection: {
					sourceId: 1,
					kind: 1,
					unit: 1,
					occurredAt: 1,
					channel: 1,
				},
			},
		)
		.toArray()
	const receipts: RawWriteReceipt[] = []
	const now = new Date()
	for (let i = 0; i < stale.length; i += RAW_ITEMS_MAX_BATCH) {
		const batch = stale.slice(i, i + RAW_ITEMS_MAX_BATCH).map((d) => ({
			source: params.source,
			sourceId: d.sourceId as string,
			kind: d.kind as RawItemKind,
			text: "",
			...(d.unit ? { unit: d.unit as string } : {}),
			// Kept, so the tombstone still sits in the window it left.
			occurredAt: d.occurredAt as Date,
			...(d.channel ? { channel: d.channel as string } : {}),
			invalidAt: now,
			metadata: { retired: true },
		}))
		receipts.push(
			...(await upsertRawItems(
				handle,
				batch,
				{
					scope: params.scope,
					scopeRef: params.scopeRef,
					writer: params.writer,
				},
				runInTransaction,
			)),
		)
	}
	return receipts
}

/** Current versions of the named items of one source. */
export async function listCurrentRawItems(
	handle: WikiDbHandle,
	params: {
		scope: string
		scopeRef: string
		source: string
		sourceIds: string[]
	},
): Promise<RawItemView[]> {
	if (params.sourceIds.length === 0) return []
	const docs = await rawItemsCollection(handle.db, handle.prefix)
		.find({
			scope: params.scope,
			scopeRef: params.scopeRef,
			source: params.source,
			sourceId: { $in: params.sourceIds },
			current: true,
		})
		.sort({ occurredAt: 1, sourceId: 1 })
		.toArray()
	return docs.map(toRawItemView)
}

export interface RawSourceActivity {
	source: string
	/** Current items from this source. */
	items: number
	/** When this host last received a new item or version from it. */
	lastReceivedAt?: string
	/** The newest thing it describes (a note edit, a message, an event). */
	lastOccurredAt?: string
}

/** Per source: how many current items, and when the last one arrived. The
 *  console uses it to show whether each connector is still delivering. */
export async function rawSourceActivity(
	handle: WikiDbHandle,
	params: { scope: string; scopeRef: string },
): Promise<RawSourceActivity[]> {
	const rows = await rawItemsCollection(handle.db, handle.prefix)
		.aggregate<{
			_id: string
			items: number
			lastReceivedAt?: Date
			lastOccurredAt?: Date
		}>([
			{ $match: { scope: params.scope, scopeRef: params.scopeRef } },
			{
				$group: {
					_id: "$source",
					items: { $sum: { $cond: ["$current", 1, 0] } },
					lastReceivedAt: { $max: "$createdAt" },
					lastOccurredAt: {
						$max: { $cond: ["$current", "$occurredAt", null] },
					},
				},
			},
			{ $sort: { lastReceivedAt: -1 } },
		])
		.toArray()
	return rows.map((r) => ({
		source: r._id,
		items: r.items,
		...(r.lastReceivedAt
			? { lastReceivedAt: r.lastReceivedAt.toISOString() }
			: {}),
		...(r.lastOccurredAt instanceof Date
			? { lastOccurredAt: r.lastOccurredAt.toISOString() }
			: {}),
	}))
}

function pick(identity: { source: string; sourceId: string }) {
	return { source: identity.source, sourceId: identity.sourceId }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function toRawItemView(doc: Document): RawItemView {
	const { _id, supersededBy, ...rest } = doc
	return {
		...(rest as Omit<RawItemView, "id" | "supersededBy">),
		id: String(_id as ObjectId),
		supersededBy: supersededBy ? String(supersededBy) : null,
	}
}

/** Every version of one item, newest first. */
export async function getRawItemHistory(
	handle: WikiDbHandle,
	params: { scope: string; scopeRef: string; source: string; sourceId: string },
): Promise<RawItemView[]> {
	const docs = await rawItemsCollection(handle.db, handle.prefix)
		.find(params)
		.sort({ version: -1 })
		.toArray()
	return docs.map(toRawItemView)
}

/** Current items of one distill unit, oldest first — what a distiller reads
 *  to build one digest. */
export async function listRawItemsInUnit(
	handle: WikiDbHandle,
	params: { scope: string; scopeRef: string; unit: string },
): Promise<RawItemView[]> {
	const docs = await rawItemsCollection(handle.db, handle.prefix)
		.find({ ...params, current: true })
		.sort({ occurredAt: 1, sourceId: 1 })
		.toArray()
	return docs.map(toRawItemView)
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface RawSearchParams {
	query: string
	scope: string
	scopeRef: string
	source?: string
	kind?: RawItemKind
	channel?: string
	thread?: string
	author?: string
	/** Inclusive bounds on occurredAt. */
	from?: string | Date
	to?: string | Date
	/** Also search superseded versions. */
	includeHistory?: boolean
	/** Default 10, at most 50. */
	limit?: number
	/** Same contract as WikiRerankFn; see createVoyageReranker. */
	rerank?: (
		query: string,
		docs: Array<{ text: string; score: number }>,
	) => Promise<Array<{ text: string; score: number }>>
}

export interface RawSearchResult {
	item: RawItemView
	score: number
	reranked: boolean
}

export const RAW_SEARCH_MAX_LIMIT = 50
/** Voyage rerank-2.5 reads up to 32k tokens per query+document; past this
 *  many characters the tail adds cost, not signal. */
const RERANK_DOC_CHARS = 8000

export function buildRawPrefilter(params: RawSearchParams): Document {
	const filter: Document = { scope: params.scope, scopeRef: params.scopeRef }
	if (!params.includeHistory) filter.current = true
	for (const field of [
		"source",
		"kind",
		"channel",
		"thread",
		"author",
	] as const) {
		if (params[field]) filter[field] = params[field]
	}
	const from = toDate(params.from, "from")
	const to = toDate(params.to, "to")
	if (from || to)
		filter.occurredAt = {
			...(from ? { $gte: from } : {}),
			...(to ? { $lte: to } : {}),
		}
	return filter
}

function buildTextCompound(query: string, prefilter: Document): Document {
	const filter: Document[] = []
	for (const [path, value] of Object.entries(prefilter)) {
		if (value && typeof value === "object" && !(value instanceof Date)) {
			const range: Document = { path }
			if ("$gte" in value) range.gte = value.$gte
			if ("$lte" in value) range.lte = value.$lte
			filter.push({ range })
		} else {
			filter.push({ equals: { path, value } })
		}
	}
	return { must: [{ text: { path: ["title", "text"], query } }], filter }
}

export async function searchRawItems(
	handle: WikiDbHandle,
	params: RawSearchParams,
): Promise<RawSearchResult[]> {
	const query = params.query?.trim()
	if (!query) throw new RawItemValidationError("query is required")
	const limit = Math.max(1, Math.min(RAW_SEARCH_MAX_LIMIT, params.limit ?? 10))
	const prefilter = buildRawPrefilter(params)
	const targets = RAW_ITEMS_SEARCH_INDEX_TARGETS
	const pipeline: Document[] = [
		{
			$rankFusion: {
				input: {
					pipelines: {
						vector: [
							{
								$vectorSearch: {
									index: targets.vector.name,
									query: { text: query },
									model: "voyage-4-large",
									path: "text",
									numCandidates: Math.max(limit * 20, 100),
									limit: limit * 4,
									filter: prefilter,
								},
							},
						],
						text: [
							{
								$search: {
									index: targets.text.name,
									compound: buildTextCompound(query, prefilter),
								},
							},
							{ $limit: limit * 4 },
						],
					},
				},
				combination: { weights: { vector: 1, text: 1 } },
				scoreDetails: true,
			},
		},
		{ $addFields: { searchScore: { $meta: "scoreDetails" } } },
		{ $limit: limit * (params.rerank ? 3 : 1) },
	]
	let docs: Document[]
	try {
		docs = await rawItemsCollection(handle.db, handle.prefix)
			.aggregate(pipeline)
			.toArray()
	} catch (err) {
		throw new RawSearchUnavailableError("raw search failed", { cause: err })
	}
	let results: RawSearchResult[] = docs.map((doc) => {
		const { searchScore, ...rest } = doc
		return {
			item: toRawItemView(rest),
			score:
				typeof searchScore?.value === "number"
					? (searchScore.value as number)
					: 0,
			reranked: false,
		}
	})
	if (params.rerank && results.length > 1) {
		const textOf = (r: RawSearchResult) =>
			`${r.item.title ?? ""}\n${r.item.text}`.slice(0, RERANK_DOC_CHARS)
		try {
			const reranked = await params.rerank(
				query,
				results.map((r) => ({ text: textOf(r), score: r.score })),
			)
			// Pair by the exact text sent, as wiki search does: the reranker
			// returns its own order and may drop or repeat documents.
			const byText = new Map<string, RawSearchResult[]>()
			for (const r of results) {
				const bucket = byText.get(textOf(r))
				if (bucket) bucket.push(r)
				else byText.set(textOf(r), [r])
			}
			const reordered: RawSearchResult[] = []
			for (const doc of reranked) {
				const match = byText.get(doc.text)?.shift()
				if (match)
					reordered.push({ ...match, score: doc.score, reranked: true })
			}
			results = [...reordered, ...[...byText.values()].flat()]
		} catch (err) {
			// Reranking is an enhancement: an outage keeps fusion order.
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`raw search rerank failed (${msg}); keeping fusion order`)
		}
	}
	return results.slice(0, limit)
}
