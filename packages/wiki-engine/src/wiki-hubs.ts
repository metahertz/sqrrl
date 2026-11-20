// @sqrrl/wiki-engine — hub pages.
//
// Person and topic hubs are Layer 2 pages that the distillers in
// @sqrrl/source-layer link tasks and sources to. They are created on
// demand as minimal stubs and become useful through their backlinks.
// apps/web/app/dashboard/new-page.ts creates the same pages by hand and must
// stay in step with this shape.

import {
	createWikiPage,
	getWikiPage,
	type WikiDbHandle,
} from "./wiki-bridge.js"

/** Creates a hub page if it does not exist. Returns its slug. */
export async function ensureHubPage(
	handle: WikiDbHandle,
	params: {
		slug: string
		title: string
		kind: "entity" | "concept"
		summary: string
		scope: string
		scopeRef: string
		trustTier?: string
	},
): Promise<string> {
	const existing = await getWikiPage(
		handle,
		params.slug,
		params.scope,
		params.scopeRef,
	)
	if (existing) return params.slug
	await createWikiPage(handle, {
		kind: params.kind,
		title: params.title,
		slug: params.slug,
		summary: params.summary,
		body: "",
		frontmatter: { type: params.kind === "entity" ? "person" : "topic" },
		scope: params.scope as never,
		scopeRef: params.scopeRef,
		trustTier: (params.trustTier ?? "standard") as never,
	})
	return params.slug
}
