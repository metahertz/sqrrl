// POST /v1/raw/mail: skipping, dedupe, which threads are distilled, and auth.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const source = vi.hoisted(() => ({
	ensureRawItemsSchema: vi.fn(),
	upsertRawItems: vi.fn(),
	distillEmailThreads: vi.fn(),
}))
const store = vi.hoisted(() => ({
	getWikiStoreHandle: vi.fn(),
	withWikiTransaction: vi.fn(),
}))
const llm = vi.hoisted(() => ({ createLlmGenerate: vi.fn() }))

vi.mock("@sqrrl/source-layer", async (importOriginal) => ({
	...(await importOriginal<typeof import("@sqrrl/source-layer")>()),
	...source,
}))
vi.mock("./wiki-store-runtime.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wiki-store-runtime.js")>()),
	...store,
}))
vi.mock("./lib/llm-generate.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/llm-generate.js")>()),
	createLlmGenerate: llm.createLlmGenerate,
}))

import { LlmNotConfiguredError } from "./lib/llm-generate.js"

const MASTER = "master-token"
const READER = "reader-token"
const HANDLE = { db: {}, prefix: "t_" }
const SCOPE = { scope: "workspace", scopeRef: "default" }

const message = (id: string, extra: Record<string, unknown> = {}) => ({
	mailbox: "inbox",
	messageId: `<${id}@x.test>`,
	subject: "Re: plan",
	sender: "Kai <kai@x.test>",
	dateSent: "2026-11-17T10:00:00Z",
	headers: `Message-ID: <${id}@x.test>\r\nReferences: <root@x.test>`,
	content: "Sounds good, the 28th it is.",
	to: [{ address: "owner@x.test" }],
	...extra,
})

let createApp: typeof import("./app.js").createApp

beforeEach(async () => {
	vi.resetModules()
	process.env.SQRRL_API_KEY = MASTER
	process.env.SQRRL_API_SCOPED_KEYS = JSON.stringify([
		{
			token: READER,
			subjectId: "reader",
			trustTier: "standard",
			capabilities: ["read"],
			scopes: ["workspace"],
			scopeRefs: ["default"],
			agentIds: ["*"],
		},
	])
	;({ createApp } = await import("./app.js"))
	store.getWikiStoreHandle.mockResolvedValue(HANDLE)
	store.withWikiTransaction.mockImplementation(async (op) => op(HANDLE, "s"))
	source.ensureRawItemsSchema.mockResolvedValue(undefined)
	source.upsertRawItems.mockImplementation(
		async (_h, items: Array<{ sourceId: string }>) =>
			items.map((i) => ({
				source: "email",
				sourceId: i.sourceId,
				version: 1,
				status: "created",
				id: i.sourceId,
			})),
	)
	source.distillEmailThreads.mockResolvedValue({
		threads: 1,
		distilled: 1,
		tasksCreated: 0,
		peopleCreated: 0,
		peopleLinked: 1,
		errors: [],
	})
	llm.createLlmGenerate.mockReturnValue(vi.fn())
})

afterEach(() => {
	delete process.env.SQRRL_API_KEY
	delete process.env.SQRRL_API_SCOPED_KEYS
	vi.clearAllMocks()
})

function post(body: unknown, token = MASTER) {
	return createApp().request("/v1/raw/mail", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	})
}

describe("POST /v1/raw/mail", () => {
	it("skips bulk mail, stores a message once, and distills its thread", async () => {
		const res = await post({
			...SCOPE,
			selfAddresses: ["owner@x.test"],
			messages: [
				message("m1"),
				message("m1", { mailbox: "sent" }),
				message("news", {
					headers:
						"Message-ID: <news@x.test>\r\nList-Unsubscribe: <mailto:u@x>",
				}),
				message("invite", {
					subject: "Invitation: Standup @ Mon",
					headers: "Message-ID: <invite@x.test>",
				}),
			],
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			received: 4,
			created: 1,
			skipped: { bulk: 1, calendar: 1, "no-id": 0, empty: 0 },
			threads: { distilled: 1 },
		})
		const [, items, opts] = source.upsertRawItems.mock.calls[0]
		expect(items.map((i: { sourceId: string }) => i.sourceId)).toEqual([
			"m1@x.test",
		])
		expect(opts).toMatchObject({ ...SCOPE, writer: expect.any(String) })
		expect(source.distillEmailThreads).toHaveBeenCalledWith(
			HANDLE,
			["root@x.test"],
			expect.any(Object),
			SCOPE,
		)
	})

	it("distills nothing when nothing changed, unless asked to redistill", async () => {
		source.upsertRawItems.mockImplementation(
			async (_h, items: Array<{ sourceId: string }>) =>
				items.map((i) => ({
					source: "email",
					sourceId: i.sourceId,
					version: 1,
					status: "unchanged",
					id: i.sourceId,
				})),
		)
		const quiet = await (
			await post({ ...SCOPE, messages: [message("m1")] })
		).json()
		expect(quiet).not.toHaveProperty("threads")
		expect(source.distillEmailThreads).not.toHaveBeenCalled()
		await post({ ...SCOPE, messages: [message("m1")], redistill: true })
		expect(source.distillEmailThreads).toHaveBeenCalledTimes(1)
	})

	it("stores but does not distill without an LLM", async () => {
		llm.createLlmGenerate.mockImplementation(() => {
			throw new LlmNotConfiguredError("no llm")
		})
		const out = await (
			await post({ ...SCOPE, messages: [message("m1")] })
		).json()
		expect(out).toMatchObject({ created: 1, threads: "llm-not-configured" })
	})

	it("validates, and needs the write capability", async () => {
		expect((await post({ ...SCOPE, messages: "x" })).status).toBe(400)
		expect(
			(
				await post({
					...SCOPE,
					messages: [{ ...message("m1"), mailbox: "drafts" }],
				})
			).status,
		).toBe(400)
		expect(
			(await post({ scope: "global", scopeRef: "x", messages: [] })).status,
		).toBe(400)
		expect(
			(await post({ ...SCOPE, messages: [message("m1")] }, READER)).status,
		).toBe(403)
		expect(source.upsertRawItems).not.toHaveBeenCalled()
	})
})
