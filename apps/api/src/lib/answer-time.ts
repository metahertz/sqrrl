// Time words in a question ("what did Kai say last week?"), read without
// an LLM so the raw search can be bounded to that window. Only plain,
// unambiguous phrases; anything else leaves the search unbounded, as before.
// Weeks start on Monday; days are UTC.

export interface TimeWindow {
	from: Date
	to: Date
	/** The phrase as asked, e.g. "last week". */
	phrase: string
	/** The question with the phrase removed, for searching by meaning. */
	rest: string
}

const DAY = 86_400_000
const UNITS: Record<string, number> = { day: 1, days: 1, week: 7, weeks: 7 }
const NUMBERS: Record<string, number> = {
	a: 1,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	ten: 10,
	fourteen: 14,
	thirty: 30,
}

function startOfDay(t: Date): number {
	return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
}

function startOfWeek(t: Date): number {
	const day = startOfDay(t)
	return day - ((t.getUTCDay() + 6) % 7) * DAY
}

function monthStart(t: Date, offset: number): number {
	return Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, 1)
}

export function readTimeWindow(
	question: string,
	now: Date = new Date(),
): TimeWindow | undefined {
	const q = question.toLowerCase()
	const today = startOfDay(now)
	const tomorrow = today + DAY
	const fixed: Array<[RegExp, () => [number, number]]> = [
		[/\btoday\b/, () => [today, tomorrow]],
		[/\byesterday\b/, () => [today - DAY, today]],
		[/\bthis week\b/, () => [startOfWeek(now), tomorrow]],
		[/\blast week\b/, () => [startOfWeek(now) - 7 * DAY, startOfWeek(now)]],
		[/\bthis month\b/, () => [monthStart(now, 0), tomorrow]],
		[/\blast month\b/, () => [monthStart(now, -1), monthStart(now, 0)]],
	]
	const n = q.match(
		/\b(?:in the |over the )?(?:last|past)\s+(\d{1,3}|[a-z]+)\s+(days?|weeks?)\b/,
	)
	if (n) {
		const count = /^\d+$/.test(n[1]) ? Number(n[1]) : NUMBERS[n[1]]
		if (count && count > 0)
			return window(
				question,
				n[0],
				tomorrow - count * UNITS[n[2]] * DAY,
				tomorrow,
			)
	}
	for (const [re, range] of fixed) {
		const m = q.match(re)
		if (m) {
			const [from, to] = range()
			return window(question, m[0], from, to)
		}
	}
	return undefined
}

function window(
	question: string,
	phrase: string,
	from: number,
	to: number,
): TimeWindow {
	const at = question.toLowerCase().indexOf(phrase)
	const rest = `${question.slice(0, at)} ${question.slice(at + phrase.length)}`
		.replace(/\s+([?.!,])/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
	return {
		from: new Date(from),
		to: new Date(to),
		phrase,
		rest: rest || question,
	}
}
