import { describe, expect, it } from "vitest"
import {
	API_KEY_TOKEN_PREFIX,
	createApiKey,
	findApiKeyByToken,
	hashApiKeyToken,
	isApiKeyUsable,
	listApiKeys,
	revokeApiKey,
	timingSafeHashEquals,
	updateApiKey,
} from "./api-keys.js"

/** Minimal in-memory stand-in for the one collection these functions touch. */
function fakeHandle() {
	const docs: Record<string, unknown>[] = []
	const matches = (d: Record<string, unknown>, f: Record<string, unknown>) =>
		Object.entries(f).every(([k, v]) => {
			if (v && typeof v === "object" && "$exists" in (v as object)) {
				return (d[k] !== undefined) === (v as { $exists: boolean }).$exists
			}
			return d[k] === v
		})
	const collection = () => ({
		insertOne: async (doc: Record<string, unknown>) => {
			if (docs.some((d) => d.subjectId === doc.subjectId)) {
				throw new Error("E11000 duplicate key error")
			}
			docs.push({ ...doc })
			return { insertedId: "x" }
		},
		findOne: async (filter: Record<string, unknown>) =>
			docs.find((d) => matches(d, filter)) ?? null,
		find: (filter: Record<string, unknown>) => ({
			sort: () => ({
				toArray: async () => docs.filter((d) => matches(d, filter)),
			}),
		}),
		findOneAndUpdate: async (
			filter: Record<string, unknown>,
			update: Record<string, Record<string, unknown>>,
		) => {
			const doc = docs.find((d) => matches(d, filter))
			if (!doc) return null
			Object.assign(doc, update.$set ?? {})
			for (const k of Object.keys(update.$unset ?? {})) delete doc[k]
			return { ...doc }
		},
		updateOne: async () => ({}),
		createIndexes: async () => undefined,
	})
	return {
		handle: { db: { collection } as never, prefix: "t_" },
		docs,
	}
}

const base = {
	subjectId: "reader",
	capabilities: ["read"],
	allowedScopes: [{ scope: "workspace", scopeRef: "default" }],
	createdBy: "api-key:admin",
}

describe("api key store", () => {
	it("returns the token once and stores only its hash", async () => {
		const { handle, docs } = fakeHandle()
		const created = await createApiKey(handle, base)
		expect(created.token.startsWith(API_KEY_TOKEN_PREFIX)).toBe(true)
		// The row must not contain the secret in any form but the digest.
		expect(docs[0].tokenHash).toBe(hashApiKeyToken(created.token))
		expect(JSON.stringify(docs[0])).not.toContain(created.token)
		// Nor may any listing hand it back.
		const listed = await listApiKeys(handle)
		expect(JSON.stringify(listed)).not.toContain(created.token)
	})

	it("resolves a live token and rejects a wrong one", async () => {
		const { handle } = fakeHandle()
		const created = await createApiKey(handle, base)
		expect(await findApiKeyByToken(handle, created.token)).not.toBeNull()
		expect(await findApiKeyByToken(handle, "mdb_sk_wrong")).toBeNull()
		expect(await findApiKeyByToken(handle, "")).toBeNull()
	})

	it("stops resolving a revoked token and drops its hash", async () => {
		const { handle, docs } = fakeHandle()
		const created = await createApiKey(handle, base)
		const revoked = await revokeApiKey(handle, created.keyId, "admin")
		expect(revoked?.revokedAt).toBeTruthy()
		expect(await findApiKeyByToken(handle, created.token)).toBeNull()
		// Belt and braces: even a regressed revocation check finds no hash to
		// match against.
		expect(docs[0].tokenHash).toBeUndefined()
	})

	it("keeps the revoked row as an audit record", async () => {
		const { handle } = fakeHandle()
		const created = await createApiKey(handle, base)
		await revokeApiKey(handle, created.keyId, "admin")
		expect(await listApiKeys(handle)).toHaveLength(0)
		const all = await listApiKeys(handle, { includeRevoked: true })
		expect(all).toHaveLength(1)
		expect(all[0].revokedBy).toBe("admin")
	})

	it("refuses a token past its expiry without any sweep", async () => {
		const { handle } = fakeHandle()
		const created = await createApiKey(handle, {
			...base,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		})
		expect(await findApiKeyByToken(handle, created.token)).not.toBeNull()
		const later = new Date(Date.now() + 120_000)
		expect(await findApiKeyByToken(handle, created.token, later)).toBeNull()
	})

	it("treats expiry and revocation as unusable, live keys as usable", () => {
		expect(isApiKeyUsable({})).toBe(true)
		expect(isApiKeyUsable({ revokedAt: "2020-01-01T00:00:00Z" })).toBe(false)
		expect(isApiKeyUsable({ expiresAt: "2020-01-01T00:00:00Z" })).toBe(false)
		expect(isApiKeyUsable({ expiresAt: "2999-01-01T00:00:00Z" })).toBe(true)
	})

	it("updates policy in place and can clear an expiry", async () => {
		const { handle } = fakeHandle()
		const created = await createApiKey(handle, {
			...base,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		})
		const updated = await updateApiKey(handle, created.keyId, {
			capabilities: ["read", "export"],
			expiresAt: null,
		})
		expect(updated?.capabilities).toEqual(["read", "export"])
		expect(updated?.expiresAt).toBeUndefined()
	})

	it("refuses to update or revoke an unknown key", async () => {
		const { handle } = fakeHandle()
		expect(
			await updateApiKey(handle, "nope", { trustTier: "admin" }),
		).toBeNull()
		expect(await revokeApiKey(handle, "nope", "admin")).toBeNull()
	})

	it("rejects a duplicate subjectId", async () => {
		const { handle } = fakeHandle()
		await createApiKey(handle, base)
		await expect(createApiKey(handle, base)).rejects.toThrow(/E11000/)
	})

	it("compares digests without short-circuiting on length", () => {
		const a = hashApiKeyToken("one")
		expect(timingSafeHashEquals(a, a)).toBe(true)
		expect(timingSafeHashEquals(a, hashApiKeyToken("two"))).toBe(false)
		expect(timingSafeHashEquals(a, "")).toBe(false)
		expect(timingSafeHashEquals(a, a.slice(0, -1))).toBe(false)
	})
})
