import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadConfigFromEnv } from "./config.js"
import { pageSlugFor, SlackConnector, type SlackWriter } from "./connector.js"
import { SlackApi, SlackApiError } from "./slack-api.js"
import { emptyState, loadState } from "./state.js"

// 2026-11-17 12:00 UTC; days are UTC in these tests.
const NOW = new Date("2026-11-17T12:00:00Z")
const ts = (iso: string, n = 0) =>
	`${(Date.parse(iso) / 1000).toFixed(0)}.00000${n}`

const USERS = [
	{ id: "UME", real_name: "Test Owner", profile: { email: "owner@x.test" } },
	{
		id: "U1",
		real_name: "Kai Tester",
		profile: { display_name: "kai", email: "kai@x.test" },
	},
	{ id: "U2", real_name: "Ana Example", profile: { email: "ana@x.test" } },
	{ id: "UBOT", is_bot: true, real_name: "Deploy Bot" },
]
const CONVERSATIONS = [
	{ id: "C1", name: "eng", is_channel: true },
	{ id: "C2", name: "random", is_channel: true },
	{ id: "D1", is_im: true, user: "U1" },
	{ id: "D2", is_im: true, user: "UBOT" },
	{ id: "G1", is_mpim: true, name: "mpdm-x" },
]
const LONG =
	"We agreed the OIDC cutover happens on the 28th and Ana owns the rollback plan, with Kai writing the runbook before then."
const HISTORY: Record<string, unknown[]> = {
	C1: [
		{
			ts: ts("2026-11-16T09:00:00Z"),
			user: "U1",
			text: `<@U2> ${LONG}`,
			reply_count: 1,
			latest_reply: ts("2026-11-16T10:00:00Z"),
		},
		{
			ts: ts("2026-11-16T09:30:00Z"),
			subtype: "channel_join",
			user: "U2",
			text: "joined",
		},
		{
			ts: ts("2026-11-16T11:00:00Z"),
			user: "UME",
			text: "I'll update the dashboard, <@UME> noted.",
		},
		{
			ts: ts("2026-11-17T08:00:00Z"),
			user: "UME",
			text: "ok",
			files: [{ name: "plan.pdf", permalink: "https://files.test/plan" }],
		},
	],
	D1: [{ ts: ts("2026-11-15T18:00:00Z"), user: "U1", text: "lunch?" }],
	G1: [],
}
const REPLIES: Record<string, unknown[]> = {
	[`C1:${ts("2026-11-16T09:00:00Z")}`]: [
		{ ts: ts("2026-11-16T09:00:00Z"), user: "U1", text: "parent" },
		{
			ts: ts("2026-11-16T10:00:00Z"),
			user: "U2",
			text: "On it.",
			thread_ts: ts("2026-11-16T09:00:00Z"),
		},
	],
}

function fakeSlack(calls: string[] = [], rateLimitOnce = false) {
	let limited = rateLimitOnce
	const fetchFn = vi.fn(async (url: string | URL | Request) => {
		const u = new URL(String(url))
		const method = u.pathname.split("/").pop() as string
		calls.push(method)
		if (limited) {
			limited = false
			return new Response("", { status: 429, headers: { "retry-after": "1" } })
		}
		const q = Object.fromEntries(u.searchParams)
		const json = (b: unknown) =>
			new Response(JSON.stringify({ ok: true, ...(b as object) }), {
				status: 200,
			})
		switch (method) {
			case "auth.test":
				return json({
					user_id: "UME",
					user: "owner",
					team: "T",
					team_id: "T1",
					url: "",
				})
			case "users.list":
				return json({ members: USERS })
			case "users.conversations":
				return json({ channels: CONVERSATIONS })
			case "conversations.members":
				return json({ members: ["UME", "U1", "U2"] })
			case "conversations.history":
				return json({
					messages: (HISTORY[q.channel] ?? []).filter(
						(m) => Number((m as { ts: string }).ts) >= Number(q.oldest),
					),
				})
			case "conversations.replies":
				return json({ messages: REPLIES[`${q.channel}:${q.ts}`] ?? [] })
			default:
				return new Response(
					JSON.stringify({ ok: false, error: "unknown_method" }),
					{ status: 200 },
				)
		}
	})
	return new SlackApi("xoxp-test", {
		fetchFn: fetchFn as never,
		sleep: async () => {},
	})
}

function fakeWriter() {
	const writer = {
		rawSync: vi.fn(async (input: Parameters<SlackWriter["rawSync"]>[0]) => ({
			created: input.items.length,
			updated: 0,
			retired: 0,
		})),
		wikiMaintenance: vi.fn(async () => ({
			errors: [],
			pagesCreated: 1,
			pagesUpdated: 0,
		})),
		linkPeople: vi.fn(
			async (input: Parameters<SlackWriter["linkPeople"]>[0]) => ({
				linked: input.people.length,
				created: 0,
			}),
		),
	}
	return writer as typeof writer & SlackWriter
}

function config(extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "slack-test-"))
	return loadConfigFromEnv({
		SLACK_USER_TOKEN: "xoxp-test",
		SLACK_TIMEZONE: "UTC",
		SLACK_BACKFILL_DAYS: "3",
		SLACK_REFRESH_DAYS: "2",
		SLACK_EXCLUDE_CHANNELS: "random",
		SLACK_STATE_FILE: join(dir, "state.json"),
		...extra,
	})
}

describe("SlackConnector", () => {
	it("syncs each conversation-day, distills the substantial ones and links speakers", async () => {
		const cfg = config()
		const writer = fakeWriter()
		const state = emptyState()
		const out = await new SlackConnector(cfg, fakeSlack(), writer, state, {
			now: () => NOW,
			log: () => {},
		}).run()
		expect(out.errors).toEqual([])
		// eng, the DM with Kai and the group DM; #random excluded, bot DM skipped.
		expect(out.conversations).toBe(3)

		const engDays = writer.rawSync.mock.calls
			.map((c) => c[0])
			.filter((c) => c.channel === "C1")
		expect(engDays.map((c) => c.window.from)).toEqual([
			"2026-11-15T00:00:00.000Z",
			"2026-11-16T00:00:00.000Z",
			"2026-11-17T00:00:00.000Z",
		])
		expect(engDays.every((c) => c.excludeReplies && c.source === "slack")).toBe(
			true,
		)
		const day16 = engDays[1].items as Array<Record<string, unknown>>
		// The join is dropped; the parent and its same-day reply are kept.
		expect(day16.map((i) => i.text)).toEqual([
			`@Ana Example ${LONG}`,
			"I'll update the dashboard, @Test Owner noted.",
			"On it.",
		])
		expect(day16[2]).toMatchObject({
			metadata: { isReply: true },
			thread: `C1:${ts("2026-11-16T09:00:00Z")}`,
		})
		expect(engDays[2].items[0]).toMatchObject({
			author: "Test Owner",
			text: "ok [file: plan.pdf]",
			attachments: [{ name: "plan.pdf", ref: "https://files.test/plan" }],
		})

		// Only the long day is distilled; "ok" and "lunch?" are too short.
		expect(writer.wikiMaintenance).toHaveBeenCalledTimes(1)
		const [m] = writer.wikiMaintenance.mock.calls[0] as unknown as [
			{
				changedSources: Array<{ path: string; content: string }>
				noteDate: string
				extractTasks: boolean
			},
		]
		expect(m.changedSources[0].path).toBe("slack/eng/2026-11-16")
		expect(m.noteDate).toBe("2026-11-16")
		expect(m.extractTasks).toBe(true)
		expect(m.changedSources[0].content).toContain(
			"09:00 kai: @Ana Example We agreed",
		)
		expect(m.changedSources[0].content).toContain(
			"    ↳ 10:00 Ana Example: On it.",
		)
		// The token's owner speaks as "me" to the distiller, never by name.
		expect(m.changedSources[0].content).toContain(
			"11:00 me: I'll update the dashboard, @me noted.",
		)
		expect(m.changedSources[0].content).not.toContain("Test Owner")

		// Speakers go to the shared resolver with their full names and
		// emails; never the owner of the token, never a bot.
		expect(writer.linkPeople).toHaveBeenCalledWith({
			scope: "workspace",
			scopeRef: "default",
			slug: pageSlugFor("slack/eng/2026-11-16"),
			title: "#eng 2026-11-16",
			edgeKind: "participant",
			people: [
				{ name: "Kai Tester", email: "kai@x.test", create: true },
				{ name: "Ana Example", email: "ana@x.test", create: true },
			],
		})
		const sent = writer.linkPeople.mock.calls.flatMap(([i]) => i.people)
		expect(sent.some((p) => p.email === "owner@x.test")).toBe(false)
		expect(sent.some((p) => p.name === "Deploy Bot")).toBe(false)
		const saved = await loadState(cfg.stateFile)
		expect(Object.keys(saved.conversations).sort()).toEqual(["C1", "D1", "G1"])
		expect(saved.conversations.D1.name).toBe("DM Kai Tester")
		expect(saved.conversations.G1.name).toBe("Group DM kai, Ana Example")
	})

	it("re-reads only the refresh window once a conversation has synced", async () => {
		const cfg = config()
		const state = emptyState()
		state.conversations.C1 = {
			name: "#eng",
			firstSyncedAt: "2026-11-01T00:00:00Z",
			lastActivityTs: ts("2026-11-17T08:00:00Z"),
		}
		const writer = fakeWriter()
		await new SlackConnector(cfg, fakeSlack(), writer, state, {
			now: () => NOW,
			log: () => {},
		}).run()
		const engFroms = writer.rawSync.mock.calls
			.map((c) => c[0])
			.filter((c) => c.channel === "C1")
			.map((c) => c.window.from)
		expect(engFroms).toEqual([
			"2026-11-16T00:00:00.000Z",
			"2026-11-17T00:00:00.000Z",
		])
	})

	it("checks a quiet conversation at most once a day", async () => {
		const cfg = config()
		const state = emptyState()
		state.conversations.D1 = {
			name: "DM Kai Tester",
			firstSyncedAt: "2026-09-01T00:00:00Z",
			lastActivityTs: ts("2026-09-02T00:00:00Z"),
			lastCheckedAt: "2026-11-17T06:00:00Z",
		}
		const calls: string[] = []
		const out = await new SlackConnector(
			cfg,
			fakeSlack(calls),
			fakeWriter(),
			state,
			{ now: () => NOW, log: () => {} },
		).run()
		expect(out.skippedCold).toBe(1)
		expect(out.conversations).toBe(2)
	})

	it("writes nothing on a dry run", async () => {
		const cfg = config()
		const writer = fakeWriter()
		const lines: string[] = []
		await new SlackConnector(cfg, fakeSlack(), writer, emptyState(), {
			now: () => NOW,
			dryRun: true,
			log: (l) => lines.push(l),
		}).run()
		expect(writer.rawSync).not.toHaveBeenCalled()
		expect(writer.wikiMaintenance).not.toHaveBeenCalled()
		expect(writer.linkPeople).not.toHaveBeenCalled()
		expect(lines).toContain("  #eng 2026-11-16: 3 message(s)")
	})
})

describe("SlackApi", () => {
	it("waits out a rate limit and retries", async () => {
		const calls: string[] = []
		const api = fakeSlack(calls, true)
		await expect(api.authTest()).resolves.toMatchObject({ user_id: "UME" })
		expect(calls).toEqual(["auth.test", "auth.test"])
	})

	it("surfaces Slack's error code", async () => {
		const api = new SlackApi("xoxp-x", {
			fetchFn: (async () =>
				new Response(
					JSON.stringify({ ok: false, error: "invalid_auth" }),
				)) as never,
		})
		await expect(api.authTest()).rejects.toEqual(
			new SlackApiError("auth.test", "invalid_auth"),
		)
	})
})

describe("config", () => {
	it("insists on a user token", () => {
		expect(() => loadConfigFromEnv({ SLACK_USER_TOKEN: "xoxb-bot" })).toThrow(
			/user token/,
		)
		expect(() => loadConfigFromEnv({})).toThrow(/SLACK_USER_TOKEN/)
		expect(() =>
			loadConfigFromEnv({ SLACK_USER_TOKEN: "xoxp-1", SLACK_TYPES: "im,nope" }),
		).toThrow(/nope/)
	})
})
