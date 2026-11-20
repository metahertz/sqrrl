// Shared wiki request context.
//
// buildWikiGovContext lived inside createV1Router as a closure. The browse
// router needs exactly the same mapping — a reader browsing HTML must be
// filtered by the same governance rules as a caller reading JSON — so it
// moved here rather than being duplicated, which is how the two surfaces
// would drift apart.

import type { GovernanceContext } from "@sqrrl/wiki-engine"
import { getApiPrincipal } from "../api-context.js"

/** Maps the authenticated principal onto the governance context the wiki
 *  store filters by. */
export function buildWikiGovContext(
	c: Parameters<typeof getApiPrincipal>[0],
	scope: string,
	scopeRef: string,
): GovernanceContext {
	const principal = getApiPrincipal(c)
	return {
		scope,
		scopeRef,
		subjectId: principal.subjectId,
		groups: principal.groups,
		// The development principal is full-capability; governance sees it
		// as admin while the principal itself reports "development" for audit.
		trustTier:
			principal.trustTier === "development" ? "admin" : principal.trustTier,
		roles: principal.roles,
		departments: principal.departments,
		capabilities: principal.capabilities,
	}
}

/** Who is deciding, for work done now or later (lib/decisions.ts). */
export function actorOf(
	c: Parameters<typeof getApiPrincipal>[0],
	scope: string,
	scopeRef: string,
): import("../lib/decisions.js").Actor {
	const principal = getApiPrincipal(c)
	const {
		scope: _s,
		scopeRef: _r,
		...governance
	} = buildWikiGovContext(c, scope, scopeRef)
	return {
		subjectId: principal.subjectId,
		...(principal.displayName ? { displayName: principal.displayName } : {}),
		governance,
	}
}
