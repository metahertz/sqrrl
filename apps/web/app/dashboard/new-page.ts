// Creating hub pages by hand from the graph editor.
//
// Only the two hub kinds are offered. The engine creates these itself
// (ensureHubPage in wiki-engine/src/wiki-hubs.ts) whenever a note names a topic or a task
// names an owner, so a hand-made one is the same object arriving by a
// different route. The other kinds are not hand-made: a "source" is a note
// that was ingested, a "procedure" is a task that was extracted from one, and
// typing either by hand produces a page that the next ingestion pass has no
// way to reconcile with the file or task it claims to represent.
//
// Everything here mirrors ensureHubPage exactly — slug prefix, frontmatter
// type, empty body, standard trust tier — so a page made here is
// indistinguishable from one the engine made.

import type { WikiPage } from "./shared.js"

export type NewPageKind = {
	/** Value in the picker, and the label shown beside it. */
	id: "topic" | "person"
	label: string
	/** The wiki page kind. "topic" and "concept" are the same thing: concept is
	 *  the kind, topic is the frontmatter type, and the dashboard cards call it
	 *  "topics". */
	kind: "concept" | "entity"
	frontmatterType: "topic" | "person"
	prefix: string
	summary: (title: string) => string
}

export const NEW_PAGE_KINDS: NewPageKind[] = [
	{
		id: "topic",
		label: "topic",
		kind: "concept",
		frontmatterType: "topic",
		prefix: "topics/",
		summary: (t) => `Topic hub for ${t}. Sources referencing it link here.`,
	},
	{
		id: "person",
		label: "person",
		kind: "entity",
		frontmatterType: "person",
		prefix: "people/",
		summary: (t) => `Person hub for ${t}. Tasks they own link here.`,
	},
]

/** Slug length the engine uses for hub pages. */
const MAX_SLUG_LEN = 48

/** Mirrors slugify in source-layer/src/tasks.ts. It has to agree exactly:
 *  if this produced a different slug for the same title, the engine would
 *  create a second hub next to the hand-made one the first time a note
 *  mentioned the topic. */
export function slugify(text: string, maxLen = MAX_SLUG_LEN): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, maxLen)
			.replace(/-+$/, "") || "untitled"
	)
}

export type NewPageDraft = {
	kind: string
	title: string
	slug: string
	summary: string
	body: string
	frontmatter: { type: string }
	trustTier: string
}

export function buildNewPage(kind: NewPageKind, title: string): NewPageDraft {
	const clean = title.trim()
	return {
		kind: kind.kind,
		title: clean,
		slug: `${kind.prefix}${slugify(clean)}`,
		summary: kind.summary(clean),
		body: "",
		frontmatter: { type: kind.frontmatterType },
		trustTier: "standard",
	}
}

/** Why a draft cannot be created, or null when it can.
 *
 *  The collision check matters more than it looks: wikiApply is an UPSERT, so
 *  a create against an existing slug silently becomes an update and replaces
 *  that page's summary with the generic hub line. Refusing here keeps the
 *  button from quietly rewriting a hub that already has content.
 *
 *  This can only see pages already loaded, so it is a guard against the
 *  common case, not a lock — the server still decides. */
export function validateNewPage(
	kind: NewPageKind,
	title: string,
	existing: WikiPage[],
): string | null {
	const clean = title.trim()
	if (!clean) return "Give it a title."
	const slug = `${kind.prefix}${slugify(clean)}`
	const clash = existing.find((p) => p.slug === slug)
	if (clash) return `"${clash.title}" already uses ${slug}.`
	return null
}
