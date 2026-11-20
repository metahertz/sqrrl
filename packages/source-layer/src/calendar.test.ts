import { beforeEach, describe, expect, it, vi } from "vitest"

// An in-memory wiki: pages by slug, with just the queries the calendar
// distiller and resolvePersonHub make.
type Page = Record<string, unknown> & {
	slug: string
	title: string
	relationships?: Array<{ targetPageSlug: string; kind: string }>
}
const wiki = vi.hoisted(() => ({ pages: new Map<string, Page>() }))
const raw = vi.hoisted(() => ({ docs: [] as Array<Record<string, unknown>> }))

function matches(page: Page, filter: Record<string, unknown>): boolean {
	return Object.entries(filter).every(([k, v]) => {
		if (k === "scope" || k === "scopeRef") return true
		if (v instanceof RegExp) return v.test(String(page[k]))
		if (k === "personCard.emails")
			return (
				(page.personCard as { emails?: string[] })?.emails ?? []
			).includes(v as string)
		if (k === "frontmatter.sources") {
			const want = (v as { $elemMatch: { resource: string; id: string } })
				.$elemMatch
			const sources =
				(
					page.frontmatter as {
						sources?: Array<{ resource: string; id: string }>
					}
				)?.sources ?? []
			return sources.some(
				(s) => s.resource === want.resource && s.id === want.id,
			)
		}
		return page[k] === v
	})
}

const asked = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock("./identity-suggestions.js", () => ({
	recordIdentitySuggestion: async (_h: unknown, p: Record<string, unknown>) => {
		asked.list.push(p)
	},
}))

const owner = vi.hoisted(() => ({
	self: null as null | {
		personSlug: string
		names: string[]
		emails: string[]
	},
}))
vi.mock("./self.js", async (orig) => ({
	...(await orig<typeof import("./self.js")>()),
	getSelfIdentity: async () => owner.self,
}))

vi.mock("@sqrrl/wiki-engine", () => {
	class WikiDuplicateSlugError extends Error {}
	return {
		WikiDuplicateSlugError,
		wikiPagesCollection: () => ({
			findOne: async (filter: Record<string, unknown>) =>
				[...wiki.pages.values()].find((p) => matches(p, filter)) ?? null,
			// The people directory: every people/ and orgs/ hub.
			find: () => ({
				toArray: async () =>
					[...wiki.pages.values()].filter((p) =>
						/^(people|orgs)\//.test(p.slug),
					),
			}),
		}),
		getWikiPage: async (_h: unknown, slug: string) => wiki.pages.get(slug),
		createWikiPage: async (_h: unknown, input: Page) => {
			if (wiki.pages.has(input.slug))
				throw new WikiDuplicateSlugError(input.slug)
			wiki.pages.set(input.slug, { relationships: [], ...input })
			return input
		},
		updateWikiPage: async (
			_h: unknown,
			slug: string,
			_s: string,
			_r: string,
			patch: Record<string, unknown>,
		) => {
			const page = wiki.pages.get(slug)
			if (page) Object.assign(page, patch)
			return page
		},
		addRelationships: async (
			_h: unknown,
			slug: string,
			_s: string,
			_r: string,
			add: Array<{ targetPageSlug: string; kind: string }>,
		) => {
			const page = wiki.pages.get(slug)
			if (!page) return 0
			const rels = page.relationships ?? []
			let n = 0
			for (const r of add) {
				if (
					rels.some(
						(e) => e.kind === r.kind && e.targetPageSlug === r.targetPageSlug,
					)
				)
					continue
				rels.push(r)
				n++
			}
			page.relationships = rels
			return n
		},
		removeRelationships: async (
			_h: unknown,
			slug: string,
			_s: string,
			_r: string,
			drop: Array<{ targetPageSlug: string; kind: string }>,
		) => {
			const page = wiki.pages.get(slug)
			if (!page) return 0
			const before = page.relationships?.length ?? 0
			page.relationships = (page.relationships ?? []).filter(
				(e) =>
					!drop.some(
						(d) => d.kind === e.kind && d.targetPageSlug === e.targetPageSlug,
					),
			)
			return before - page.relationships.length
		},
	}
})
vi.mock("./raw-items.js", () => ({
	rawItemsCollection: () => ({
		find: () => ({ limit: () => ({ toArray: async () => raw.docs }) }),
	}),
	toRawItemView: (d: Record<string, unknown>) => ({ ...d, id: String(d._id) }),
}))

import type { RawItemView } from "./raw-items.js"
import { linkIngestedGraph } from "./tasks.js"
import {
	type CalendarEventMeta,
	distillCalendarEvents,
	EVENT_NOTES_MARKER,
	localTime,
	readEventMeta,
	renderMeetingPage,
	sourcePageSlug,
	transcriptTime,
} from "./calendar.js"
import {
	invalidatePeopleDirectory,
	nameFromEmail,
	resolvePersonHub,
} from "./people.js"

const OPTS = { scope: "workspace", scopeRef: "ws-1" }
const handle = {} as never

const META: CalendarEventMeta = {
	start: "2026-11-17T14:00:00Z",
	end: "2026-11-17T15:00:00Z",
	timeZone: "Europe/London",
	location: "Room 4",
	calendar: "Work",
	organizer: { name: "Kai Smith", email: "kai@corp.test" },
	attendees: [
		{
			name: "Me Myself",
			email: "me@corp.test",
			self: true,
			status: "accepted",
		},
		{ name: "Kai Smith", email: "kai@corp.test", status: "accepted" },
		{ name: "Lee Park", email: "lee@corp.test", status: "declined" },
		{ email: "dana.ross@corp.test", status: "tentative" },
		{ name: "Room 4", type: "room" },
	],
	status: "confirmed",
}

function event(
	sourceId: string,
	meta: CalendarEventMeta = META,
	extra: Partial<RawItemView> = {},
): RawItemView {
	return {
		id: `id-${sourceId}`,
		source: "calendar",
		sourceId,
		kind: "event",
		title: "OIDC rollout",
		text: `Meeting: OIDC rollout${EVENT_NOTES_MARKER}Agree the cutover date.`,
		occurredAt: new Date(meta.start),
		metadata: meta as unknown as Record<string, unknown>,
		participants: [],
		attachments: [],
		...extra,
	} as RawItemView
}

beforeEach(() => {
	wiki.pages.clear()
	invalidatePeopleDirectory(handle)
	asked.list = []
	owner.self = null
	raw.docs = []
})

describe("pure helpers", () => {
	it("reads only metadata with a valid start and end", () => {
		expect(readEventMeta({ metadata: META as never })).toEqual(META)
		expect(
			readEventMeta({ metadata: { start: "x", end: "y" } }),
		).toBeUndefined()
		expect(readEventMeta({ metadata: { retired: true } })).toBeUndefined()
	})

	it("shows times in the event's zone", () => {
		expect(localTime("2026-07-01T14:00:00Z", "Europe/London")).toBe(
			"2026-07-01 15:00",
		)
		expect(localTime("2026-07-01T14:00:00Z", "Not/AZone")).toBe(
			"2026-07-01 14:00",
		)
	})

	it("names a person from an email when the invite has no name", () => {
		expect(nameFromEmail("dana.ross@corp.test")).toBe("Dana Ross")
	})

	it("renders when, where, attendees and agenda; not the owner or rooms", () => {
		const page = renderMeetingPage(event("e1"), META, {
			transcript: { slug: "sources/t", title: "t.vtt" },
		})
		expect(page.title).toBe("OIDC rollout (2026-11-17)")
		expect(page.summary).toBe(
			"Meeting on 2026-11-17 14:00–15:00 (Europe/London) with Kai Smith, dana.ross@corp.test.",
		)
		expect(page.body).toContain("**Where:** Room 4")
		expect(page.body).toContain("**Organizer:** Kai Smith")
		expect(page.body).toContain("**Transcript:** [[sources/t]]")
		expect(page.body).toContain("- Lee Park (declined)")
		expect(page.body).not.toContain("Me Myself")
		expect(page.body).not.toContain("- Room 4")
		expect(page.body).toContain("## Agenda\n\nAgree the cutover date.")
	})

	it("times a Zoom transcript by its file name, else by occurredAt", () => {
		expect(
			transcriptTime({
				title: "GMT20261117-140512_Recording.transcript.vtt",
				occurredAt: new Date("2026-11-19T00:00:00Z"),
			} as RawItemView)?.toISOString(),
		).toBe("2026-11-17T14:05:12.000Z")
		expect(
			transcriptTime({
				title: "standup.vtt",
				occurredAt: new Date("2026-11-17T15:30:00Z"),
			} as RawItemView)?.toISOString(),
		).toBe("2026-11-17T15:30:00.000Z")
	})

	it("maps a Nextcloud file item to its source page", () => {
		expect(
			sourcePageSlug({
				source: "nextcloud",
				unit: "file:23141",
				metadata: {},
			} as never),
		).toBe("sources/nextcloud/files/23141")
		expect(
			sourcePageSlug({
				source: "x",
				metadata: { pageSlug: "sources/y" },
			} as never),
		).toBe("sources/y")
		expect(
			sourcePageSlug({ source: "x", metadata: {} } as never),
		).toBeUndefined()
	})
})

describe("resolvePersonHub", () => {
	it("matches by email first, then exact name, recording the email", async () => {
		wiki.pages.set("people/kai-smith", {
			slug: "people/kai-smith",
			title: "Kai Smith",
		})
		const byName = await resolvePersonHub(
			handle,
			{ name: "Kai Smith", email: "KAI@corp.test" },
			{ ...OPTS, allowCreate: false },
		)
		expect(byName).toEqual({
			slug: "people/kai-smith",
			title: "Kai Smith",
			created: false,
			kind: "person",
		})
		expect(wiki.pages.get("people/kai-smith")?.personCard).toEqual({
			canonicalId: "people/kai-smith",
			emails: ["kai@corp.test"],
		})
		const byEmail = await resolvePersonHub(
			handle,
			{ name: "K. Smith", email: "kai@corp.test" },
			{ ...OPTS, allowCreate: false },
		)
		expect(byEmail?.slug).toBe("people/kai-smith")
	})

	it("never matches a first-name hub to a full name", async () => {
		wiki.pages.set("people/kai", { slug: "people/kai", title: "Kai" })
		const out = await resolvePersonHub(
			handle,
			{ name: "Kai Smith", email: "kai@corp.test" },
			{ ...OPTS, allowCreate: true },
		)
		expect(out).toEqual({
			slug: "people/kai-smith",
			title: "Kai Smith",
			created: true,
			kind: "person",
		})
	})

	it("treats a same-named page with another email as a namesake", async () => {
		wiki.pages.set("people/kai-smith", {
			slug: "people/kai-smith",
			title: "Kai Smith",
			personCard: { emails: ["kai@other.test"] },
		})
		const out = await resolvePersonHub(
			handle,
			{ name: "Kai Smith", email: "kai@corp.test" },
			{ ...OPTS, allowCreate: true },
		)
		expect(out?.slug).toBe("people/kai-smith-kai-corp-test")
		expect(out?.created).toBe(true)
	})

	it("creates nothing when not allowed", async () => {
		expect(
			await resolvePersonHub(
				handle,
				{ name: "Nobody" },
				{ ...OPTS, allowCreate: false },
			),
		).toBeUndefined()
		expect(wiki.pages.size).toBe(0)
	})
})

describe("distillCalendarEvents", () => {
	it("creates a meeting page linked to its organizer and attendees", async () => {
		const out = await distillCalendarEvents(handle, [event("e1")], OPTS)
		expect(out).toMatchObject({
			created: 1,
			updated: 0,
			peopleCreated: 2,
			errors: [],
		})
		const page = wiki.pages.get("meetings/2026-11-17-oidc-rollout")
		expect(page).toMatchObject({
			kind: "source",
			title: "OIDC rollout (2026-11-17)",
			frontmatter: expect.objectContaining({
				type: "meeting",
				status: "stable",
				sources: [{ resource: "calendar", id: "e1", title: "OIDC rollout" }],
			}),
		})
		expect(page?.relationships).toEqual([
			expect.objectContaining({
				kind: "organized_by",
				targetPageSlug: "people/kai-smith",
			}),
			expect.objectContaining({
				kind: "attended_by",
				targetPageSlug: "people/kai-smith",
			}),
			expect.objectContaining({
				kind: "attended_by",
				targetPageSlug: "people/dana-ross",
			}),
		])
		// Declined, self and the room get no hub.
		expect(wiki.pages.has("people/lee-park")).toBe(false)
		expect(wiki.pages.has("people/me-myself")).toBe(false)
		expect(wiki.pages.has("people/room-4")).toBe(false)
	})

	it("updates the same page on a change, replacing stale edges", async () => {
		await distillCalendarEvents(handle, [event("e1")], OPTS)
		const moved: CalendarEventMeta = {
			...META,
			start: "2026-11-18T10:00:00Z",
			end: "2026-11-18T11:00:00Z",
			attendees: [
				{ name: "Kai Smith", email: "kai@corp.test", status: "accepted" },
			],
		}
		const out = await distillCalendarEvents(handle, [event("e1", moved)], OPTS)
		expect(out).toMatchObject({ created: 0, updated: 1 })
		const page = wiki.pages.get("meetings/2026-11-17-oidc-rollout")
		expect(page?.summary).toContain("2026-11-18 10:00")
		expect(
			page?.relationships?.map((r) => `${r.kind}:${r.targetPageSlug}`),
		).toEqual(["organized_by:people/kai-smith", "attended_by:people/kai-smith"])
	})

	it("keeps two same-titled events on one day apart", async () => {
		await distillCalendarEvents(handle, [event("e1"), event("e2")], OPTS)
		expect(
			[...wiki.pages.keys()].filter((s) => s.startsWith("meetings/")),
		).toHaveLength(2)
	})

	it("links existing people but creates none for a large meeting", async () => {
		wiki.pages.set("people/kai-smith", {
			slug: "people/kai-smith",
			title: "Kai Smith",
		})
		const crowd = Array.from({ length: 13 }, (_, i) => ({
			name: `Person ${i}`,
			email: `p${i}@corp.test`,
		}))
		await distillCalendarEvents(
			handle,
			[event("big", { ...META, attendees: [...crowd, { name: "Kai Smith" }] })],
			OPTS,
		)
		expect(wiki.pages.has("people/person-0")).toBe(false)
		const rels = wiki.pages.get(
			"meetings/2026-11-17-oidc-rollout",
		)?.relationships
		expect(rels?.filter((r) => r.kind === "attended_by")).toHaveLength(1)
	})

	it("links one unambiguous transcript in the window", async () => {
		wiki.pages.set("sources/nextcloud/files/7", {
			slug: "sources/nextcloud/files/7",
			title: "standup.vtt",
		})
		raw.docs = [
			{
				_id: "r7",
				source: "nextcloud",
				unit: "file:7",
				title: "standup.vtt",
				occurredAt: new Date("2026-11-17T15:20:00Z"),
				metadata: {},
			},
			// Outside the window: ignored.
			{
				_id: "r8",
				source: "nextcloud",
				unit: "file:8",
				title: "other.vtt",
				occurredAt: new Date("2026-11-18T09:00:00Z"),
				metadata: {},
			},
		]
		const out = await distillCalendarEvents(handle, [event("e1")], OPTS)
		expect(out.transcriptsLinked).toBe(1)
		const page = wiki.pages.get("meetings/2026-11-17-oidc-rollout")
		expect(page?.body).toContain("[[sources/nextcloud/files/7]]")
		expect(page?.relationships).toContainEqual(
			expect.objectContaining({
				kind: "has_transcript",
				targetPageSlug: "sources/nextcloud/files/7",
			}),
		)
	})

	it("links no transcript when two match", async () => {
		raw.docs = ["1", "2"].map((n) => ({
			_id: n,
			source: "nextcloud",
			unit: `file:${n}`,
			title: `t${n}.vtt`,
			occurredAt: new Date("2026-11-17T15:10:00Z"),
			metadata: {},
		}))
		const out = await distillCalendarEvents(handle, [event("e1")], OPTS)
		expect(out.transcriptsLinked).toBe(0)
	})

	it("marks a removed event's page deprecated instead of deleting it", async () => {
		await distillCalendarEvents(handle, [event("e1")], OPTS)
		const out = await distillCalendarEvents(
			handle,
			[
				event("e1", META, {
					text: "",
					metadata: { retired: true },
					invalidAt: new Date(),
				}),
			],
			OPTS,
		)
		expect(out.cancelled).toBe(1)
		const page = wiki.pages.get("meetings/2026-11-17-oidc-rollout")
		expect(page?.summary).toMatch(/^Removed from the calendar\. Meeting on/)
		expect(page?.frontmatter).toMatchObject({ status: "deprecated" })
	})

	it("reports a malformed event and carries on", async () => {
		const out = await distillCalendarEvents(
			handle,
			[event("bad", { start: "nope" } as never), event("e1")],
			OPTS,
		)
		expect(out.created).toBe(1)
		expect(out.errors).toEqual(["bad: metadata lacks a valid start and end"])
	})
})

describe("task owners", () => {
	it("splits pairs, joins spellings, and asks about an ambiguous first name", async () => {
		for (const [slug, title, email] of [
			[
				"people/taylor-morgan-acme-example",
				"taylor.morgan@acme.example",
				"taylor.morgan@acme.example",
			],
			[
				"people/taylor-pryce-acme-example",
				"taylor.pryce@acme.example",
				"taylor.pryce@acme.example",
			],
			["people/lauren-shaw", "Lauren Shaw", ""],
		])
			wiki.pages.set(slug, {
				slug,
				title,
				...(email ? { personCard: { emails: [email] } } : {}),
			})
		for (const t of ["tasks/a", "tasks/b", "sources/n"])
			wiki.pages.set(t, { slug: t, title: t, relationships: [] })
		const out = await linkIngestedGraph(handle, {
			...OPTS,
			sourceSlug: "sources/n",
			sourceTitle: "n",
			taskSlugs: ["tasks/a", "tasks/b"],
			tasks: [
				{ task: "Send deck", owner: "Lauren / Steffan" },
				{ task: "Book room", owner: "Taylor" },
			] as never,
		})
		expect(out.errors).toEqual([])
		const owners = (slug: string) =>
			(wiki.pages.get(slug)?.relationships ?? [])
				.filter((r) => r.kind === "owned_by")
				.map((r) => r.targetPageSlug)
		expect(owners("tasks/a")).toEqual(["people/lauren-shaw", "people/steffan"])
		expect(owners("tasks/b")).toEqual(["people/taylor"])
		expect(wiki.pages.get("people/taylor")?.personCard).toMatchObject({
			ambiguous: true,
		})
		expect(asked.list).toHaveLength(1)
		expect(asked.list[0]).toMatchObject({
			kind: "link",
			subjectSlug: "people/taylor",
			fromSlug: "tasks/b",
			edgeKind: "owned_by",
		})
	})
})

describe("the owner", () => {
	it("resolves the owner's names to their hub, unless someone else by that name is on the page", async () => {
		for (const [slug, title] of [
			["people/matt-hollis", "Matt Hollis"],
			["people/matt-stone", "Matt Stone"],
		])
			wiki.pages.set(slug, { slug, title })
		owner.self = {
			personSlug: "people/matt-hollis",
			names: ["Matt", "Matt Hollis"],
			emails: ["matt.hollis@acme.example"],
		}
		const at = (name: string, context: string[] = []) =>
			resolvePersonHub(
				handle,
				{ name },
				{ ...OPTS, allowCreate: true, context },
			)
		expect((await at("Matt"))?.slug).toBe("people/matt-hollis")
		expect(
			(
				await resolvePersonHub(
					handle,
					{ email: "matt.hollis@acme.example" },
					{ ...OPTS, allowCreate: true },
				)
			)?.slug,
		).toBe("people/matt-hollis")
		expect((await at("Matt", ["people/matt-stone"]))?.slug).toBe(
			"people/matt-stone",
		)
		expect(asked.list).toEqual([])
	})
})
