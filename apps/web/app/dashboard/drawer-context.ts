import type { SqrrlClient } from "@sqrrl/client"
import type { WikiPage } from "./shared.js"
import type { QueuedDecision } from "./decision-queue.js"
import type { Suggestion } from "./suggestion-panel.js"

/** What a write changed, so the console refreshes only that: pages to
 *  refetch (a page that is gone drops out), the suggestion lists, or - for
 *  merges and identity changes that move links across many pages -
 *  everything. Nothing is reloaded when it is omitted. */
export type Refresh = { pages?: string[]; lists?: boolean; all?: boolean }

export type RunFn = (
	label: string,
	fn: () => Promise<unknown>,
	refresh?: Refresh,
) => Promise<boolean>

/** What every drawer tab needs: the page, the scope it lives in, and the
 *  console's write path. */
export type DrawerCtx = {
	page: WikiPage
	pages: WikiPage[]
	client: SqrrlClient
	scope: string
	scopeRef: string
	apiBase: string
	/** Runs a write, refreshes what it changed, reports it. Resolves true on
	 *  success, so a tab can leave edit mode only when the save landed. */
	run: RunFn
	/** Queues an accept/dismiss and hides the item until it settles. */
	decide: (d: QueuedDecision) => void
	busy: boolean
	/** Opens another page in the drawer (links, backlinks, [[wikilinks]]). */
	openSlug: (slug: string) => void
	/** Pending suggestions to close tasks, for the task panel. */
	suggestions?: Suggestion[]
}

export const EDGE_KINDS = [
	"relates_to",
	"mentions",
	"depends_on",
	"part_of",
	"owned_by",
	"attended_by",
	"derived_from",
	"supersedes",
]

/** Human words for edge kinds; unknown kinds show as written. */
export function edgeLabel(kind: string): string {
	return kind.replace(/_/g, " ")
}

/** The human part of an API error: the client surfaces the response body,
 *  which for this API is {"error":{"code","message"}}. */
export function errorText(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err)
	const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
	return m ? m[1].replace(/\\"/g, '"') : raw
}

/** True when an error is the API's 409 for a page that changed meanwhile. */
export function isRevisionConflict(err: unknown): boolean {
	const e = err as { status?: number; code?: string; message?: string }
	return (
		e?.status === 409 ||
		e?.code === "REVISION_CONFLICT" ||
		/REVISION_CONFLICT|409/.test(String(e?.message ?? ""))
	)
}
