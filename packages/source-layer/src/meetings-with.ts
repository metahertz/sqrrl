// Every calendar meeting a person was in during a window, straight from
// Layer 1. Search returns the top few matches, which is fine for "what did
// Kai say" and wrong for "how many meetings did I have with Kai": this is
// the complete list a count can rest on.

import type { WikiDbHandle } from "@sqrrl/wiki-engine"
import {
	rawItemsCollection,
	type RawItemView,
	toRawItemView,
} from "./raw-items.js"

export const MEETINGS_WITH_LIMIT = 40

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Participant strings are "Name <address>", an address or a name; one
 *  matches when it holds one of the addresses, or is exactly one of the
 *  names (a bare "Kai" could be anyone, so names must be full). */
export function participantPatterns(person: {
	emails: string[]
	names: string[]
}): RegExp[] {
	return [
		...person.emails
			.filter(Boolean)
			.map((e) => new RegExp(`(^|[<\\s])${escapeRegExp(e)}($|[>\\s])`, "i")),
		...person.names
			.filter((n) => n.trim().includes(" "))
			.map((n) => new RegExp(`^\\s*${escapeRegExp(n.trim())}\\s*(<|$)`, "i")),
	]
}

export interface MeetingsWith {
	items: RawItemView[]
	/** More matched than were returned. */
	truncated: boolean
}

export async function listMeetingsWith(
	handle: WikiDbHandle,
	p: {
		scope: string
		scopeRef: string
		from: Date
		to: Date
		emails: string[]
		names: string[]
		limit?: number
	},
): Promise<MeetingsWith> {
	const patterns = participantPatterns(p)
	if (!patterns.length) return { items: [], truncated: false }
	const limit = p.limit ?? MEETINGS_WITH_LIMIT
	const docs = await rawItemsCollection(handle.db, handle.prefix)
		.find({
			scope: p.scope,
			scopeRef: p.scopeRef,
			source: "calendar",
			current: true,
			occurredAt: { $gte: p.from, $lt: p.to },
			participants: { $in: patterns },
		})
		.sort({ occurredAt: 1, sourceId: 1 })
		.limit(limit + 1)
		.toArray()
	return {
		items: docs.slice(0, limit).map(toRawItemView),
		truncated: docs.length > limit,
	}
}
