import { describe, expect, it } from "vitest"
import { readTimeWindow } from "./answer-time.js"

// Friday 20 November 2026, mid-afternoon.
const NOW = new Date("2026-11-20T15:30:00Z")
const day = (s: string) => new Date(`${s}T00:00:00Z`)

describe("readTimeWindow", () => {
	it("reads last week as Monday to Monday", () => {
		const w = readTimeWindow("What did Kai say last week?", NOW)
		expect(w?.from).toEqual(day("2026-11-09"))
		expect(w?.to).toEqual(day("2026-11-16"))
		expect(w?.phrase).toBe("last week")
		expect(w?.rest).toBe("What did Kai say?")
	})

	it("reads the other fixed phrases", () => {
		const r = (q: string) => {
			const w = readTimeWindow(q, NOW)
			return (
				w && [
					w.from.toISOString().slice(0, 10),
					w.to.toISOString().slice(0, 10),
				]
			)
		}
		expect(r("anything today")).toEqual(["2026-11-20", "2026-11-21"])
		expect(r("what happened yesterday")).toEqual(["2026-11-19", "2026-11-20"])
		expect(r("my meetings this week")).toEqual(["2026-11-16", "2026-11-21"])
		expect(r("this month")).toEqual(["2026-11-01", "2026-11-21"])
		expect(r("decisions last month")).toEqual(["2026-10-01", "2026-11-01"])
		expect(r("emails in the last 3 days")).toEqual(["2026-11-18", "2026-11-21"])
		expect(r("over the past two weeks")).toEqual(["2026-11-07", "2026-11-21"])
	})

	it("leaves questions without time words alone", () => {
		expect(readTimeWindow("What do I owe Kai?", NOW)).toBeUndefined()
		expect(readTimeWindow("Kai Smith", NOW)).toBeUndefined()
		expect(readTimeWindow("the weekly sync", NOW)).toBeUndefined()
	})
})
