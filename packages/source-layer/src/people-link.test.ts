// linkPeopleToPage: one resolver call per person, full references first,
// creation only for people marked create on a small page, one edge per hub.

import { beforeEach, describe, expect, it, vi } from "vitest"

const engine = vi.hoisted(() => ({ addRelationships: vi.fn() }))
vi.mock("@sqrrl/wiki-engine", async (orig) => ({
	...(await orig<typeof import("@sqrrl/wiki-engine")>()),
	...engine,
}))
const people = vi.hoisted(() => ({ resolvePersonHub: vi.fn() }))
vi.mock("./people.js", async (orig) => ({
	...(await orig<typeof import("./people.js")>()),
	...people,
}))

import {
	LinkPeopleError,
	linkPeopleToPage,
	readLinkPeople,
} from "./people-link.js"

const handle = {} as never
const BASE = { scope: "workspace", scopeRef: "default", slug: "sources/x" }

beforeEach(() => {
	vi.clearAllMocks()
	engine.addRelationships.mockImplementation(
		async (_h, _s, _sc, _r, edges: unknown[]) => edges.length,
	)
	people.resolvePersonHub.mockImplementation(
		async (_h, ref: { name?: string; email?: string }) => {
			if (ref.email === "taylor@x.test" || ref.name === "Taylor")
				return {
					slug: "people/taylor-morgan",
					title: "Taylor Morgan",
					created: false,
				}
			if (ref.name === "Nobody") return undefined
			return { slug: "people/new", title: ref.name, created: true }
		},
	)
})

describe("linkPeopleToPage", () => {
	it("resolves full references first and passes them as context", async () => {
		const out = await linkPeopleToPage(handle, {
			...BASE,
			title: "#eng 2026-11-16",
			people: [
				{ name: "Taylor" },
				{ name: "Taylor Morgan", email: "taylor@x.test" },
			],
		})
		const calls = people.resolvePersonHub.mock.calls
		expect(calls[0][1]).toEqual({
			name: "Taylor Morgan",
			email: "taylor@x.test",
		})
		expect(calls[1][2].context).toEqual(["people/taylor-morgan"])
		expect(calls[1][2].from).toEqual({
			slug: "sources/x",
			title: "#eng 2026-11-16",
			edgeKind: "participant",
		})
		// Both resolve to one hub: one edge.
		expect(out.linked).toBe(1)
		expect(out.resolved).toEqual([
			{ slug: "people/taylor-morgan", title: "Taylor Morgan" },
			{ slug: "people/taylor-morgan", title: "Taylor Morgan" },
		])
	})

	it("creates only people marked create, and only on a small page", async () => {
		await linkPeopleToPage(handle, {
			...BASE,
			people: [{ name: "Ana Example", create: true }, { name: "Bo Other" }],
		})
		const opts = people.resolvePersonHub.mock.calls.map((c) => c[2].allowCreate)
		expect(opts.sort()).toEqual([false, true])

		vi.clearAllMocks()
		await linkPeopleToPage(handle, {
			...BASE,
			maxNewPeople: 1,
			people: [
				{ name: "Ana Example", create: true },
				{ name: "Bo Other", create: true },
			],
		})
		expect(
			people.resolvePersonHub.mock.calls.every(
				(c) => c[2].allowCreate === false,
			),
		).toBe(true)
	})

	it("skips references that resolve to nothing", async () => {
		const out = await linkPeopleToPage(handle, {
			...BASE,
			people: [{ name: "Nobody" }],
		})
		expect(out).toEqual({ linked: 0, created: 0, resolved: [null] })
	})
})

describe("readLinkPeople", () => {
	it("keeps names, emails, create and a sane weight", () => {
		expect(
			readLinkPeople([
				{ name: " Ana ", email: "a@x.test", create: true, weight: 0.7 },
				{ email: "b@x.test", weight: 5 },
			]),
		).toEqual([
			{ name: "Ana", email: "a@x.test", create: true, weight: 0.7 },
			{ email: "b@x.test" },
		])
	})

	it("rejects bad input", () => {
		expect(() => readLinkPeople("x")).toThrow(LinkPeopleError)
		expect(() => readLinkPeople([{}])).toThrow(/name or an email/)
	})
})
