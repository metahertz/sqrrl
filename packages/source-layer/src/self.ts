// Who "me" is, read side: the owner's identity per scope and whether a
// reference is them. Kept apart from saving (self-identity.ts) so the
// resolver (people.ts) can use it without an import cycle.

import type { Collection, Db } from "mongodb"
import type { WikiDbHandle } from "@sqrrl/wiki-engine"
import { cleanName, nameKey, type ParsedRef } from "./identity.js"

export interface SelfIdentity {
	scope: string
	scopeRef: string
	/** The owner's person hub. */
	personSlug: string
	/** Names the owner goes by, as entered ("Matt", "Matt Hollis"). */
	names: string[]
	emails: string[]
	updatedAt?: string
	updatedBy?: string
}

type Scope = { scope: string; scopeRef: string }

export function selfIdentityCollection(db: Db, prefix: string): Collection {
	return db.collection(`${prefix}identity_self`)
}

const TTL_MS = 60_000
const cache = new WeakMap<
	object,
	Map<string, { at: number; v: SelfIdentity | null }>
>()
const cacheOf = (h: WikiDbHandle): object => (h.db as object | undefined) ?? h

export function invalidateSelfIdentity(handle: WikiDbHandle): void {
	cache.delete(cacheOf(handle))
}

export async function getSelfIdentity(
	handle: WikiDbHandle,
	p: Scope,
): Promise<SelfIdentity | null> {
	const byScope = cache.get(cacheOf(handle)) ?? new Map()
	cache.set(cacheOf(handle), byScope)
	const id = `${handle.prefix}|${p.scope}|${p.scopeRef}`
	const hit = byScope.get(id)
	if (hit && Date.now() - hit.at < TTL_MS) return hit.v
	const d = await selfIdentityCollection(handle.db, handle.prefix).findOne({
		scope: p.scope,
		scopeRef: p.scopeRef,
	})
	const v: SelfIdentity | null = d
		? {
				scope: p.scope,
				scopeRef: p.scopeRef,
				personSlug: String(d.personSlug),
				names: (d.names as string[]) ?? [],
				emails: (d.emails as string[]) ?? [],
				...(d.updatedAt instanceof Date
					? { updatedAt: d.updatedAt.toISOString() }
					: {}),
				...(d.updatedBy ? { updatedBy: String(d.updatedBy) } : {}),
			}
		: null
	byScope.set(id, { at: Date.now(), v })
	return v
}

/** Name keys and first names the owner answers to. */
export function selfKeys(self: Pick<SelfIdentity, "names">): {
	full: Set<string>
	first: Set<string>
} {
	const full = new Set<string>()
	const first = new Set<string>()
	for (const n of self.names) {
		const k = nameKey(cleanName(n))
		if (!k) continue
		if (k.includes(" ")) {
			full.add(k)
			first.add(k.split(" ")[0])
		} else first.add(k)
	}
	return { full, first }
}

/** True when a parsed reference is the owner: one of their addresses, one
 *  of their full names, or one of their first names on its own. */
export function isSelfRef(
	self: Pick<SelfIdentity, "names" | "emails"> | null | undefined,
	ref: ParsedRef,
): boolean {
	if (!self || ref.kind !== "person") return false
	if (ref.email) return self.emails.includes(ref.email)
	const { full, first } = selfKeys(self)
	if (ref.key && full.has(ref.key)) return true
	return ref.firstOnly && Boolean(ref.first) && first.has(ref.first ?? "")
}
