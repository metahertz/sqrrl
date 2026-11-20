// People in a question, for POST /v1/wiki/answer.
//
// Search matches words, so "What does Taylor owe me?" misses pages that say
// "taylor.morgan@acme.example" or link Taylor only through a person hub. This
// finds the people a question names (packages/source-layer
// people-mentions.ts) and gives the answer:
//   - their most recently updated linked pages (tasks they own, meetings,
//     threads), read through the caller's governance like any page;
//   - raw search queries with the full name in place of a partial one;
//   - a "who is who" note, including names that fit several people.

import {
	describeMentions,
	findPeopleMentions,
	getSelfIdentity,
	nameKey,
	type PersonMention,
	peopleDirectory,
	type SelfIdentity,
	selfKeys,
} from "@sqrrl/source-layer"
import {
	getWikiPage,
	type WikiDbHandle,
	type WikiPageView,
	wikiPagesCollection,
} from "@sqrrl/wiki-engine"

/** Linked pages per person, and per candidate of an ambiguous name. */
const PAGES_PER_PERSON = 4
const PAGES_PER_CANDIDATE = 2
const MAX_PERSON_PAGES = 8

export interface PeopleContext {
	mentions: PersonMention[]
	/** Prompt lines on who is who; empty when the question names nobody. */
	note: string
	/** Extra raw queries (the question with full names spelled out). */
	rawQueries: string[]
	pages: WikiPageView[]
	/** The owner's person page, when known. */
	selfSlug?: string
}

export async function peopleContext(
	handle: WikiDbHandle,
	p: {
		query: string
		scope: string
		scopeRef: string
		governance?: Parameters<typeof getWikiPage>[4]
	},
): Promise<PeopleContext> {
	const { entries } = await peopleDirectory(handle, p.scope, p.scopeRef)
	const self = await getSelfIdentity(handle, p).catch(() => null)
	const selfEntry = self
		? entries.find((e) => e.slug === self.personSlug)
		: undefined
	// A name the owner goes by is the owner, even where it could be someone
	// else ("Matt" with two Matts known).
	const selfFirst = self ? selfKeys(self).first : new Set<string>()
	const mentions = findPeopleMentions(entries, p.query).map((m) =>
		selfEntry &&
		!m.person &&
		m.candidates?.some((c) => c.slug === selfEntry.slug) &&
		selfFirst.has(nameKey(m.text))
			? { ...m, person: selfEntry, candidates: undefined }
			: m,
	)
	const isSelf = (m: PersonMention) => m.person?.slug === selfEntry?.slug
	const selfLine = selfEntry && self ? ownerLine(selfEntry.title, self) : ""
	const others = mentions.filter((m) => !isSelf(m))
	const note = [
		selfLine,
		...mentions
			.filter(isSelf)
			.map((m) => `- "${m.text}" in the question is you, the person asking.`),
		others.length ? describeMentions(others) : "",
	]
		.filter(Boolean)
		.join("\n")
	const selfSlug = selfEntry?.slug
	if (!others.length)
		return { mentions, note, rawQueries: [], pages: [], selfSlug }

	const rawQueries = others
		.filter((m) => m.person && !m.exact)
		.map((m) => p.query.replace(m.text, m.person?.title ?? m.text))

	const hubs = others.flatMap((m) =>
		m.person
			? [{ slug: m.person.slug, n: PAGES_PER_PERSON }]
			: (m.candidates ?? []).map((c) => ({
					slug: c.slug,
					n: PAGES_PER_CANDIDATE,
				})),
	)
	const coll = wikiPagesCollection(handle.db, handle.prefix)
	const pages: WikiPageView[] = []
	const seen = new Set<string>()
	for (const hub of hubs) {
		if (pages.length >= MAX_PERSON_PAGES) break
		// Pages linking to the hub, newest first. Read through getWikiPage so
		// governance applies exactly as it does to search hits.
		const recent = await coll
			.find(
				{
					scope: p.scope,
					scopeRef: p.scopeRef,
					"relationships.targetPageSlug": hub.slug,
					deleted: { $ne: true },
					state: { $ne: "superseded" },
				},
				{ projection: { slug: 1 }, sort: { updatedAt: -1 }, limit: hub.n * 2 },
			)
			.toArray()
		let taken = 0
		for (const r of recent) {
			if (taken >= hub.n || pages.length >= MAX_PERSON_PAGES) break
			if (seen.has(r.slug)) continue
			const page = await getWikiPage(
				handle,
				r.slug,
				p.scope,
				p.scopeRef,
				p.governance,
			)
			if (!page) continue
			seen.add(r.slug)
			pages.push(page)
			taken++
		}
	}
	return { mentions, note, rawQueries, pages, selfSlug }
}

/** The prompt line that says who "you" is. */
export function ownerLine(
	title: string,
	self: Pick<SelfIdentity, "names" | "emails">,
): string {
	const also = [...new Set([...self.names, ...self.emails])].filter(
		(x) => x !== title,
	)
	return `- You are answering ${title}${also.length ? ` (also written ${also.join(", ")})` : ""}: evidence naming them is about the person asking, so say "you".`
}
