// Suggested task closures over MCP: list what the evidence says is done or
// no longer needed, and record the user's decision. The agent presents the
// evidence and asks; it never decides alone, which is why deciding needs an
// explicit "accept" or "dismiss" and nothing here runs a review.

import type { SqrrlClient } from "@sqrrl/client"
import { SCOPES } from "./curation-tools.js"

export type SuggestionClient = Pick<
	SqrrlClient,
	"taskSuggestions" | "acceptTaskSuggestion" | "dismissTaskSuggestion"
>

type Args = Record<string, unknown>

const scopeProps = {
	scope: { type: "string", enum: SCOPES },
	scopeRef: {
		type: "string",
		description: 'Concrete namespace for the scope, e.g. "default".',
	},
} as const

export const suggestionTools = [
	{
		name: "sqrrl_task_suggestions",
		description:
			'Suggested task closures: open tasks that later notes, meetings, Slack or mail suggest are done ("done") or no longer needed ("dropped"). Each has a confidence, a rationale and verbatim evidence quotes with dates. Show the user the quotes and ask before deciding with sqrrl_task_suggestion_decide.',
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				status: {
					type: "string",
					enum: ["pending", "accepted", "dismissed", "stale"],
					description: 'Default "pending".',
				},
				taskSlug: {
					type: "string",
					description: "Only suggestions for this task.",
				},
				limit: { type: "number", description: "Default 50, at most 200." },
			},
			required: ["scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_task_suggestion_decide",
		description:
			"Record the user's decision on a suggestion. accept closes the task as proposed (done with completedAt from the evidence, or dropped) and links it to the evidence; dismiss keeps the task open and stops this evidence from suggesting it again. Only call this after the user has decided.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				id: { type: "string", description: "Suggestion id." },
				decision: { type: "string", enum: ["accept", "dismiss"] },
				note: {
					type: "string",
					description: "Why it was dismissed (optional).",
				},
			},
			required: ["id", "scope", "scopeRef", "decision"],
		},
	},
]

function str(args: Args, key: string): string {
	const v = args[key]
	if (typeof v !== "string" || !v.trim()) throw new Error(`${key} is required`)
	return v.trim()
}

function toolResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	}
}

export async function handleSuggestionTool(
	name: string,
	args: Args,
	client: SuggestionClient,
) {
	if (!suggestionTools.some((t) => t.name === name)) return undefined
	const scope = { scope: str(args, "scope"), scopeRef: str(args, "scopeRef") }
	if (name === "sqrrl_task_suggestions") {
		const status = typeof args.status === "string" ? args.status : "pending"
		const limit =
			typeof args.limit === "number" && args.limit > 0
				? Math.min(Math.floor(args.limit), 200)
				: 50
		const out = await client.taskSuggestions({
			...scope,
			status: status as "pending",
			...(typeof args.taskSlug === "string" && args.taskSlug.trim()
				? { taskSlug: args.taskSlug.trim() }
				: {}),
			limit,
		})
		return toolResult({ ...scope, status, suggestions: out.suggestions })
	}
	if (name === "sqrrl_task_suggestion_decide") {
		const id = str(args, "id")
		const decision = str(args, "decision")
		if (decision === "accept")
			return toolResult(await client.acceptTaskSuggestion({ id, ...scope }))
		if (decision === "dismiss")
			return toolResult(
				await client.dismissTaskSuggestion({
					id,
					...scope,
					...(typeof args.note === "string" && args.note.trim()
						? { note: args.note.trim() }
						: {}),
				}),
			)
		throw new Error('decision must be "accept" or "dismiss"')
	}
	return undefined
}
