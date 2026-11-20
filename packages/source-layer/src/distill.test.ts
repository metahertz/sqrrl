import { beforeEach, describe, expect, it, vi } from "vitest"

const engine = vi.hoisted(() => ({
	runGitDiffMaintenance: vi.fn(),
	getWikiPage: vi.fn(),
}))
const tasks = vi.hoisted(() => ({
	listTopicLabels: vi.fn(),
	syncTasksForSource: vi.fn(),
	linkIngestedGraph: vi.fn(),
}))

vi.mock("@sqrrl/wiki-engine", () => ({
	...engine,
	// Real implementation: distill must address pages exactly as the engine
	// names them.
	sourceToSlug: (p: string) =>
		`sources/${p
			.toLowerCase()
			.replace(/[^a-z0-9/.]+/g, "-")
			.replace(/^-+|-+$/g, "")}`,
}))
vi.mock("./tasks.js", () => tasks)

import { distillChangedSources } from "./distill.js"

const handle = {} as never
const llmGenerate = vi.fn()
const OPTS = { scope: "workspace", scopeRef: "ws-1" }

function maintenance(errors: string[] = []) {
	return { pagesCreated: 2, pagesUpdated: 0, errors }
}

beforeEach(() => {
	for (const fn of [...Object.values(engine), ...Object.values(tasks)])
		fn.mockReset()
	engine.runGitDiffMaintenance.mockResolvedValue(maintenance())
	engine.getWikiPage.mockImplementation(async (_h, slug: string) => ({
		slug,
		title: `Title of ${slug}`,
	}))
	tasks.listTopicLabels.mockResolvedValue(["groceries"])
	tasks.syncTasksForSource.mockImplementation(async (_h, p) => ({
		slugs: [`tasks/from-${p.sourceSlug}`],
		created: 1,
		updated: 0,
		reopened: 0,
		dropped: 0,
		kept: 0,
		errors: [],
	}))
	tasks.linkIngestedGraph.mockResolvedValue({
		peopleCreated: 1,
		topicsCreated: 0,
		edgesAdded: 2,
		errors: [],
	})
})

const CHANGED = [
	{ path: "apple-notes/A.md", content: "Dana will ship it by Friday" },
	{ path: "apple-notes/B.md", content: "Buy milk" },
]

describe("distillChangedSources", () => {
	it("writes pages only, and never builds an extractor, unless asked", async () => {
		const createExtractor = vi.fn()
		const out = await distillChangedSources(
			handle,
			CHANGED,
			{ llmGenerate, createExtractor },
			OPTS,
		)
		expect(out).toEqual(maintenance())
		expect(createExtractor).not.toHaveBeenCalled()
		expect(engine.runGitDiffMaintenance).toHaveBeenCalledWith(
			handle,
			CHANGED,
			llmGenerate,
			{ scope: "workspace", scopeRef: "ws-1" },
		)
	})

	it("skips extraction when page maintenance reported errors", async () => {
		engine.runGitDiffMaintenance.mockResolvedValue(maintenance(["boom"]))
		const createExtractor = vi.fn()
		const out = await distillChangedSources(
			handle,
			CHANGED,
			{ llmGenerate, createExtractor },
			{ ...OPTS, extractTasks: true },
		)
		expect(out.tasks).toBeUndefined()
		expect(createExtractor).not.toHaveBeenCalled()
	})

	it("extracts, syncs and links each source in order, summing the results", async () => {
		const extractor = vi.fn(async () => ({
			tasks: [{ title: "t", owner: "Dana" }],
			topics: ["shopping"],
		}))
		const out = await distillChangedSources(
			handle,
			CHANGED,
			{ llmGenerate, createExtractor: () => extractor as never },
			{
				...OPTS,
				extractTasks: true,
				noteDate: "2026-11-17",
				trustTier: "standard",
			},
		)
		// The vocabulary is re-read per source, so a hub made for A is offered to B.
		expect(tasks.listTopicLabels).toHaveBeenCalledTimes(2)
		expect(extractor).toHaveBeenNthCalledWith(1, {
			sourcePath: "apple-notes/A.md",
			noteDate: "2026-11-17",
			text: "Dana will ship it by Friday",
			existingTopics: ["groceries"],
		})
		const syncSlugs = tasks.syncTasksForSource.mock.calls.map(
			(c) => c[1].sourceSlug,
		)
		expect(syncSlugs).toEqual([
			"sources/apple-notes/a.md",
			"sources/apple-notes/b.md",
		])
		expect(tasks.syncTasksForSource.mock.calls[0][1]).toMatchObject({
			sourceTitle: "Title of sources/apple-notes/a.md",
			noteDate: "2026-11-17",
			trustTier: "standard",
		})
		expect(tasks.linkIngestedGraph.mock.calls[0][1].taskSlugs).toEqual([
			"tasks/from-sources/apple-notes/a.md",
		])
		expect(out.tasks).toEqual({
			created: 2,
			updated: 0,
			reopened: 0,
			dropped: 0,
			kept: 0,
			peopleCreated: 2,
			topicsCreated: 0,
			edgesAdded: 4,
		})
	})

	it("skips a source whose page was not written", async () => {
		engine.getWikiPage.mockImplementation(async (_h, slug: string) =>
			slug.endsWith("a.md") ? null : { slug, title: "B" },
		)
		const extractor = vi.fn(async () => ({ tasks: [], topics: [] }))
		await distillChangedSources(
			handle,
			CHANGED,
			{ llmGenerate, createExtractor: () => extractor as never },
			{ ...OPTS, extractTasks: true },
		)
		expect(extractor).toHaveBeenCalledTimes(1)
		expect(extractor.mock.calls[0][0]).toMatchObject({
			sourcePath: "apple-notes/B.md",
		})
	})

	it("defaults noteDate to today", async () => {
		const extractor = vi.fn(async () => ({ tasks: [], topics: [] }))
		await distillChangedSources(
			handle,
			CHANGED.slice(0, 1),
			{ llmGenerate, createExtractor: () => extractor as never },
			{ ...OPTS, extractTasks: true },
		)
		expect(extractor.mock.calls[0][0].noteDate).toBe(
			new Date().toISOString().slice(0, 10),
		)
	})

	it("in parallel mode reads the vocabulary once and survives one failed extraction", async () => {
		const extractor = vi.fn(async (input: { sourcePath: string }) => {
			if (input.sourcePath.endsWith("A.md")) throw new Error("model timeout")
			return { tasks: [], topics: [] }
		})
		const out = await distillChangedSources(
			handle,
			CHANGED,
			{ llmGenerate, createExtractor: () => extractor as never },
			{ ...OPTS, extractTasks: true, parallelExtraction: true },
		)
		expect(tasks.listTopicLabels).toHaveBeenCalledTimes(1)
		expect(out.errors).toEqual(["apple-notes/A.md: model timeout"])
		expect(tasks.syncTasksForSource).toHaveBeenCalledTimes(1)
		expect(tasks.syncTasksForSource.mock.calls[0][1].sourceSlug).toBe(
			"sources/apple-notes/b.md",
		)
	})

	it("redacts secrets before the page LLM and the extractor see the text", async () => {
		const extractor = vi.fn(async () => ({ tasks: [], topics: [] }))
		const leaky = [
			{
				path: "apple-notes/C.md",
				content: "DB_PASSWORD=Zx9Qw8Er7Ty6 for prod",
			},
		]
		const out = await distillChangedSources(
			handle,
			leaky,
			{ llmGenerate, createExtractor: () => extractor as never },
			{ ...OPTS, extractTasks: true },
		)
		const sentToPages = engine.runGitDiffMaintenance.mock.calls[0][1]
		expect(sentToPages[0].content).toBe(
			"DB_PASSWORD=[REDACTED:assignment] for prod",
		)
		expect(extractor.mock.calls[0][0].text).toBe(
			"DB_PASSWORD=[REDACTED:assignment] for prod",
		)
		expect(out.redacted).toEqual({ assignment: 1 })
		// The caller's array is not mutated.
		expect(leaky[0].content).toContain("Zx9Qw8Er7Ty6")
	})

	it("lets a missing extractor configuration propagate to the caller", async () => {
		class NotConfigured extends Error {}
		await expect(
			distillChangedSources(
				handle,
				CHANGED,
				{
					llmGenerate,
					createExtractor: () => {
						throw new NotConfigured("no model")
					},
				},
				{ ...OPTS, extractTasks: true },
			),
		).rejects.toBeInstanceOf(NotConfigured)
	})
})
