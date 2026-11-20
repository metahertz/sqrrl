import { describe, expect, it } from "vitest"
import {
	applyVerification,
	buildVerifyPrompt,
	readVerifyReply,
	splitClaims,
	verifyAnswer,
} from "./answer-verify.js"

describe("splitClaims", () => {
	it("splits sentences and lines, keeping labels with their sentence", () => {
		const s = splitClaims(
			"Kai owns the rollout [P1]. It is due Friday. [R2]\n- Deck sent [R3]\nThat is all.",
		)
		expect(s.claims.map((c) => [c.text, c.labels])).toEqual([
			["Kai owns the rollout [P1].", ["P1"]],
			["It is due Friday [R2].", ["R2"]],
			["- Deck sent [R3]", ["R3"]],
		])
		expect(s.parts.map((p) => p.text).join("")).toBe(
			"Kai owns the rollout [P1]. It is due Friday [R2].\n- Deck sent [R3]\nThat is all.",
		)
	})

	it("reads grouped labels", () => {
		expect(splitClaims("Two meetings [R1, R2].").claims[0].labels).toEqual([
			"R1",
			"R2",
		])
	})
})

describe("readVerifyReply", () => {
	const { claims } = splitClaims("A [P1][P2]. B [R1].")

	it("keeps only cited labels the checker supports", () => {
		const kept = readVerifyReply(
			{ claims: [{ n: 1, supported: ["P2", "P9"] }] },
			claims,
		)
		expect(kept?.get(1)).toEqual(["P2"])
		// Left out of the reply: unchanged.
		expect(kept?.get(2)).toEqual(["R1"])
	})

	it("rejects a reply without a claims list", () => {
		expect(readVerifyReply("ok", claims)).toBeNull()
		expect(readVerifyReply({ found: true }, claims)).toBeNull()
	})
})

describe("applyVerification", () => {
	it("drops unsupported citations and claims left with none", () => {
		const split = splitClaims(
			"You met Kai S. twice [R1][R2]. You had no meetings with Kai J. [P9][P10]. Both were weekly [R1].",
		)
		const out = applyVerification(
			split,
			new Map([
				[1, ["R1", "R2"]],
				[2, []],
				[3, ["R1"]],
			]),
		)
		expect(out.answer).toBe(
			"You met Kai S. twice [R1][R2]. Both were weekly [R1].",
		)
		expect(out.claimsRemoved).toEqual(["You had no meetings with Kai J."])
		expect(out.citationsDropped.map((d) => d.label)).toEqual(["P9", "P10"])
	})

	it("trims one citation from a group", () => {
		const split = splitClaims("Sent on Monday [P1, R4].")
		expect(applyVerification(split, new Map([[1, ["R4"]]])).answer).toBe(
			"Sent on Monday [R4].",
		)
	})
})

describe("verifyAnswer", () => {
	const blocks = new Map([
		["P1", "[P1] wiki page about the rollout"],
		["R1", "[R1] raw email: sent the deck"],
	])

	it("shows the checker only the cited evidence", async () => {
		let seen = ""
		const out = await verifyAnswer(
			"The deck was sent [R1].",
			blocks,
			async (_s, user) => {
				seen = user
				return { claims: [{ n: 1, supported: ["R1"] }] }
			},
		)
		expect(seen).toContain("[R1] raw email")
		expect(seen).not.toContain("[P1]")
		expect(out).toMatchObject({ answer: "The deck was sent [R1].", checked: 1 })
	})

	it("fails open", async () => {
		expect(
			await verifyAnswer("A [R1].", blocks, async () => {
				throw new Error("down")
			}),
		).toEqual({ unchecked: "failed" })
		expect(
			await verifyAnswer("A [R1].", blocks, async () => "not json"),
		).toEqual({ unchecked: "failed" })
		expect(await verifyAnswer("No labels.", blocks, async () => ({}))).toEqual({
			unchecked: "no-claims",
		})
	})
})

describe("buildVerifyPrompt", () => {
	it("numbers claims with their labels", () => {
		const { claims } = splitClaims("A [P1]. B [R1].")
		const prompt = buildVerifyPrompt(
			claims,
			new Map([
				["P1", "[P1] x"],
				["R1", "[R1] y"],
			]),
		)
		expect(prompt).toContain("1. A [P1]. (cites P1)")
		expect(prompt).toContain("2. B [R1]. (cites R1)")
	})
})
