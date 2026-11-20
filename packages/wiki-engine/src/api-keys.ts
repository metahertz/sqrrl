// Database-backed scoped API keys.
//
// The env-based SQRRL_API_SCOPED_KEYS policy list requires a restart to
// change and keeps every token in plaintext in the process environment. This
// stores the same policy shape in MongoDB so keys can be issued and withdrawn
// while the API is running.
//
// Only the SHA-256 of a token is stored. The plaintext is returned once, by
// the route that mints it, and is unrecoverable afterwards: a database dump,
// a backup, or a read-only Atlas login yields nothing that can authenticate.
// The stored `prefix` exists so a key can still be identified in a list.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { Collection, Db } from "mongodb"
import { omitUndefined } from "./omit-undefined.js"

export const API_KEY_TOKEN_PREFIX = "mdb_sk_"
/** Shown in listings to identify a key whose secret is gone. Long enough to
 *  disambiguate, far too short to brute-force the remaining entropy. */
const DISPLAY_PREFIX_LENGTH = API_KEY_TOKEN_PREFIX.length + 6

export type ApiKeyScopeGrant = { scope: string; scopeRef: string }

export type ApiKeyRecord = {
	keyId: string
	prefix: string
	subjectId: string
	displayName?: string
	capabilities: string[]
	allowedScopes: ApiKeyScopeGrant[]
	allowedAgentIds: string[]
	trustTier: string
	createdAt: string
	createdBy: string
	expiresAt?: string
	revokedAt?: string
	revokedBy?: string
	lastUsedAt?: string
}

export type ApiKeyRecordWithSecret = ApiKeyRecord & { token: string }

export function apiKeysCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}api_keys`)
}

export function hashApiKeyToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Compares two hex digests without leaking position of the first difference.
 *  Used when a caller already holds a stored hash rather than a token. */
export function timingSafeHashEquals(a: string, b: string): boolean {
	if (!a || !b || a.length !== b.length) return false
	return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

function generateToken(): string {
	// 32 bytes base64url ~ 256 bits. Prefixed so a leaked string is
	// recognisable as an sqrrl key in logs and secret scanners.
	return API_KEY_TOKEN_PREFIX + randomBytes(32).toString("base64url")
}

function toRecord(doc: Record<string, unknown>): ApiKeyRecord {
	return {
		keyId: String(doc.keyId),
		prefix: String(doc.prefix),
		subjectId: String(doc.subjectId),
		...(doc.displayName ? { displayName: String(doc.displayName) } : {}),
		capabilities: (doc.capabilities as string[]) ?? [],
		allowedScopes: (doc.allowedScopes as ApiKeyScopeGrant[]) ?? [],
		allowedAgentIds: (doc.allowedAgentIds as string[]) ?? ["*"],
		trustTier: String(doc.trustTier ?? "standard"),
		createdAt: String(doc.createdAt),
		createdBy: String(doc.createdBy ?? "unknown"),
		...(doc.expiresAt ? { expiresAt: String(doc.expiresAt) } : {}),
		...(doc.revokedAt ? { revokedAt: String(doc.revokedAt) } : {}),
		...(doc.revokedBy ? { revokedBy: String(doc.revokedBy) } : {}),
		...(doc.lastUsedAt ? { lastUsedAt: String(doc.lastUsedAt) } : {}),
	}
}

/** A key authenticates only while it is neither revoked nor past its expiry.
 *  Both are checked at read time rather than by a sweep, so a key stops
 *  working the moment it expires even if nothing has run since. */
export function isApiKeyUsable(
	record: Pick<ApiKeyRecord, "revokedAt" | "expiresAt">,
	now = new Date(),
): boolean {
	if (record.revokedAt) return false
	if (record.expiresAt && new Date(record.expiresAt) <= now) return false
	return true
}

const TOKEN_HASH_INDEX = "tokenHash_unique"

export async function ensureApiKeyIndexes(
	db: Db,
	prefix: string,
): Promise<void> {
	const coll = apiKeysCollection(db, prefix)
	// A revoked key has no token hash, and a plain unique index counts every
	// missing hash as the same null: the second revocation then failed with
	// a duplicate key. Indexes made before the partial filter are replaced.
	let existing: Array<{ name?: string; partialFilterExpression?: unknown }> = []
	try {
		existing = (await coll.listIndexes().toArray()) as typeof existing
	} catch {
		// No collection yet (or a store without index listing): nothing to replace.
	}
	if (
		existing.some(
			(i) => i.name === TOKEN_HASH_INDEX && !i.partialFilterExpression,
		)
	)
		await coll.dropIndex(TOKEN_HASH_INDEX)
	await coll.createIndexes([
		// The authentication lookup: one indexed equality match per request,
		// unique among keys that still have a token.
		{
			key: { tokenHash: 1 },
			unique: true,
			name: TOKEN_HASH_INDEX,
			partialFilterExpression: { tokenHash: { $type: "string" } },
		},
		{ key: { keyId: 1 }, unique: true, name: "keyId_unique" },
		// subjectId identifies the principal in audit records and must not be
		// reused, or a revoked key's history merges with its replacement's.
		{ key: { subjectId: 1 }, unique: true, name: "subjectId_unique" },
		{ key: { createdAt: -1 }, name: "createdAt" },
	])
}

export async function listApiKeys(
	handle: { db: Db; prefix: string },
	opts: { includeRevoked?: boolean } = {},
): Promise<ApiKeyRecord[]> {
	const filter = opts.includeRevoked ? {} : { revokedAt: { $exists: false } }
	const docs = await apiKeysCollection(handle.db, handle.prefix)
		.find(filter, { projection: { tokenHash: 0, _id: 0 } })
		.sort({ createdAt: -1 })
		.toArray()
	return docs.map(toRecord)
}

export async function createApiKey(
	handle: { db: Db; prefix: string },
	input: {
		subjectId: string
		displayName?: string
		capabilities: string[]
		allowedScopes: ApiKeyScopeGrant[]
		allowedAgentIds?: string[]
		trustTier?: string
		expiresAt?: string
		createdBy: string
	},
): Promise<ApiKeyRecordWithSecret> {
	const token = generateToken()
	const now = new Date().toISOString()
	const record: ApiKeyRecord = {
		keyId: randomBytes(8).toString("hex"),
		prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
		subjectId: input.subjectId,
		...(input.displayName ? { displayName: input.displayName } : {}),
		capabilities: [...new Set(input.capabilities)],
		allowedScopes: input.allowedScopes,
		allowedAgentIds: input.allowedAgentIds ?? ["*"],
		trustTier: input.trustTier ?? "standard",
		createdAt: now,
		createdBy: input.createdBy,
		...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
	}
	await apiKeysCollection(handle.db, handle.prefix).insertOne(
		omitUndefined({ ...record, tokenHash: hashApiKeyToken(token) }),
	)
	return { ...record, token }
}

/** Resolves a bearer token to its record. Returns null for unknown, revoked
 *  and expired tokens alike, so the caller cannot distinguish them. */
export async function findApiKeyByToken(
	handle: { db: Db; prefix: string },
	token: string,
	now = new Date(),
): Promise<ApiKeyRecord | null> {
	if (!token) return null
	const doc = await apiKeysCollection(handle.db, handle.prefix).findOne({
		tokenHash: hashApiKeyToken(token),
	})
	if (!doc) return null
	const record = toRecord(doc as Record<string, unknown>)
	return isApiKeyUsable(record, now) ? record : null
}

export async function revokeApiKey(
	handle: { db: Db; prefix: string },
	keyId: string,
	revokedBy: string,
): Promise<ApiKeyRecord | null> {
	// Soft: the row stays as the record that this key existed and when it was
	// withdrawn. The token hash is dropped in the same update, so the row that
	// remains cannot authenticate even if the revocation check regressed.
	const doc = await apiKeysCollection(
		handle.db,
		handle.prefix,
	).findOneAndUpdate(
		{ keyId, revokedAt: { $exists: false } },
		{
			$set: { revokedAt: new Date().toISOString(), revokedBy },
			$unset: { tokenHash: "" },
		},
		{ returnDocument: "after", projection: { tokenHash: 0, _id: 0 } },
	)
	return doc ? toRecord(doc as Record<string, unknown>) : null
}

export async function updateApiKey(
	handle: { db: Db; prefix: string },
	keyId: string,
	patch: {
		displayName?: string
		capabilities?: string[]
		allowedScopes?: ApiKeyScopeGrant[]
		allowedAgentIds?: string[]
		trustTier?: string
		expiresAt?: string | null
	},
): Promise<ApiKeyRecord | null> {
	const set: Record<string, unknown> = {}
	const unset: Record<string, string> = {}
	if (patch.displayName !== undefined) set.displayName = patch.displayName
	if (patch.capabilities) set.capabilities = [...new Set(patch.capabilities)]
	if (patch.allowedScopes) set.allowedScopes = patch.allowedScopes
	if (patch.allowedAgentIds) set.allowedAgentIds = patch.allowedAgentIds
	if (patch.trustTier) set.trustTier = patch.trustTier
	// null clears the expiry (making the key perpetual); undefined leaves it.
	if (patch.expiresAt === null) unset.expiresAt = ""
	else if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt

	const doc = await apiKeysCollection(
		handle.db,
		handle.prefix,
	).findOneAndUpdate(
		{ keyId, revokedAt: { $exists: false } },
		{
			...(Object.keys(set).length ? { $set: omitUndefined(set) } : {}),
			...(Object.keys(unset).length ? { $unset: unset } : {}),
		},
		{ returnDocument: "after", projection: { tokenHash: 0, _id: 0 } },
	)
	return doc ? toRecord(doc as Record<string, unknown>) : null
}

/** Best-effort usage stamp. Never awaited on the request path: a slow or
 *  failed write must not turn a valid request into a 500. */
export function touchApiKeyLastUsed(
	handle: { db: Db; prefix: string },
	keyId: string,
): void {
	void apiKeysCollection(handle.db, handle.prefix)
		.updateOne({ keyId }, { $set: { lastUsedAt: new Date().toISOString() } })
		.catch(() => {})
}
