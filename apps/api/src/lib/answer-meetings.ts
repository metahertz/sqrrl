// Complete meeting lists for POST /v1/wiki/answer: when a question names a
// person and a time window ("how many meetings with Kai last month?"),
// every calendar meeting they were in during that window, so a count rests
// on the calendar rather than on the top few search matches.

import {
	listMeetingsWith,
	type PersonMention,
	type RawItemView,
} from "@sqrrl/source-layer"
import type { WikiDbHandle } from "@sqrrl/wiki-engine"
import type { TimeWindow } from "./answer-time.js"

/** People per question; an ambiguous first name counts each candidate. */
const MAX_PEOPLE = 4
/** Meetings per person; more is reported as "at least". */
const PER_PERSON = 30

export interface MeetingList {
	slug: string
	title: string
	/** Set when this person is one of several a name could mean. */
	ambiguousName?: string
	items: RawItemView[]
	truncated: boolean
}

export async function meetingLists(
	handle: WikiDbHandle,
	p: {
		scope: string
		scopeRef: string
		window: Pick<TimeWindow, "from" | "to">
		mentions: PersonMention[]
		/** The owner: every meeting in their calendar includes them. */
		selfSlug?: string
	},
): Promise<MeetingList[]> {
	const people = p.mentions
		.flatMap((m) =>
			m.person
				? [{ ...m.person, ambiguousName: undefined as string | undefined }]
				: (m.candidates ?? []).map((c) => ({ ...c, ambiguousName: m.text })),
		)
		.filter((e, i, all) => all.findIndex((x) => x.slug === e.slug) === i)
		.filter((e) => !e.org && !e.ambiguousHub && e.slug !== p.selfSlug)
		.slice(0, MAX_PEOPLE)
	const out: MeetingList[] = []
	for (const person of people) {
		const found = await listMeetingsWith(handle, {
			scope: p.scope,
			scopeRef: p.scopeRef,
			from: p.window.from,
			to: p.window.to,
			emails: person.emails,
			names: [person.title],
			limit: PER_PERSON,
		})
		out.push({
			slug: person.slug,
			title: person.title,
			...(person.ambiguousName ? { ambiguousName: person.ambiguousName } : {}),
			...found,
		})
	}
	return out
}

/** The prompt section: per person, the count, then each meeting's label,
 *  date and title. `labelOf` maps a raw item id to its evidence label. */
export function describeMeetingLists(
	lists: MeetingList[],
	window: Pick<TimeWindow, "phrase">,
	labelOf: (id: string) => string | undefined,
): string {
	const lines: string[] = []
	const said = new Set<string>()
	for (const l of lists) {
		if (l.ambiguousName && !said.has(l.ambiguousName)) {
			said.add(l.ambiguousName)
			const who = lists
				.filter((x) => x.ambiguousName === l.ambiguousName)
				.map((x) => x.title)
			lines.push(
				`"${l.ambiguousName}" in the question could be ${who.join(" or ")}: give the count for each.`,
			)
		}
		const count = l.truncated
			? `at least ${l.items.length}`
			: `${l.items.length}`
		const noun = l.items.length === 1 && !l.truncated ? "meeting" : "meetings"
		const entries = l.items.flatMap((i) => {
			const ref = labelOf(i.id)
			if (!ref) return []
			const at = i.occurredAt
				? new Date(i.occurredAt).toISOString().slice(0, 10)
				: ""
			return [`  [${ref}] ${at} ${i.title ?? "meeting"}`.trimEnd()]
		})
		lines.push(
			entries.length
				? `- ${l.title}: ${count} calendar ${noun} ${window.phrase}:`
				: `- ${l.title}: no calendar meetings ${window.phrase}.`,
			...entries,
		)
	}
	return lines.join("\n")
}
