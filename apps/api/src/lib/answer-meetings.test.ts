import { describe, expect, it } from "vitest"
import { describeMeetingLists, type MeetingList } from "./answer-meetings.js"

const item = (id: string, at: string, title: string) =>
	({ id, occurredAt: new Date(at), title }) as MeetingList["items"][number]

describe("describeMeetingLists", () => {
	it("gives each person's count and every meeting's label, date and title", () => {
		const lists: MeetingList[] = [
			{
				slug: "people/kai",
				title: "Kai Smith",
				items: [
					item("a", "2026-10-06T15:00:00Z", "Kai / me weekly"),
					item("b", "2026-10-13T15:00:00Z", "Planning"),
				],
				truncated: false,
			},
			{ slug: "people/lee", title: "Lee Park", items: [], truncated: false },
			{
				slug: "people/ana",
				title: "Ana Ruiz",
				items: [item("c", "2026-10-20T09:00:00Z", "Review")],
				truncated: true,
			},
		]
		const labels: Record<string, string> = { a: "R6", b: "R7", c: "R8" }
		expect(
			describeMeetingLists(lists, { phrase: "last month" }, (id) => labels[id]),
		).toBe(
			[
				"- Kai Smith: 2 calendar meetings last month:",
				"  [R6] 2026-10-06 Kai / me weekly",
				"  [R7] 2026-10-13 Planning",
				"- Lee Park: no calendar meetings last month.",
				"- Ana Ruiz: at least 1 calendar meetings last month:",
				"  [R8] 2026-10-20 Review",
			].join("\n"),
		)
	})

	it("says once that a name could be several people", () => {
		const lists: MeetingList[] = [
			{
				slug: "people/taylor-m",
				title: "Taylor Morgan",
				ambiguousName: "Taylor",
				items: [item("a", "2026-10-06T15:00:00Z", "Weekly")],
				truncated: false,
			},
			{
				slug: "people/taylor-p",
				title: "Taylor Pryce",
				ambiguousName: "Taylor",
				items: [],
				truncated: false,
			},
		]
		const text = describeMeetingLists(
			lists,
			{ phrase: "last month" },
			() => "R1",
		)
		expect(text.split("\n")[0]).toBe(
			'"Taylor" in the question could be Taylor Morgan or Taylor Pryce: give the count for each.',
		)
		expect(text.match(/could be/g)).toHaveLength(1)
	})
})
