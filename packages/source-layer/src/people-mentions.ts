// Which known people a question names, however it names them.
//
// "What did Taylor M promise?", "anything from taylor.morgan@acme.example?",
// "When did I last meet Morgan?" all name the same hub. A first or last name
// on its own counts only when it is capitalized and is not a month, a
// weekday or a question word ("May" the person, not "in May"). A first name
// several people share comes back with all of them as candidates, so the
// answer can say which one it means or ask.

import { nameKey } from "./identity.js"
import type { HubEntry } from "./people.js"

export interface PersonMention {
	/** How the question wrote it. */
	text: string
	/** The person, when the mention fits one. */
	person?: HubEntry
	/** The people it might be, when it fits several. */
	candidates?: HubEntry[]
	/** Full name or address (exact) vs first or last name (partial). */
	exact: boolean
}

const NOT_NAMES = new Set(
	[
		"january february march april may june july august september october november december",
		"jan feb mar apr jun jul aug sep sept oct nov dec",
		"monday tuesday wednesday thursday friday saturday sunday today tomorrow yesterday",
		"what who whom whose when where why how which did does do is are was were will would can could should",
		"the a an and or but if then i im ive my me mine we our us you your they their he she it its this that these those",
		"any anything all some every each from about with for to of in on at by after before since until",
		"show tell list find give summarize summarise remind open closed done overdue meeting meetings task tasks note notes email emails mail",
		"mongodb atlas google slack zoom apple",
	]
		.join(" ")
		.split(" "),
)

const words = (k: string) => k.split(" ").filter(Boolean)

export function findPeopleMentions(
	entries: HubEntry[],
	question: string,
	max = 4,
): PersonMention[] {
	const people = entries.filter((e) => !e.org && !e.ambiguousHub)
	const qKey = ` ${nameKey(question)} `
	const qLower = question.toLowerCase()
	const out: PersonMention[] = []
	const covered = new Set<string>()
	const seen = new Set<string>()
	const add = (m: PersonMention) => {
		const id =
			m.person?.slug ?? m.candidates?.map((c) => c.slug).join("|") ?? m.text
		if (seen.has(id)) return
		seen.add(id)
		out.push(m)
	}

	// Addresses and full names, longest first.
	for (const e of people) {
		const email = e.emails.find((x) => qLower.includes(x))
		if (email) {
			add({ text: email, person: e, exact: true })
			for (const w of words(nameKey(e.title))) covered.add(w)
		}
	}
	const fullKeys = people
		.flatMap((e) =>
			e.keys.filter((k) => words(k).length >= 2).map((k) => ({ k, e })),
		)
		.sort((a, b) => b.k.length - a.k.length)
	for (const { k, e } of fullKeys) {
		if (!qKey.includes(` ${k} `)) continue
		if (words(k).every((w) => covered.has(w))) continue
		add({ text: k, person: e, exact: true })
		for (const w of words(k)) covered.add(w)
	}

	// Capitalized single names: first names, then last names.
	const tokens = question.match(/\p{Lu}[\p{L}'’-]+/gu) ?? []
	for (const token of tokens) {
		const w = nameKey(token)
		if (!w || w.includes(" ") || covered.has(w) || NOT_NAMES.has(w)) continue
		const byFirst = people.filter((e) =>
			e.keys.some((k) => words(k)[0] === w && words(k).length >= 2),
		)
		const byLast = byFirst.length
			? []
			: people.filter((e) =>
					e.keys.some((k) => words(k).length >= 2 && words(k).at(-1) === w),
				)
		const fits = byFirst.length ? byFirst : byLast
		if (fits.length === 1) add({ text: token, person: fits[0], exact: false })
		else if (fits.length > 1)
			add({ text: token, candidates: fits.slice(0, 4), exact: false })
		covered.add(w)
	}
	return out.slice(0, max)
}

/** The lines the answer prompt gets about who is who. */
export function describeMentions(mentions: PersonMention[]): string {
	return mentions
		.map((m) => {
			if (m.person) {
				const p = m.person
				const also = [
					...new Set([
						...p.emails,
						...p.keys.filter((k) => k !== nameKey(p.title)),
					]),
				].slice(0, 4)
				return `- "${m.text}" is ${p.title}${also.length ? ` (also written ${also.join(", ")})` : ""}.`
			}
			const names = (m.candidates ?? []).map((c) =>
				c.emails[0] ? `${c.title} (${c.emails[0]})` : c.title,
			)
			return `- "${m.text}" could be ${names.join(" or ")}; if the evidence does not make clear which, say so.`
		})
		.join("\n")
}
