import { beforeEach, describe, expect, it, vi } from "vitest"

const engine = vi.hoisted(() => ({ addRelationships: vi.fn() }))
const store = vi.hoisted(() => ({ listRawItemsInUnit: vi.fn() }))
const distill = vi.hoisted(() => ({ distillChangedSources: vi.fn() }))
const people = vi.hoisted(() => ({ resolvePersonHub: vi.fn() }))

vi.mock("@sqrrl/wiki-engine", () => ({
	...engine,
	sourceToSlug: (p: string) => `sources/${p}`,
}))
vi.mock("./raw-items.js", () => store)
vi.mock("./distill.js", () => distill)
vi.mock("./people.js", async (orig) => ({
	...(await orig<typeof import("./people.js")>()),
	...people,
}))

import { distillEmailThreads, renderThread, threadPath } from "./email.js"
import type { RawItemView } from "./raw-items.js"

const me = { name: "Test Owner", email: "owner@x.test", self: true }
const kai = { name: "Kai Tester", email: "kai@x.test" }
const ana = { name: "Ana Example", email: "ana@x.test" }

function msg(
	id: string,
	at: string,
	from: typeof kai,
	to: (typeof kai)[],
	body: string,
	cc: (typeof kai)[] = [],
): RawItemView {
	return {
		id,
		source: "email",
		sourceId: id,
		kind: "email",
		title: "Re: OIDC cutover",
		occurredAt: new Date(at),
		text: `From: x\nSubject: Re: OIDC cutover\n\n${body}`,
		metadata: { subject: "OIDC cutover", from, to, cc },
	} as unknown as RawItemView
}

const THREAD = [
	msg(
		"m2",
		"2026-11-17T10:00:00Z",
		kai,
		[me],
		"Agreed, the 28th. Ana owns rollback.",
		[ana],
	),
	msg(
		"m1",
		"2026-11-16T09:00:00Z",
		me,
		[kai],
		"Can we cut over to OIDC on the 28th? I will write the runbook by Friday.",
	),
]

beforeEach(() => {
	for (const f of [
		engine.addRelationships,
		store.listRawItemsInUnit,
		distill.distillChangedSources,
		people.resolvePersonHub,
	])
		f.mockReset()
	store.listRawItemsInUnit.mockResolvedValue(THREAD)
	distill.distillChangedSources.mockResolvedValue({
		errors: [],
		pagesCreated: 1,
		pagesUpdated: 0,
		tasks: { created: 2 },
	})
	people.resolvePersonHub.mockImplementation(
		async (_h, p: { name: string; email: string }) => ({
			slug: `people/${p.name.toLowerCase().replace(/ /g, "-")}`,
			title: p.name,
			created: false,
		}),
	)
})

describe("renderThread", () => {
	it("reads oldest first, with who wrote to whom and only the new text", () => {
		expect(renderThread(THREAD)).toBe(
			[
				"Email thread: OIDC cutover",
				"2 message(s)",
				"",
				"[2026-11-16 09:00] me → Kai Tester",
				"Can we cut over to OIDC on the 28th? I will write the runbook by Friday.",
				"",
				"[2026-11-17 10:00] Kai Tester → me (cc Ana Example)",
				"Agreed, the 28th. Ana owns rollback.",
			].join("\n"),
		)
	})
})

describe("threadPath", () => {
	it("is stable per thread, ignores Re:/Fwd:, and separates same-subject threads", () => {
		const a = threadPath(
			"root-a@x",
			"Re: Fwd: Update",
			new Date("2026-11-16T00:00:00Z"),
		)
		expect(a).toMatch(/^email\/2026-11\/update-[0-9a-f]{6}$/)
		expect(
			threadPath("root-a@x", "Update", new Date("2026-11-16T00:00:00Z")),
		).toBe(a)
		expect(
			threadPath("root-b@x", "Update", new Date("2026-11-16T00:00:00Z")),
		).not.toBe(a)
	})
})

describe("distillEmailThreads", () => {
	const deps = { llmGenerate: vi.fn(), createExtractor: vi.fn() }
	const OPTS = { scope: "workspace", scopeRef: "default" }

	it("distills each thread once as a note dated by its last message", async () => {
		const out = await distillEmailThreads(
			{} as never,
			["m1@x", "m1@x"],
			deps,
			OPTS,
		)
		expect(out).toMatchObject({
			threads: 1,
			distilled: 1,
			tasksCreated: 2,
			errors: [],
		})
		expect(store.listRawItemsInUnit).toHaveBeenCalledWith(
			{},
			{ ...OPTS, unit: "email:m1@x" },
		)
		const [, sources, , options] = distill.distillChangedSources.mock.calls[0]
		expect(sources[0].path).toMatch(/^email\/2026-11\/oidc-cutover-/)
		expect(sources[0].content).toContain("me → Kai Tester")
		expect(options).toMatchObject({
			extractTasks: true,
			noteDate: "2026-11-17",
		})
	})

	it("links correspondents; only someone who wrote may get a new hub", async () => {
		await distillEmailThreads({} as never, ["m1@x"], deps, OPTS)
		const calls = people.resolvePersonHub.mock.calls.map((c) => [
			c[1].email,
			c[2].allowCreate,
		])
		expect(calls).toEqual([
			["kai@x.test", true],
			["ana@x.test", false],
		])
		const [, slug, , , edges] = engine.addRelationships.mock.calls[0]
		expect(slug).toMatch(/^sources\/email\/2026-11\/oidc-cutover-/)
		expect(
			edges.map(
				(e: { targetPageSlug: string; kind: string }) =>
					`${e.kind}:${e.targetPageSlug}`,
			),
		).toEqual([
			"participant:people/kai-tester",
			"participant:people/ana-example",
		])
	})

	it("creates no hubs for a large thread", async () => {
		const crowd = Array.from({ length: 8 }, (_, i) => ({
			name: `P${i}`,
			email: `p${i}@x.test`,
		}))
		store.listRawItemsInUnit.mockResolvedValue([
			msg(
				"m9",
				"2026-11-17T10:00:00Z",
				kai,
				crowd,
				"All hands notes: the migration is done and the old IdP retires on Monday.",
			),
		])
		await distillEmailThreads({} as never, ["m9@x"], deps, OPTS)
		expect(
			people.resolvePersonHub.mock.calls.every(
				(c) => c[2].allowCreate === false,
			),
		).toBe(true)
	})

	it("reports a failed distill and carries on", async () => {
		distill.distillChangedSources.mockResolvedValueOnce({
			errors: ["llm down"],
			pagesCreated: 0,
			pagesUpdated: 0,
		})
		const out = await distillEmailThreads(
			{} as never,
			["a@x", "b@x"],
			deps,
			OPTS,
		)
		expect(out.distilled).toBe(1)
		expect(out.errors[0]).toMatch(/llm down/)
	})
})
