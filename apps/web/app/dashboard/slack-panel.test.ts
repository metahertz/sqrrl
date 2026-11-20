import { describe, expect, it } from "vitest"
import { describeReach } from "./slack-panel.js"

describe("describeReach", () => {
	it("lists what a token can read, in a fixed order", () => {
		expect(
			describeReach({
				total: 16,
				more: false,
				byType: { dm: 12, channel: 3, "group dm": 1 },
			}),
		).toBe("3 channels, 1 group DM, 12 DMs")
		expect(describeReach({ total: 0, more: true, byType: {} })).toBe(
			"no conversations (and more)",
		)
	})
})
