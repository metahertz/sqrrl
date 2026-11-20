import { describe, expect, it, vi } from "vitest"
import { handleIdentityTool, identityTools } from "./identity-tools.js"

const SCOPE = { scope: "workspace", scopeRef: "default" }

function fakeClient() {
	return {
		identitySuggestions: vi
			.fn()
			.mockResolvedValue({ suggestions: [{ id: "s1" }] }),
		decideIdentitySuggestion: vi.fn().mockResolvedValue({ ok: true }),
	}
}

describe("identity tools", () => {
	it("are listed with the scope required", () => {
		for (const t of identityTools)
			expect(t.inputSchema.required).toEqual(
				expect.arrayContaining(["scope", "scopeRef"]),
			)
	})

	it("lists pending questions by default", async () => {
		const c = fakeClient()
		await handleIdentityTool("sqrrl_people_suggestions", SCOPE, c)
		expect(c.identitySuggestions).toHaveBeenCalledWith({
			...SCOPE,
			status: "pending",
			limit: 50,
		})
	})

	it("needs a chosen person to accept, none to dismiss", async () => {
		const c = fakeClient()
		await expect(
			handleIdentityTool(
				"sqrrl_people_suggestion_decide",
				{ ...SCOPE, id: "s1", decision: "accept" },
				c,
			),
		).rejects.toThrow("chosen is required")
		await handleIdentityTool(
			"sqrrl_people_suggestion_decide",
			{
				...SCOPE,
				id: "s1",
				decision: "accept",
				chosen: "people/taylor-morgan",
			},
			c,
		)
		expect(c.decideIdentitySuggestion).toHaveBeenLastCalledWith({
			id: "s1",
			...SCOPE,
			chosen: "people/taylor-morgan",
		})
		await handleIdentityTool(
			"sqrrl_people_suggestion_decide",
			{ ...SCOPE, id: "s1", decision: "dismiss" },
			c,
		)
		expect(c.decideIdentitySuggestion).toHaveBeenLastCalledWith({
			id: "s1",
			...SCOPE,
		})
	})

	it("ignores other tools", async () => {
		expect(
			await handleIdentityTool("sqrrl_wiki_get", SCOPE, fakeClient()),
		).toBeUndefined()
	})
})
