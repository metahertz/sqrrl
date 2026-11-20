// How the wiki reads as a library: pages grouped by where they came from,
// in an order a person browses (hubs first, then sources, then tasks).

import type { WikiPage } from "./shared.js"

export type WikiGroup = { id: string; label: string; pages: WikiPage[] }

const GROUPS: Array<{
	id: string
	label: string
	match: (slug: string) => boolean
}> = [
	{ id: "topics", label: "Topics", match: (s) => s.startsWith("topics/") },
	{ id: "people", label: "People", match: (s) => s.startsWith("people/") },
	{
		id: "orgs",
		label: "Teams and senders",
		match: (s) => s.startsWith("orgs/"),
	},
	{
		id: "meetings",
		label: "Meetings",
		match: (s) => s.startsWith("meetings/"),
	},
	{
		id: "apple-notes",
		label: "Apple Notes",
		match: (s) => s.startsWith("sources/apple-notes/"),
	},
	{
		id: "nextcloud",
		label: "Nextcloud",
		match: (s) => s.startsWith("sources/nextcloud/"),
	},
	{ id: "slack", label: "Slack", match: (s) => s.startsWith("sources/slack/") },
	{ id: "email", label: "Email", match: (s) => s.startsWith("sources/email/") },
	{ id: "notes", label: "Notes", match: (s) => s.startsWith("notes/") },
	{ id: "tasks", label: "Tasks", match: (s) => s.startsWith("tasks/") },
	{
		id: "sources",
		label: "Other sources",
		match: (s) => s.startsWith("sources/"),
	},
]

export function wikiGroupOf(slug: string): { id: string; label: string } {
	const g = GROUPS.find((x) => x.match(slug))
	return g ? { id: g.id, label: g.label } : { id: "other", label: "Other" }
}

/** Groups in browsing order, each sorted for reading: dated sources newest
 *  first (their slugs and update times say so), hubs alphabetically. */
export function groupWiki(pages: WikiPage[]): WikiGroup[] {
	const byId = new Map<string, WikiGroup>()
	for (const p of pages) {
		const g = wikiGroupOf(p.slug)
		const group = byId.get(g.id)
		if (group) group.pages.push(p)
		else byId.set(g.id, { ...g, pages: [p] })
	}
	const order = [...GROUPS.map((g) => g.id), "other"]
	const alphabetical = new Set(["topics", "people", "tasks"])
	return order
		.map((id) => byId.get(id))
		.filter((g): g is WikiGroup => Boolean(g))
		.map((g) => ({
			...g,
			pages: [...g.pages].sort((a, b) =>
				alphabetical.has(g.id)
					? a.title.localeCompare(b.title)
					: String(b.updatedAt ?? b.slug).localeCompare(
							String(a.updatedAt ?? a.slug),
						),
			),
		}))
}

/** The pages most linked to: the hubs worth starting from. */
export function mostLinked(pages: WikiPage[], n = 10): WikiPage[] {
	return [...pages]
		.filter((p) => (p.backlinks ?? []).length > 0)
		.sort((a, b) => (b.backlinks ?? []).length - (a.backlinks ?? []).length)
		.slice(0, n)
}

/** "#wiki/topics/oidc" <-> "topics/oidc". Slashes stay readable. */
export function wikiHash(slug?: string): string {
	return slug
		? `#wiki/${slug.split("/").map(encodeURIComponent).join("/")}`
		: "#wiki"
}

export function slugFromHash(hash: string): string | undefined {
	const m = hash.match(/^#?wiki\/(.+)$/)
	if (!m) return undefined
	try {
		return m[1].split("/").map(decodeURIComponent).join("/")
	} catch {
		return undefined
	}
}
