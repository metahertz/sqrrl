// Link a page to the people in it through the shared resolver (people.ts),
// for connectors that run outside the API (Slack). The same rules as email
// and calendar: an email or a full name finds the existing hub, a short or
// first name uses the others on the page as context, an ambiguous one links
// the first-name hub and asks, and the owner of the brain is never minted.
//
// A new person page is created only for someone marked `create` (a Slack
// speaker, an email sender), and only when the page names few enough people
// that it is a conversation rather than a broadcast.

import {
	addRelationships,
	type WikiDbHandle,
	type WikiRelationshipSpec,
} from "@sqrrl/wiki-engine"
import { resolvePersonHub } from "./people.js"

export const DEFAULT_LINK_MAX_NEW_PEOPLE = 6
const MAX_PEOPLE = 200

export interface LinkPerson {
	name?: string
	email?: string
	/** May create a person page if no hub matches. */
	create?: boolean
	/** Edge weight, default 0.6. */
	weight?: number
}

export interface LinkPeopleInput {
	scope: string
	scopeRef: string
	slug: string
	title?: string
	/** Edge kind, default "participant". */
	edgeKind?: string
	people: LinkPerson[]
	/** Above this many distinct people, nobody new is created. */
	maxNewPeople?: number
	trustTier?: string
}

export interface LinkPeopleResult {
	linked: number
	created: number
	/** Per input person: the hub it resolved to, or null. */
	resolved: Array<{ slug: string; title: string } | null>
}

export class LinkPeopleError extends Error {}

/** Validates a request body into LinkPerson entries. */
export function readLinkPeople(raw: unknown): LinkPerson[] {
	if (!Array.isArray(raw)) throw new LinkPeopleError("people must be an array")
	if (raw.length > MAX_PEOPLE)
		throw new LinkPeopleError(`at most ${MAX_PEOPLE} people per call`)
	return raw.map((p, i) => {
		const o = (p ?? {}) as Record<string, unknown>
		const name = typeof o.name === "string" ? o.name.trim() : ""
		const email = typeof o.email === "string" ? o.email.trim() : ""
		if (!name && !email)
			throw new LinkPeopleError(`people[${i}] needs a name or an email`)
		const weight = Number(o.weight)
		return {
			...(name ? { name } : {}),
			...(email ? { email } : {}),
			...(o.create === true ? { create: true } : {}),
			...(Number.isFinite(weight) && weight > 0 && weight <= 1
				? { weight }
				: {}),
		}
	})
}

export async function linkPeopleToPage(
	handle: WikiDbHandle,
	input: LinkPeopleInput,
): Promise<LinkPeopleResult> {
	const { scope, scopeRef, slug } = input
	const kind = input.edgeKind ?? "participant"
	const distinct = new Set(
		input.people.map((p) => (p.email ?? p.name ?? "").toLowerCase()),
	)
	const small =
		distinct.size <= (input.maxNewPeople ?? DEFAULT_LINK_MAX_NEW_PEOPLE)
	// Full references first, so "Taylor" later on can lean on them.
	const order = input.people
		.map((p, i) => ({ p, i }))
		.sort((a, b) => score(b.p) - score(a.p))
	const edges: WikiRelationshipSpec[] = []
	const resolved: LinkPeopleResult["resolved"] = input.people.map(() => null)
	let created = 0
	for (const { p, i } of order) {
		const hub = await resolvePersonHub(
			handle,
			{ name: p.name, email: p.email },
			{
				scope,
				scopeRef,
				trustTier: input.trustTier,
				allowCreate: Boolean(p.create) && small,
				context: edges.map((e) => e.targetPageSlug),
				from: {
					slug,
					...(input.title ? { title: input.title } : {}),
					edgeKind: kind,
				},
			},
		)
		if (!hub) continue
		if (hub.created) created++
		resolved[i] = { slug: hub.slug, title: hub.title }
		if (edges.some((e) => e.targetPageSlug === hub.slug)) continue
		edges.push({
			targetPageSlug: hub.slug,
			targetTitle: hub.title,
			kind,
			weight: p.weight ?? 0.6,
			confidence: p.email ? 0.9 : 0.7,
		})
	}
	const linked = await addRelationships(handle, slug, scope, scopeRef, edges)
	return { linked, created, resolved }
}

function score(p: LinkPerson): number {
	return (p.email ? 2 : 0) + ((p.name ?? "").includes(" ") ? 1 : 0)
}
