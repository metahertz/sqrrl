import { describe, expect, it } from "vitest"
import { parseCookie, serializeCookie } from "./api-key-store.js"

describe("parseCookie", () => {
	it("finds the key among other cookies", () => {
		expect(parseCookie("theme=dark; mdbrain_api_key=abc123; other=1")).toBe(
			"abc123",
		)
	})

	it("returns empty when the cookie is absent", () => {
		expect(parseCookie("theme=dark")).toBe("")
		expect(parseCookie("")).toBe("")
	})

	it("does not match a cookie whose name merely ends with ours", () => {
		expect(parseCookie("old_mdbrain_api_key=nope")).toBe("")
	})

	it("round-trips a value needing escaping", () => {
		const key = "a b;c=d%e"
		const raw = serializeCookie(key, { secure: false }).split(";")[0]
		expect(parseCookie(raw)).toBe(key)
	})

	it("returns empty rather than throwing on a malformed value", () => {
		expect(parseCookie("mdbrain_api_key=%E0%A4%A")).toBe("")
	})
})

describe("serializeCookie", () => {
	it("scopes the cookie and keeps it same-site", () => {
		const out = serializeCookie("abc", { secure: false })
		expect(out).toContain("mdbrain_api_key=abc")
		expect(out).toContain("path=/")
		expect(out).toContain("SameSite=Strict")
		expect(out).toContain("max-age=1209600")
	})

	it("omits Secure over plain http, so the cookie actually persists", () => {
		expect(serializeCookie("abc", { secure: false })).not.toContain("Secure")
		expect(serializeCookie("abc", { secure: true })).toContain("Secure")
	})

	it("expires immediately when clearing", () => {
		expect(serializeCookie("", { secure: false, maxAge: 0 })).toContain(
			"max-age=0",
		)
	})
})
