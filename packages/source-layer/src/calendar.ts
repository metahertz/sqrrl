// Calendar events into meeting pages (roadmap, Phase 6).
//
// The Mac exporter (mac/sqrrl-calendar-export.swift) writes one raw item
// per event occurrence: source "calendar", kind "event", occurredAt = start,
// the structured fields in metadata (CalendarEventMeta) and a readable
// rendering in text, ending in the invite's notes after EVENT_NOTES_MARKER.
//
// distillCalendarEvents turns each into a meetings/ page without an LLM: an
// invite is already structured, so a model would only paraphrase it. The
// page's edges are the point:
//
//   meeting --attended_by--> people/*   (not for declined attendees)
//   meeting --organized_by--> people/*
//   meeting --has_transcript--> the source page of a matching transcript
//
// so a person's hub lists the meetings they were in, and an answer about a
// meeting can reach its transcript. The calendar owner is "me", as in notes,
// and gets no hub. Cancelled or deleted events keep their page, marked
// deprecated, rather than losing it.

import { createHash } from "node:crypto"
import {
	addRelationships,
	createWikiPage,
	getWikiPage,
	removeRelationships,
	updateWikiPage,
	type WikiDbHandle,
	WikiDuplicateSlugError,
	type WikiRelationshipSpec,
	wikiPagesCollection,
} from "@sqrrl/wiki-engine"
import { type PersonRef, resolvePersonHub, slugify } from "./people.js"
import { enqueueSourceReview } from "./task-review/store.js"
import {
	rawItemsCollection,
	type RawItemView,
	toRawItemView,
} from "./raw-items.js"

export const CALENDAR_SOURCE = "calendar"
/** Separates the rendered header of an event's text from its notes. */
export const EVENT_NOTES_MARKER = "\n\nNotes:\n"
/** Above this many people, a meeting links existing hubs but creates none:
 *  an all-hands would otherwise mint a page per attendee. */
export const DEFAULT_MAX_NEW_PEOPLE = 12
/** The longest agenda copied onto a meeting page; the raw item keeps all. */
const AGENDA_CHARS = 4000
/** A transcript file counts as this meeting's if it is timed from 15
 *  minutes before the start to 6 hours after the end: uploads follow the
 *  meeting, often by hours. */
const TRANSCRIPT_BEFORE_MS = 15 * 60_000
const TRANSCRIPT_AFTER_MS = 6 * 3600_000
const MEETING_EDGE_KINDS = ["attended_by", "organized_by", "has_transcript"]

export interface CalendarAttendee {
	name?: string
	email?: string
	/** accepted | declined | tentative | pending | unknown */
	status?: string
	/** required | optional | chair | non-participant */
	role?: string
	/** person | room | resource | group | unknown */
	type?: string
	/** The calendar's owner. */
	self?: boolean
}

export interface CalendarEventMeta {
	/** ISO 8601 instants. */
	start: string
	end: string
	allDay?: boolean
	/** IANA zone the event was scheduled in, for display. */
	timeZone?: string
	location?: string
	calendar?: string
	organizer?: CalendarAttendee
	attendees?: CalendarAttendee[]
	/** confirmed | tentative | cancelled */
	status?: string
	recurring?: boolean
	seriesId?: string
	conferenceUrl?: string
}

export function readEventMeta(
	item: Pick<RawItemView, "metadata">,
): CalendarEventMeta | undefined {
	const m = item.metadata as Partial<CalendarEventMeta> | undefined
	if (!m || typeof m.start !== "string" || typeof m.end !== "string")
		return undefined
	if (Number.isNaN(Date.parse(m.start)) || Number.isNaN(Date.parse(m.end)))
		return undefined
	return m as CalendarEventMeta
}

function isRetired(item: RawItemView): boolean {
	return item.text === "" || Boolean(item.invalidAt)
}

function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 6)
}

/** "2026-11-17 14:00" in the event's own zone (UTC if it has none). */
export function localTime(iso: string, timeZone?: string): string {
	const fmt = (tz: string) =>
		new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.format(new Date(iso))
			.replace(",", "")
	try {
		return fmt(timeZone || "UTC")
	} catch {
		return fmt("UTC")
	}
}

function whenText(meta: CalendarEventMeta): string {
	const start = localTime(meta.start, meta.timeZone)
	if (meta.allDay) return `${start.slice(0, 10)} (all day)`
	const end = localTime(meta.end, meta.timeZone)
	const endPart = end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end
	return `${start}–${endPart}${meta.timeZone ? ` (${meta.timeZone})` : ""}`
}

function displayName(a: CalendarAttendee): string {
	return a.name?.trim() || a.email?.trim() || "unknown"
}

/** The people a meeting links to: no rooms, no resources, not the owner. */
function linkablePeople(meta: CalendarEventMeta): CalendarAttendee[] {
	return (meta.attendees ?? []).filter(
		(a) =>
			!a.self &&
			(a.type === undefined || a.type === "person" || a.type === "unknown") &&
			Boolean(a.name?.trim() || a.email?.trim()),
	)
}

export function eventTitle(item: RawItemView): string {
	return item.title?.trim() || "Untitled meeting"
}

export function eventNotes(text: string): string {
	const at = text.indexOf(EVENT_NOTES_MARKER)
	return at === -1 ? "" : text.slice(at + EVENT_NOTES_MARKER.length).trim()
}

export function renderMeetingPage(
	item: RawItemView,
	meta: CalendarEventMeta,
	links: { transcript?: { slug: string; title: string } },
): { title: string; summary: string; body: string } {
	const title = eventTitle(item)
	const date = localTime(meta.start, meta.timeZone).slice(0, 10)
	const people = linkablePeople(meta)
	const attending = people.filter((a) => a.status !== "declined")
	const names = attending.map(displayName)
	const withWhom = names.length
		? ` with ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} others` : ""}`
		: ""
	const cancelled = meta.status === "cancelled"
	const summary = `${cancelled ? "Cancelled meeting" : "Meeting"} on ${whenText(meta)}${withWhom}.`
	const lines = [`**When:** ${whenText(meta)}`]
	if (meta.location) lines.push(`**Where:** ${meta.location}`)
	if (meta.conferenceUrl) lines.push(`**Call:** ${meta.conferenceUrl}`)
	if (meta.calendar) lines.push(`**Calendar:** ${meta.calendar}`)
	if (meta.organizer && !meta.organizer.self)
		lines.push(`**Organizer:** ${displayName(meta.organizer)}`)
	if (meta.recurring) lines.push("**Recurring:** yes")
	if (cancelled) lines.push("**Status:** cancelled")
	if (links.transcript)
		lines.push(`**Transcript:** [[${links.transcript.slug}]]`)
	const body = [lines.join("\n\n")]
	if (people.length) {
		body.push(
			[
				"## Attendees",
				"",
				...people.map(
					(a) => `- ${displayName(a)}${a.status ? ` (${a.status})` : ""}`,
				),
			].join("\n"),
		)
	}
	const notes = eventNotes(item.text)
	if (notes) {
		body.push(
			`## Agenda\n\n${notes.length > AGENDA_CHARS ? `${notes.slice(0, AGENDA_CHARS)} …` : notes}`,
		)
	}
	return { title: `${title} (${date})`, summary, body: body.join("\n\n") }
}

/** Zoom names files GMT20261117-140012_...; that beats the upload time. */
export function transcriptTime(item: RawItemView): Date | undefined {
	const m = item.title?.match(/GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
	if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
	return item.occurredAt ? new Date(item.occurredAt) : undefined
}

const TRANSCRIPT_NAME = /\.(vtt|srt)$|transcript/i

/** The wiki page a raw item was distilled into, when that is knowable. */
export function sourcePageSlug(item: RawItemView): string | undefined {
	const meta = item.metadata as { pageSlug?: unknown }
	if (typeof meta?.pageSlug === "string") return meta.pageSlug
	const file = item.unit?.match(/^file:(\d+)$/)
	if (item.source === "nextcloud" && file)
		return `sources/nextcloud/files/${file[1]}`
	return undefined
}

/** A transcript in the same scope timed within the meeting's window. Only
 *  an unambiguous match is linked: two candidates means a guess. */
async function findTranscript(
	handle: WikiDbHandle,
	meta: CalendarEventMeta,
	scope: string,
	scopeRef: string,
): Promise<{ slug: string; title: string } | undefined> {
	const from = new Date(Date.parse(meta.start) - TRANSCRIPT_BEFORE_MS)
	const to = new Date(Date.parse(meta.end) + TRANSCRIPT_AFTER_MS)
	// Wide on occurredAt (upload time), then narrowed by transcriptTime.
	const docs = await rawItemsCollection(handle.db, handle.prefix)
		.find({
			scope,
			scopeRef,
			current: true,
			kind: "file",
			text: { $ne: "" },
			occurredAt: { $gte: from, $lt: new Date(to.getTime() + 7 * 86400_000) },
		})
		.limit(200)
		.toArray()
	const pages = new Set<string>()
	for (const doc of docs) {
		const item = toRawItemView(doc)
		if (!TRANSCRIPT_NAME.test(item.title ?? "")) continue
		const at = transcriptTime(item)
		if (!at || at < from || at > to) continue
		const slug = sourcePageSlug(item)
		if (slug) pages.add(slug)
	}
	if (pages.size !== 1) return undefined
	const [slug] = [...pages]
	const page = await getWikiPage(handle, slug, scope, scopeRef)
	return page ? { slug, title: page.title } : undefined
}

async function findMeetingPage(
	handle: WikiDbHandle,
	sourceId: string,
	scope: string,
	scopeRef: string,
): Promise<{ slug: string } | null> {
	return (await wikiPagesCollection(handle.db, handle.prefix).findOne(
		{
			scope,
			scopeRef,
			"frontmatter.sources": {
				$elemMatch: { resource: CALENDAR_SOURCE, id: sourceId },
			},
		},
		{ projection: { slug: 1 } },
	)) as { slug: string } | null
}

export interface MeetingDistillOptions {
	scope: string
	scopeRef: string
	trustTier?: string
	maxNewPeople?: number
}

export interface MeetingDistillSummary {
	created: number
	updated: number
	cancelled: number
	peopleCreated: number
	peopleLinked: number
	transcriptsLinked: number
	errors: string[]
}

export async function distillCalendarEvents(
	handle: WikiDbHandle,
	items: RawItemView[],
	options: MeetingDistillOptions,
): Promise<MeetingDistillSummary> {
	const out: MeetingDistillSummary = {
		created: 0,
		updated: 0,
		cancelled: 0,
		peopleCreated: 0,
		peopleLinked: 0,
		transcriptsLinked: 0,
		errors: [],
	}
	// Serial: two events naming the same new person must not both miss the
	// other's hub and create it twice.
	for (const item of items) {
		try {
			await distillOne(handle, item, options, out)
		} catch (err) {
			out.errors.push(
				`${item.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return out
}

async function distillOne(
	handle: WikiDbHandle,
	item: RawItemView,
	options: MeetingDistillOptions,
	out: MeetingDistillSummary,
): Promise<void> {
	const { scope, scopeRef } = options
	const existing = await findMeetingPage(handle, item.sourceId, scope, scopeRef)

	if (isRetired(item)) {
		if (!existing) return
		const page = await getWikiPage(handle, existing.slug, scope, scopeRef)
		if (!page) return
		const frontmatter = {
			...(page.frontmatter as object),
			status: "deprecated",
		}
		await updateWikiPage(handle, existing.slug, scope, scopeRef, {
			summary: page.summary.startsWith("Removed from the calendar")
				? page.summary
				: `Removed from the calendar. ${page.summary}`,
			frontmatter: frontmatter as never,
		})
		out.cancelled++
		await enqueueSourceReview(handle, {
			scope,
			scopeRef,
			sourceSlug: existing.slug,
		}).catch(() => undefined)
		return
	}

	const meta = readEventMeta(item)
	if (!meta) throw new Error("metadata lacks a valid start and end")

	const transcript = await findTranscript(handle, meta, scope, scopeRef)
	const rendered = renderMeetingPage(item, meta, { transcript })
	const cancelled = meta.status === "cancelled"
	const frontmatter = {
		type: "meeting",
		timestamp: new Date(meta.start),
		status: cancelled ? "deprecated" : "stable",
		...(meta.conferenceUrl ? { resource: meta.conferenceUrl } : {}),
		sources: [
			{ resource: CALENDAR_SOURCE, id: item.sourceId, title: eventTitle(item) },
		],
		meeting: {
			start: meta.start,
			end: meta.end,
			...(meta.allDay ? { allDay: true } : {}),
			...(meta.location ? { location: meta.location } : {}),
			...(meta.calendar ? { calendar: meta.calendar } : {}),
			...(meta.seriesId ? { seriesId: meta.seriesId } : {}),
			status: cancelled ? "cancelled" : (meta.status ?? "confirmed"),
		},
	}

	let slug: string
	if (existing) {
		slug = existing.slug
		await updateWikiPage(handle, slug, scope, scopeRef, {
			...rendered,
			frontmatter: frontmatter as never,
		})
		out.updated++
	} else {
		const date = localTime(meta.start, meta.timeZone).slice(0, 10)
		const base = `meetings/${date}-${slugify(eventTitle(item), 40)}`
		// Same title on the same day is a different event (or a page from
		// before): qualify by the event id rather than overwrite.
		slug = (await getWikiPage(handle, base, scope, scopeRef))
			? `${base}-${shortHash(item.sourceId)}`
			: base
		const create = (s: string) =>
			createWikiPage(handle, {
				kind: "source",
				slug: s,
				...rendered,
				frontmatter: frontmatter as never,
				scope: scope as never,
				scopeRef,
				trustTier: (options.trustTier ?? "standard") as never,
			})
		try {
			await create(slug)
		} catch (err) {
			// A soft-deleted page keeps its slug forever.
			if (!(err instanceof WikiDuplicateSlugError) || slug !== base) throw err
			slug = `${base}-${shortHash(item.sourceId)}`
			await create(slug)
		}
		out.created++
	}

	const people = linkablePeople(meta)
	const allowCreate =
		people.length <= (options.maxNewPeople ?? DEFAULT_MAX_NEW_PEOPLE)
	const edges: WikiRelationshipSpec[] = []
	const link = async (person: PersonRef, kind: string, weight: number) => {
		const hub = await resolvePersonHub(handle, person, {
			scope,
			scopeRef,
			trustTier: options.trustTier,
			allowCreate,
			context: edges.map((e) => e.targetPageSlug),
			from: { slug, title: eventTitle(item), edgeKind: kind },
		})
		if (!hub) return
		if (hub.created) out.peopleCreated++
		if (edges.some((e) => e.kind === kind && e.targetPageSlug === hub.slug))
			return
		edges.push({
			targetPageSlug: hub.slug,
			targetTitle: hub.title,
			kind,
			weight,
			confidence: 0.9,
		})
		out.peopleLinked++
	}
	if (meta.organizer && !meta.organizer.self && meta.organizer.type !== "room")
		await link(meta.organizer, "organized_by", 0.8)
	for (const a of people) {
		if (a.status === "declined") continue
		await link(a, "attended_by", 0.6)
	}
	if (transcript) {
		edges.push({
			targetPageSlug: transcript.slug,
			targetTitle: transcript.title,
			kind: "has_transcript",
			weight: 1,
			confidence: 0.7,
		})
		out.transcriptsLinked++
	}

	// A meeting that happened (or was cancelled) may close tasks about it.
	await enqueueSourceReview(handle, {
		scope,
		scopeRef,
		sourceSlug: slug,
	}).catch(() => undefined)

	// Edges this distiller owns are replaced, so a removed attendee or a
	// re-timed transcript does not leave a stale link; edges a person added
	// by hand under other kinds are kept.
	const page = await getWikiPage(handle, slug, scope, scopeRef)
	const current = (page?.relationships ?? []) as WikiRelationshipSpec[]
	const stale = current.filter(
		(r) =>
			MEETING_EDGE_KINDS.includes(r.kind) &&
			!edges.some(
				(e) => e.kind === r.kind && e.targetPageSlug === r.targetPageSlug,
			),
	)
	if (stale.length)
		await removeRelationships(
			handle,
			slug,
			scope,
			scopeRef,
			stale.map((r) => ({ targetPageSlug: r.targetPageSlug, kind: r.kind })),
		)
	await addRelationships(handle, slug, scope, scopeRef, edges)
}
