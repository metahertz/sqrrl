import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveApiBaseUrl } from "./api-base.js"

const original = process.env.NEXT_PUBLIC_SQRRL_API_URL

afterEach(() => {
	process.env.NEXT_PUBLIC_SQRRL_API_URL = original
	vi.unstubAllGlobals()
})

describe("resolveApiBaseUrl", () => {
	it("prefers an explicitly configured build-time URL", () => {
		process.env.NEXT_PUBLIC_SQRRL_API_URL = "https://api.example.com"
		vi.stubGlobal("window", {
			location: { protocol: "http:", hostname: "elsewhere" },
		})
		expect(resolveApiBaseUrl()).toBe("https://api.example.com")
	})

	it("derives the origin from the page when nothing was configured", () => {
		process.env.NEXT_PUBLIC_SQRRL_API_URL = ""
		vi.stubGlobal("window", {
			location: { protocol: "http:", hostname: "sqrrl.example.internal" },
		})
		// The bug this guards: a build without the env var used to hardcode
		// loopback, so every remote viewer called their own machine.
		expect(resolveApiBaseUrl()).toBe("http://sqrrl.example.internal:3847")
	})

	it("falls back to loopback when there is no window (prerender)", () => {
		process.env.NEXT_PUBLIC_SQRRL_API_URL = ""
		vi.stubGlobal("window", undefined)
		expect(resolveApiBaseUrl()).toBe("http://127.0.0.1:3847")
	})
})
