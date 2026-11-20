// Acting on a "same person?" suggestion (identity-suggestions.ts).
//
//   link  -> the one link moves from the first-name hub to the chosen person;
//   merge -> the subject hub is merged into the chosen one, addresses and
//            names carried over so later references resolve directly.
// Dismissing changes nothing and keeps the question from coming back.

import {
	addRelationships,
	mergePages,
	removeRelationships,
	updateWikiPage,
	type WikiDbHandle,
	wikiPagesCollection,
} from "@sqrrl/wiki-engine"
import { isServiceEmail } from "./identity.js"
import {
	decideIdentitySuggestion,
	getIdentitySuggestion,
	type IdentitySuggestion,
} from "./identity-suggestions.js"
import { hubEntry, invalidatePeopleDirectory } from "./people.js"

export class IdentityDecisionError extends Error {
	constructor(
		readonly code: "NOT_FOUND" | "NOT_PENDING" | "BAD_CHOICE" | "GONE",
		message: string,
	) {
		super(message)
	}
}

type Scope = { scope: string; scopeRef: string }

/** Folds one person hub into another, keeping its addresses and names. */
export async function mergePersonHubs(
	handle: WikiDbHandle,
	p: Scope & { from: string; into: string; editor?: { subjectId: string } },
): Promise<void> {
	const coll = wikiPagesCollection(handle.db, handle.prefix)
	const [from, into] = await Promise.all(
		[p.from, p.into].map((slug) =>
			coll.findOne(
				{
					scope: p.scope,
					scopeRef: p.scopeRef,
					slug,
					state: { $ne: "superseded" },
				},
				{ projection: { slug: 1, title: 1, personCard: 1 } },
			),
		),
	)
	if (!from || !into)
		throw new IdentityDecisionError(
			"GONE",
			`${!from ? p.from : p.into} no longer exists`,
		)
	const a = hubEntry(from as never)
	const b = hubEntry(into as never)
	const card = (into.personCard ?? {}) as Record<string, unknown>
	const emails = [...new Set([...b.emails, ...a.emails])].filter(
		(e) => !isServiceEmail(e),
	)
	const aliases = [...new Set([...b.keys, ...a.keys])]
	await updateWikiPage(handle, p.into, p.scope, p.scopeRef, {
		personCard: {
			...card,
			canonicalId: (card.canonicalId as string) ?? p.into,
			emails,
			...(aliases.length ? { aliases } : {}),
		} as never,
	})
	await mergePages(handle, {
		from: p.from,
		into: p.into,
		scope: p.scope,
		scopeRef: p.scopeRef,
		...(p.editor ? { editor: p.editor as never } : {}),
	})
	invalidatePeopleDirectory(handle)
}

export async function acceptIdentitySuggestion(
	handle: WikiDbHandle,
	p: Scope & { id: string; chosen: string; editor?: { subjectId: string } },
): Promise<IdentitySuggestion> {
	const s = await getIdentitySuggestion(handle, p)
	if (!s) throw new IdentityDecisionError("NOT_FOUND", "no such suggestion")
	if (s.status !== "pending")
		throw new IdentityDecisionError("NOT_PENDING", `already ${s.status}`)
	if (!s.candidates.some((c) => c.slug === p.chosen))
		throw new IdentityDecisionError(
			"BAD_CHOICE",
			`"${p.chosen}" is not one of the candidates`,
		)
	const chosen = s.candidates.find((c) => c.slug === p.chosen)
	if (s.kind === "link") {
		if (!s.fromSlug || !s.edgeKind)
			throw new IdentityDecisionError("GONE", "the suggestion has no link")
		await addRelationships(handle, s.fromSlug, p.scope, p.scopeRef, [
			{
				targetPageSlug: p.chosen,
				targetTitle: chosen?.title ?? p.chosen,
				kind: s.edgeKind,
				weight: 1,
				confidence: 1,
			},
		])
		await removeRelationships(handle, s.fromSlug, p.scope, p.scopeRef, [
			{ targetPageSlug: s.subjectSlug, kind: s.edgeKind },
		])
	} else {
		await mergePersonHubs(handle, {
			...p,
			from: s.subjectSlug,
			into: p.chosen,
		})
	}
	await decideIdentitySuggestion(handle, {
		...p,
		status: "accepted",
		chosen: p.chosen,
		...(p.editor ? { decidedBy: p.editor.subjectId } : {}),
	})
	return { ...s, status: "accepted", chosen: p.chosen }
}

export async function dismissIdentitySuggestion(
	handle: WikiDbHandle,
	p: Scope & { id: string; editor?: { subjectId: string } },
): Promise<void> {
	const ok = await decideIdentitySuggestion(handle, {
		...p,
		status: "dismissed",
		...(p.editor ? { decidedBy: p.editor.subjectId } : {}),
	})
	if (!ok) {
		const s = await getIdentitySuggestion(handle, p)
		throw s
			? new IdentityDecisionError("NOT_PENDING", `already ${s.status}`)
			: new IdentityDecisionError("NOT_FOUND", "no such suggestion")
	}
}
