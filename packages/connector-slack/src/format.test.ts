import { describe, expect, it } from "vitest"
import {
	dayWindow,
	isContent,
	localDay,
	renderTranscript,
	slackText,
	tsToDate,
} from "./format.js"

const names = {
	user: (id: string) => ({ U1: "Kai", U2: "Ana" })[id] ?? id,
	channel: (id: string) => ({ C1: "general" })[id] ?? id,
}

describe("slackText", () => {
	it("turns mentions, channels, links and entities into words", () => {
		expect(
			slackText(
				"<@U1> see <#C1> and <#C9|eng>, <https://x.test/a|the doc> or <https://x.test/b>; <!here> &lt;b&gt; &amp; <!subteam^S1|@oncall>",
				names,
			),
		).toBe(
			"@Kai see #general and #eng, the doc (https://x.test/a) or https://x.test/b; @here <b> & @oncall",
		)
	})
})

describe("days", () => {
	it("bounds a local day in UTC, across a DST change", () => {
		// London: BST (UTC+1) until 2026-10-25 02:00, then GMT.
		expect(dayWindow("2026-07-01", "Europe/London")).toEqual({
			from: new Date("2026-06-30T23:00:00Z"),
			to: new Date("2026-07-01T23:00:00Z"),
		})
		const change = dayWindow("2026-10-25", "Europe/London")
		expect(change.from.toISOString()).toBe("2026-10-24T23:00:00.000Z")
		expect(change.to.toISOString()).toBe("2026-10-26T00:00:00.000Z")
		expect(dayWindow("2026-11-17", "UTC").from.toISOString()).toBe(
			"2026-11-17T00:00:00.000Z",
		)
	})

	it("reads a Slack ts as a local day", () => {
		const at = tsToDate("1794956106.000200")
		expect(localDay(at, "UTC")).toBe(at.toISOString().slice(0, 10))
	})

	it("keeps conversation and drops housekeeping", () => {
		expect(isContent({ ts: "1", text: "hi" })).toBe(true)
		expect(isContent({ ts: "1", subtype: "thread_broadcast" })).toBe(true)
		expect(isContent({ ts: "1", subtype: "channel_join" })).toBe(false)
	})
})

describe("renderTranscript", () => {
	const at = (h: number) => new Date(Date.UTC(2026, 10, 17, h, 0))
	it("indents same-day replies and labels replies to older threads", () => {
		const out = renderTranscript(
			"#general",
			"2026-11-17",
			[
				{
					message: { ts: "200", thread_ts: "100" },
					speaker: "Ana",
					text: "agreed",
					at: at(10),
				},
				{
					message: { ts: "100", reply_count: 1 },
					speaker: "Kai",
					text: "ship Friday?",
					at: at(9),
				},
				{
					message: { ts: "300", thread_ts: "50" },
					speaker: "Kai",
					text: "done now",
					at: at(11),
				},
			],
			(ts) =>
				ts === "50"
					? "the migration plan for OIDC is ready to review"
					: undefined,
			"UTC",
		)
		expect(out).toBe(
			[
				"#general — 2026-11-17 (Slack)",
				"",
				"09:00 Kai: ship Friday?",
				"    ↳ 10:00 Ana: agreed",
				"11:00 Kai: done now  (in thread: “the migration plan for OIDC is ready to…”)",
			].join("\n"),
		)
	})
})
