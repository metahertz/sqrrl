import type { Context } from "hono"
import type { WikiScope } from "@sqrrl/wiki-engine"
import type { ApiPrincipal } from "./principal.js"

export type AuthorizedRequestScope = {
	agentId?: string
	scope?: WikiScope
	scopeRef?: string
}

export type ApiEnvironment = {
	Variables: {
		principal: ApiPrincipal
		authorizedRequestScope: AuthorizedRequestScope
		/** True only when the request authenticated with SQRRL_API_KEY
		 *  itself. Key management is gated on this rather than on a
		 *  capability: a scoped key policy can name any trustTier and any
		 *  capability it likes, so a capability check would let a scoped key
		 *  mint further keys and escalate itself. */
		isMasterKey: boolean
	}
}

export function getApiPrincipal(c: Context<ApiEnvironment>): ApiPrincipal {
	return c.get("principal")
}

export function isMasterKeyRequest(c: Context<ApiEnvironment>): boolean {
	return c.get("isMasterKey") === true
}

export function getAuthorizedRequestScope(
	c: Context<ApiEnvironment>,
): AuthorizedRequestScope {
	return c.get("authorizedRequestScope")
}
