import { describe, expect, it } from "vitest"
import { applyLegacyEnv } from "./legacy-env.js"

describe("applyLegacyEnv", () => {
	it("copies old names only where the new one is unset", () => {
		const env: Record<string, string | undefined> = {
			MDBRAIN_API_URL: "http://old",
			MDBRAIN_API_KEY: "old-key",
			SQRRL_API_KEY: "new-key",
			OTHER: "x",
		}
		expect(applyLegacyEnv(env)).toEqual(["SQRRL_API_URL"])
		expect(env.SQRRL_API_URL).toBe("http://old")
		expect(env.SQRRL_API_KEY).toBe("new-key")
	})
})
