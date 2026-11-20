/**
 * Response shapes for the wiki routes of the sqrrl HTTP API.
 */

/** Result of adding and removing relationships on a wiki page. */
export type SqrrlWikiRelationshipEditResult = {
	removed: number
	added: number
	page: unknown
}

/** Result of folding one wiki page into another. */
export type SqrrlWikiMergeResult = {
	/** Edges on other pages that were repointed at the winner. */
	edgesRepointed: number
	inboundPagesTouched: number
	/** The loser's own outbound edges that the winner did not already have. */
	outboundEdgesMoved: number
	claimsMoved: number
	errors: string[]
}

/** Result of moving a task to a different owner or source. */
/** Result of POST /v1/wiki/maintenance (source git-diff). */
export type SqrrlWikiMaintenanceResult = {
	source: string
	pagesProcessed: number
	pagesRegenerated: number
	pagesCreated: number
	pagesUpdated: number
	claimsAdded: number
	claimsRejected: number
	contradictionsDetected: number
	/** Per-source failures. Non-empty means some sources were not written. */
	errors: string[]
	tasks?: {
		created: number
		updated: number
		reopened: number
		dropped: number
		kept: number
		peopleCreated?: number
		topicsCreated?: number
		edgesAdded?: number
	}
}

export type SqrrlWikiReassignResult = {
	ownerChanged: boolean
	sourceChanged: boolean
	edgesAdded: number
	edgesRemoved: number
}

/** Result of permanently removing a wiki page and its history. */
export type SqrrlWikiPurgeResult = {
	/** Slugs actually removed, including cascaded tasks. */
	pagesPurged: string[]
	revisionsDeleted: number
	/** Edges on surviving pages that pointed at something purged. */
	inboundEdgesRemoved: number
	errors: string[]
}
