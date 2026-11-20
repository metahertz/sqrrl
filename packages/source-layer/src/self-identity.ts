// Who "me" is: the owner of the brain, per scope.
//
//   identity_self   one document per scope: the owner's person hub, the
//                   names they go by ("Matt", "Matt Hollis") and their
//                   addresses.
//
// With it, a reference to one of those names or addresses resolves to the
// owner's hub without asking (people.ts), and answers treat it as "you"
// (apps/api/src/lib/answer-people.ts). Saving also applies it to what is
// already there: hubs carrying the owner's address or name merge into the
// owner's hub, and "same person?" questions about them are settled.

import {
	updateWikiPage,
	type WikiDbHandle,
	wikiPagesCollection,
} from "@sqrrl/wiki-engine"
import { cleanName, nameKey, normalizeEmail } from "./identity.js"
import { acceptIdentitySuggestion, mergePersonHubs } from "./identity-decide.js"
import { identitySuggestionsCollection } from "./identity-suggestions.js"
import { invalidatePeopleDirectory } from "./people.js"
import {
	getSelfIdentity,
	invalidateSelfIdentity,
	type SelfIdentity,
	selfIdentityCollection,
	selfKeys,
} from "./self.js"

export type { SelfIdentity }

type Scope = { scope: string; scopeRef: string }

const MAX_NAMES = 10
const MAX_EMAILS = 10

export class SelfIdentityError extends Error {}

/** Validates the input; throws SelfIdentityError with a user-facing reason. */
export function readSelfInput(b: Record<string, unknown>): {
	personSlug: string
	names: string[]
	emails: string[]
} {
	const personSlug = typeof b.personSlug === "string" ? b.personSlug.trim() : ""
	if (!personSlug.startsWith("people/"))
		throw new SelfIdentityError("personSlug must be a people/ page")
	const list = (v: unknown) =>
		(Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [])
			.map((x) => String(x).trim())
			.filter(Boolean)
	const names = [...new Set(list(b.names).map((n) => cleanName(n)))]
	if (!names.length) throw new SelfIdentityError("give at least one name")
	if (names.length > MAX_NAMES)
		throw new SelfIdentityError(`at most ${MAX_NAMES} names`)
	const emails: string[] = []
	for (const raw of list(b.emails)) {
		const e = normalizeEmail(raw)
		if (!e) throw new SelfIdentityError(`not an email address: ${raw}`)
		if (!emails.includes(e)) emails.push(e)
	}
	if (emails.length > MAX_EMAILS)
		throw new SelfIdentityError(`at most ${MAX_EMAILS} addresses`)
	return { personSlug, names, emails }
}

export interface SelfApplyResult {
	merged: string[]
	questionsSettled: number
}

/** Saves the owner's identity and applies it to existing hubs. */
export async function saveSelfIdentity(
	handle: WikiDbHandle,
	p: Scope & {
		personSlug: string
		names: string[]
		emails: string[]
		editor?: { subjectId: string }
	},
): Promise<{ self: SelfIdentity; applied: SelfApplyResult }> {
	const pages = wikiPagesCollection(handle.db, handle.prefix)
	const hub = await pages.findOne(
		{
			scope: p.scope,
			scopeRef: p.scopeRef,
			slug: p.personSlug,
			state: { $ne: "superseded" },
		},
		{ projection: { slug: 1, title: 1, personCard: 1 } },
	)
	if (!hub) throw new SelfIdentityError(`no person page "${p.personSlug}"`)
	const now = new Date()
	await selfIdentityCollection(handle.db, handle.prefix).updateOne(
		{ scope: p.scope, scopeRef: p.scopeRef },
		{
			$set: {
				personSlug: p.personSlug,
				names: p.names,
				emails: p.emails,
				updatedAt: now,
				...(p.editor ? { updatedBy: p.editor.subjectId } : {}),
			},
		},
		{ upsert: true },
	)
	invalidateSelfIdentity(handle)

	// The hub learns the names and addresses, so ordinary matching finds it.
	const { full } = selfKeys(p)
	const card = (hub.personCard ?? {}) as Record<string, unknown>
	await updateWikiPage(handle, p.personSlug, p.scope, p.scopeRef, {
		personCard: {
			...card,
			canonicalId: (card.canonicalId as string) ?? p.personSlug,
			emails: [...new Set([...((card.emails as string[]) ?? []), ...p.emails])],
			aliases: [...new Set([...((card.aliases as string[]) ?? []), ...full])],
			self: true,
		} as never,
	})

	// Other hubs that are the owner: their address, or one of their names
	// as the whole title ("Matt" as a first-name hub).
	const self = { names: p.names, emails: p.emails }
	const { first } = selfKeys(self)
	const others = await pages
		.find(
			{
				scope: p.scope,
				scopeRef: p.scopeRef,
				slug: { $regex: "^people/", $ne: p.personSlug },
				state: { $ne: "superseded" },
				deleted: { $ne: true },
			},
			{ projection: { slug: 1, title: 1, personCard: 1 } },
		)
		.toArray()
	const merged: string[] = []
	for (const o of others) {
		const emails = ((o.personCard?.emails as string[]) ?? []).map((e) =>
			e.toLowerCase(),
		)
		const key = nameKey(cleanName(String(o.title ?? "")))
		const mine =
			emails.some((e) => p.emails.includes(e)) ||
			(emails.length === 0 && (full.has(key) || first.has(key)))
		if (!mine) continue
		await mergePersonHubs(handle, {
			scope: p.scope,
			scopeRef: p.scopeRef,
			from: o.slug,
			into: p.personSlug,
			...(p.editor ? { editor: p.editor } : {}),
		})
		merged.push(o.slug)
	}

	// Questions about a merged hub, or offering the owner as a candidate for
	// one of their names, are settled in the owner's favor.
	const qs = identitySuggestionsCollection(handle.db, handle.prefix)
	const pending = await qs
		.find({ scope: p.scope, scopeRef: p.scopeRef, status: "pending" })
		.toArray()
	let questionsSettled = 0
	for (const q of pending) {
		const aboutMerged = merged.includes(String(q.subjectSlug))
		const offersSelf =
			q.kind === "link" &&
			((q.candidates as Array<{ slug: string }>) ?? []).some(
				(c) => c.slug === p.personSlug,
			) &&
			first.has(nameKey(String(q.subjectTitle ?? "")))
		if (!aboutMerged && !offersSelf) continue
		if (!aboutMerged) {
			// The link still points at the first-name hub: move it.
			await acceptIdentitySuggestion(handle, {
				scope: p.scope,
				scopeRef: p.scopeRef,
				id: String(q._id),
				chosen: p.personSlug,
				...(p.editor ? { editor: p.editor } : {}),
			})
			questionsSettled++
			continue
		}
		await qs.updateOne(
			{ _id: q._id, status: "pending" },
			{
				$set: {
					status: "accepted",
					chosen: p.personSlug,
					decidedAt: now,
					updatedAt: now,
					decidedBy: p.editor?.subjectId ?? "self-identity",
				},
			},
		)
		questionsSettled++
	}
	invalidatePeopleDirectory(handle)
	const saved = await getSelfIdentity(handle, p)
	return {
		self: saved as SelfIdentity,
		applied: { merged, questionsSettled },
	}
}
