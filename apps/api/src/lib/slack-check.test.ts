import { describe, expect, it, vi } from "vitest"
import { checkSlackToken, SLACK_SCOPES, slackError } from "./slack-check.js"

/** A Slack stand-in: answers by method name. */
function fakeSlack(
	answers: Record<string, Array<Record<string, unknown>>>,
	scopes = SLACK_SCOPES.join(","),
) {
	const seen: string[] = []
	const f = vi.fn(async (url: string, init?: RequestInit) => {
		const method = new URL(url).pathname.split("/").pop() ?? ""
		seen.push(method)
		expect(
			((init?.headers ?? {}) as Record<string, string>).authorization,
		).toBe("Bearer xoxp-1")
		const queue = answers[method] ?? [{ ok: false, error: "unknown_method" }]
		const body = queue.length > 1 ? queue.shift() : queue[0]
		return new Response(JSON.stringify(body), {
			headers: { "x-oauth-scopes": scopes },
		})
	})
	return { f: f as unknown as typeof fetch, seen }
}

describe("checkSlackToken", () => {
	it("says whose token it is and counts what it can read", async () => {
		const { f } = fakeSlack({
			"auth.test": [
				{
					ok: true,
					team: "Acme",
					user: "matt",
					url: "https://acme.slack.com/",
				},
			],
			"users.conversations": [
				{
					ok: true,
					channels: [{ id: "C1" }, { id: "G1", is_private: true }],
					response_metadata: { next_cursor: "p2" },
				},
				{
					ok: true,
					channels: [
						{ id: "D1", is_im: true },
						{ id: "M1", is_mpim: true },
					],
				},
			],
		})
		const out = await checkSlackToken("xoxp-1", { fetch: f })
		expect(out).toMatchObject({
			ok: true,
			team: "Acme",
			user: "matt",
			missingScopes: [],
			conversations: {
				total: 4,
				more: false,
				byType: { channel: 1, "private channel": 1, dm: 1, "group dm": 1 },
			},
		})
		expect(JSON.stringify(out)).not.toContain("xoxp-1")
	})

	it("reports missing scopes and Slack errors in words", async () => {
		const partial = fakeSlack(
			{
				"auth.test": [{ ok: true, team: "Acme", user: "matt" }],
				"users.conversations": [{ ok: true, channels: [] }],
			},
			"channels:read,users:read",
		)
		const out = await checkSlackToken("xoxp-1", { fetch: partial.f })
		expect(out.ok).toBe(false)
		expect(out.missingScopes).toContain("im:history")
		const bad = fakeSlack({
			"auth.test": [{ ok: false, error: "invalid_auth" }],
		})
		expect(await checkSlackToken("xoxp-1", { fetch: bad.f })).toMatchObject({
			ok: false,
			error: "Slack does not recognize this token",
		})
		expect(bad.seen).toEqual(["auth.test"])
		expect(slackError("weird_thing")).toBe("Slack said: weird_thing")
	})
})
