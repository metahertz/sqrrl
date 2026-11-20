import { describe, expect, it } from "vitest"
import { principalFromApiKeyRecord } from "./principal.js"

const good = {
	subjectId: "reader",
	capabilities: ["read"],
	allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
	allowedAgentIds: ["*"],
	trustTier: "standard",
}

describe("principalFromApiKeyRecord", () => {
	it("builds a principal from a well-formed row", () => {
		const p = principalFromApiKeyRecord(good)
		expect(p?.subjectId).toBe("reader")
		expect(p?.capabilities).toEqual(["read"])
		expect(p?.identityState).toBe("active")
	})

	it("never grants roles or groups a stored row asks for", () => {
		// A row is data, not policy: it cannot smuggle in role-based authority
		// by adding fields the store does not model.
		const p = principalFromApiKeyRecord({
			...good,
			...({ roles: ["admin"], groups: ["ops"] } as object),
		})
		expect(p?.roles).toEqual([])
		expect(p?.groups).toEqual([])
	})

	it("refuses the development trust tier", () => {
		// "development" is the fail-open local principal. A stored key claiming
		// it would inherit an identity meant only for an unauthenticated
		// localhost session.
		expect(
			principalFromApiKeyRecord({ ...good, trustTier: "development" }),
		).toBeNull()
	})

	it("refuses unknown capabilities, tiers and scopes", () => {
		expect(
			principalFromApiKeyRecord({ ...good, capabilities: ["root"] }),
		).toBeNull()
		expect(
			principalFromApiKeyRecord({ ...good, trustTier: "superuser" }),
		).toBeNull()
		expect(
			principalFromApiKeyRecord({
				...good,
				allowedScopes: [{ scope: "everything", scopeRef: "*" }],
			}),
		).toBeNull()
	})

	it("refuses rows with nothing granted", () => {
		expect(principalFromApiKeyRecord({ ...good, capabilities: [] })).toBeNull()
		expect(principalFromApiKeyRecord({ ...good, allowedScopes: [] })).toBeNull()
		expect(principalFromApiKeyRecord({ ...good, subjectId: " " })).toBeNull()
		expect(
			principalFromApiKeyRecord({
				...good,
				allowedScopes: [{ scope: "workspace", scopeRef: "" }],
			}),
		).toBeNull()
	})

	it("accepts a wildcard scope grant", () => {
		const p = principalFromApiKeyRecord({
			...good,
			allowedScopes: [{ scope: "*", scopeRef: "*" }],
		})
		expect(p?.allowedScopes).toEqual([{ scope: "*", scopeRef: "*" }])
	})
})
