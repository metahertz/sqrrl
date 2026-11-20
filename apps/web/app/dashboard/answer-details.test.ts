import { describe, expect, it } from "vitest"
import {
	citationTarget,
	meetingCount,
	verificationSummary,
	windowLabel,
} from "./answer-details.js"

describe("windowLabel", () => {
	it("names the phrase and the inclusive range", () => {
		expect(
			windowLabel({
				phrase: "last month",
				from: "2026-10-01T00:00:00.000Z",
				to: "2026-11-01T00:00:00.000Z",
			}),
		).toBe("last month · 1–31 Oct 2026")
		expect(
			windowLabel({
				phrase: "yesterday",
				from: "2026-11-19T00:00:00.000Z",
				to: "2026-11-20T00:00:00.000Z",
			}),
		).toBe("yesterday · 19 Nov 2026")
		expect(
			windowLabel({
				phrase: "last week",
				from: "2026-10-26T00:00:00.000Z",
				to: "2026-11-02T00:00:00.000Z",
			}),
		).toBe("last week · 26 Oct – 1 Nov 2026")
	})
})

describe("meetingCount", () => {
	it("says how many, and when there were more than listed", () => {
		expect(meetingCount({ count: 1 })).toBe("1 meeting")
		expect(meetingCount({ count: 9 })).toBe("9 meetings")
		expect(meetingCount({ count: 0 })).toBe("0 meetings")
		expect(meetingCount({ count: 30, truncated: true })).toBe("30+ meetings")
	})
})

describe("verificationSummary", () => {
	it("reports a clean check", () => {
		expect(
			verificationSummary({
				claims: 2,
				citationsDropped: [],
				claimsRemoved: [],
			}),
		).toEqual({
			tone: "ok",
			text: "Citations checked: 2 claims, all supported",
		})
	})

	it("reports what the check removed", () => {
		expect(
			verificationSummary({
				claims: 3,
				citationsDropped: [
					{ claim: "a", citation: "people/x" },
					{ claim: "a", citation: "raw:1" },
				],
				claimsRemoved: ["a"],
			}),
		).toEqual({
			tone: "changed",
			text: "Citations checked: 3 claims; 2 unsupported citations removed, 1 sentence without support removed",
		})
	})

	it("says when nothing was checked", () => {
		expect(verificationSummary({ unchecked: "failed" }).tone).toBe("unchecked")
		expect(verificationSummary({ unchecked: "no-claims" }).text).toBe(
			"Citations not checked: none to check",
		)
	})
})

describe("citationTarget", () => {
	it("tells pages from raw items", () => {
		expect(citationTarget("tasks/x")).toEqual({ kind: "page", slug: "tasks/x" })
		expect(citationTarget("raw:abc")).toEqual({ kind: "raw", id: "abc" })
	})
})
