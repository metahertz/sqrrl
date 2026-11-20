import { describe, expect, it, vi } from "vitest"
import {
	handleSuggestionTool,
	suggestionTools,
} from "./task-suggestion-tools.js"

const SCOPE = { scope: "workspace", scopeRef: "default" }

function fakeClient() {
	return {
		taskSuggestions: vi.fn().mockResolvedValue({ suggestions: [{ id: "s1" }] }),
		acceptTaskSuggestion: vi
			.fn()
			.mockResolvedValue({ suggestion: { status: "accepted" } }),
		dismissTaskSuggestion: vi
			.fn()
			.mockResolvedValue({ suggestion: { status: "dismissed" } }),
	}
}

describe("task suggestion tools", () => {
	it("are listed with the scope required", () => {
		for (const t of suggestionTools)
			expect(t.inputSchema.required).toEqual(
				expect.arrayContaining(["scope", "scopeRef"]),
			)
	})

	it("lists pending suggestions by default", async () => {
		const c = fakeClient()
		const out = await handleSuggestionTool(
			"sqrrl_task_suggestions",
			{ ...SCOPE },
			c,
		)
		expect(c.taskSuggestions).toHaveBeenCalledWith({
			...SCOPE,
			status: "pending",
			limit: 50,
		})
		expect(out?.structuredContent).toMatchObject({
			suggestions: [{ id: "s1" }],
		})
	})

	it("accepts or dismisses only on an explicit decision", async () => {
		const c = fakeClient()
		await handleSuggestionTool(
			"sqrrl_task_suggestion_decide",
			{ ...SCOPE, id: "s1", decision: "accept" },
			c,
		)
		expect(c.acceptTaskSuggestion).toHaveBeenCalledWith({ id: "s1", ...SCOPE })
		await handleSuggestionTool(
			"sqrrl_task_suggestion_decide",
			{ ...SCOPE, id: "s1", decision: "dismiss", note: "wrong deck" },
			c,
		)
		expect(c.dismissTaskSuggestion).toHaveBeenCalledWith({
			id: "s1",
			...SCOPE,
			note: "wrong deck",
		})
		await expect(
			handleSuggestionTool(
				"sqrrl_task_suggestion_decide",
				{ ...SCOPE, id: "s1", decision: "maybe" },
				c,
			),
		).rejects.toThrow(/accept/)
		await expect(
			handleSuggestionTool(
				"sqrrl_task_suggestion_decide",
				{ ...SCOPE, decision: "accept" },
				c,
			),
		).rejects.toThrow(/id/)
	})

	it("ignores other tools", async () => {
		expect(
			await handleSuggestionTool("sqrrl_wiki_get", { ...SCOPE }, fakeClient()),
		).toBeUndefined()
	})
})
