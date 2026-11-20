// "Same person?" questions over MCP: list them, and record the user's
// answer. The agent shows the candidates and asks; it never picks a person
// on its own, which is why deciding needs an explicit choice or "dismiss".

import type { SqrrlClient } from "@sqrrl/client"
import { SCOPES } from "./curation-tools.js"

export type IdentityClient = Pick<
	SqrrlClient,
	"identitySuggestions" | "decideIdentitySuggestion"
>

type Args = Record<string, unknown>

const scopeProps = {
	scope: { type: "string", enum: SCOPES },
	scopeRef: {
		type: "string",
		description: 'Concrete namespace for the scope, e.g. "default".',
	},
} as const

export const identityTools = [
	{
		name: "sqrrl_people_suggestions",
		description:
			'Same-person questions. kind "link": a page names someone ambiguously (e.g. "Taylor" when two Taylors are known; fromSlug/fromTitle is the page, candidates the people it could be). kind "merge": two people pages are probably one person (subject vs candidates). Show the user the page and candidates and ask before deciding with sqrrl_people_suggestion_decide.',
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				status: {
					type: "string",
					enum: ["pending", "accepted", "dismissed"],
					description: 'Default "pending".',
				},
				limit: { type: "number", description: "Default 50, at most 200." },
			},
			required: ["scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_people_suggestion_decide",
		description:
			"Record the user's answer to a same-person question. chosen is the slug of the candidate the user picked: for a link it moves that page's link to them, for a merge it merges the subject into them. decision dismiss changes nothing and the question is not asked again. Only call this after the user has decided.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				id: { type: "string", description: "Suggestion id." },
				decision: { type: "string", enum: ["accept", "dismiss"] },
				chosen: {
					type: "string",
					description: "For accept: the chosen candidate's slug.",
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

export async function handleIdentityTool(
	name: string,
	args: Args,
	client: IdentityClient,
) {
	if (!identityTools.some((t) => t.name === name)) return undefined
	const scope = { scope: str(args, "scope"), scopeRef: str(args, "scopeRef") }
	if (name === "sqrrl_people_suggestions") {
		const status = typeof args.status === "string" ? args.status : "pending"
		const limit =
			typeof args.limit === "number" && args.limit > 0
				? Math.min(Math.floor(args.limit), 200)
				: 50
		const out = await client.identitySuggestions({
			...scope,
			status: status as "pending",
			limit,
		})
		return toolResult({ ...scope, status, suggestions: out.suggestions })
	}
	const id = str(args, "id")
	const decision = str(args, "decision")
	if (decision === "accept")
		return toolResult(
			await client.decideIdentitySuggestion({
				id,
				...scope,
				chosen: str(args, "chosen"),
			}),
		)
	if (decision === "dismiss")
		return toolResult(await client.decideIdentitySuggestion({ id, ...scope }))
	throw new Error('decision must be "accept" or "dismiss"')
}
