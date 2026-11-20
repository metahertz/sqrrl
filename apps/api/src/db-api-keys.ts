// Bridges stored API keys into request authentication.
//
// Authentication runs on every /v1 request, so a database round-trip per
// request would put Atlas latency in front of every call. Resolved tokens are
// cached for a short window and the cache is dropped outright whenever a key
// is created, updated or revoked, so a revocation takes effect immediately
// rather than after the TTL.

import {
	findApiKeyByToken,
	touchApiKeyLastUsed,
	type ApiKeyRecord,
} from "@sqrrl/wiki-engine"
import { principalFromApiKeyRecord, type ApiPrincipal } from "./principal.js"
import { getWikiStoreHandle } from "./wiki-store-runtime.js"

const CACHE_TTL_MS = Number(process.env.SQRRL_API_KEY_CACHE_MS ?? 10_000)

type CacheEntry = { principal: ApiPrincipal | null; keyId?: string; at: number }

const cache = new Map<string, CacheEntry>()

/** Called after any mutation so a withdrawn key cannot survive in cache. */
export function invalidateApiKeyCache(): void {
	cache.clear()
}

/** Resolves a bearer against the stored keys.
 *
 *  Returns null for unknown, revoked and expired tokens alike. Negative
 *  results are cached too: without that, a wrong token retried in a loop
 *  becomes an unbounded stream of database queries.
 *
 *  A database outage yields null (request is rejected) rather than an
 *  exception, so a Mongo problem shows up as 401 rather than 500 — and never
 *  as an accidental grant. */
export async function resolveStoredKeyPrincipal(
	bearer: string,
): Promise<ApiPrincipal | null> {
	if (!bearer) return null
	const now = Date.now()
	const hit = cache.get(bearer)
	if (hit && now - hit.at < CACHE_TTL_MS) {
		if (hit.principal && hit.keyId) void stampUsage(hit.keyId)
		return hit.principal
	}
	let record: ApiKeyRecord | null = null
	try {
		const handle = await getWikiStoreHandle()
		record = await findApiKeyByToken(handle, bearer)
	} catch {
		return null
	}
	const principal = record ? principalFromApiKeyRecord(record) : null
	cache.set(bearer, {
		principal,
		...(record ? { keyId: record.keyId } : {}),
		at: now,
	})
	if (record && principal) void stampUsage(record.keyId)
	return principal
}

async function stampUsage(keyId: string): Promise<void> {
	try {
		touchApiKeyLastUsed(await getWikiStoreHandle(), keyId)
	} catch {
		// Usage stamping is diagnostic only; never fail a request for it.
	}
}
