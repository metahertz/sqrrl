// One hub page per person, whatever the source calls them.
//
// Notes say "Taylor" or "Taylor M", calendar invites "taylor.morgan@…",
// mail "Morgan, Taylor", task owners "Lauren / Steffan". parseRef
// (identity.ts) normalizes each reference; resolvePersonHub finds the hub:
//
//   1. a page that lists the email (personCard.emails);
//   2. a page whose name, alias or address-derived name is the full name
//      ("Taylor Morgan" = "taylor.morgan@acme.example");
//   3. "Taylor M": the one known Taylor whose last name starts with M;
//   4. "Taylor": the one Taylor already on the same page (context), else the
//      only Taylor known. With two Taylors and no context the link goes to
//      the first-name hub (people/taylor) and a "same person?" suggestion
//      asks the user which one it is;
//   5. otherwise a new hub, when the caller allows it.
//
// Teams and automated senders (notifications, role mailboxes, calendars)
// get orgs/ hubs instead and never match people.
//
// Matching records the full name and email on the hub, so the next
// reference resolves in step 1 or 2. Lookups go through a per-scope
// directory of hub pages cached for a minute, so ingesting a calendar does
// not query the database once per attendee.

import {
	createWikiPage,
	updateWikiPage,
	type WikiDbHandle,
	WikiDuplicateSlugError,
	wikiPagesCollection,
} from "@sqrrl/wiki-engine"
import {
	nameFromEmail,
	nameKey,
	type ParsedRef,
	parseRef,
	partialMatches,
} from "./identity.js"
import {
	type IdentityCandidate,
	recordIdentitySuggestion,
} from "./identity-suggestions.js"
import { getSelfIdentity, isSelfRef } from "./self.js"

export { nameFromEmail }

export function slugify(text: string, maxLen: number): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, maxLen)
			.replace(/-+$/, "") || "untitled"
	)
}

export interface PersonRef {
	name?: string
	email?: string
}

export interface ResolvedPerson {
	slug: string
	title: string
	created: boolean
	/** "org" for teams and automated senders (orgs/ hubs). */
	kind?: "person" | "org"
	/** Set when the reference fit several people and went to a first-name
	 *  hub; the people it might be. */
	ambiguous?: IdentityCandidate[]
}

export interface ResolveOptions {
	scope: string
	scopeRef: string
	trustTier?: string
	allowCreate: boolean
	/** People hubs already linked from the same item: "Taylor" in a meeting
	 *  Taylor Morgan attends is Taylor Morgan. */
	context?: string[]
	/** The page being linked, so an ambiguous reference can be put to the
	 *  user as a suggestion. */
	from?: { slug: string; title?: string; edgeKind: string }
}

// ---------------------------------------------------------------- directory

export interface HubEntry {
	slug: string
	title: string
	org: boolean
	emails: string[]
	/** Full-name keys: title, recorded aliases, names derived from emails. */
	keys: string[]
	/** A first-name hub that stands for "one of several people". */
	ambiguousHub: boolean
}

interface Directory {
	at: number
	entries: Map<string, HubEntry>
	/** superseded slug -> where it went. */
	moved: Map<string, string>
}

const TTL_MS = 60_000
const directories = new WeakMap<object, Map<string, Directory>>()

type HubCard = {
	canonicalId?: string
	emails?: string[]
	aliases?: string[]
	ambiguous?: boolean
} & Record<string, unknown>

export function hubEntry(page: {
	slug: string
	title?: string
	personCard?: HubCard | null
}): HubEntry {
	const card = page.personCard ?? {}
	const emails = (card.emails ?? []).map((e) => e.toLowerCase())
	const keys = new Set<string>()
	const title = page.title ?? page.slug
	const parsed = parseRef({ name: title })
	if (parsed?.key && !parsed.firstOnly) keys.add(parsed.key)
	for (const a of card.aliases ?? []) if (a.includes(" ")) keys.add(a)
	for (const e of emails) {
		const k = nameKey(nameFromEmail(e))
		if (k.includes(" ")) keys.add(k)
	}
	return {
		slug: page.slug,
		title: parsed?.name && /@/.test(title) ? parsed.name : title,
		org: page.slug.startsWith("orgs/"),
		emails,
		keys: [...keys],
		ambiguousHub: card.ambiguous === true,
	}
}

async function directory(
	handle: WikiDbHandle,
	scope: string,
	scopeRef: string,
): Promise<Directory> {
	const cacheKey = cacheOf(handle)
	let byScope = directories.get(cacheKey)
	if (!byScope) {
		byScope = new Map()
		directories.set(cacheKey, byScope)
	}
	const id = `${handle.prefix}|${scope}|${scopeRef}`
	const cached = byScope.get(id)
	if (cached && Date.now() - cached.at < TTL_MS) return cached
	const docs = await wikiPagesCollection(handle.db, handle.prefix)
		.find(
			{ scope, scopeRef, slug: /^(people|orgs)\//, deleted: { $ne: true } },
			{
				projection: {
					slug: 1,
					title: 1,
					personCard: 1,
					state: 1,
					supersededBy: 1,
				},
			},
		)
		.toArray()
	const dir: Directory = {
		at: Date.now(),
		entries: new Map(),
		moved: new Map(),
	}
	for (const d of docs) {
		if (d.state === "superseded") {
			if (d.supersededBy) dir.moved.set(d.slug, d.supersededBy)
			continue
		}
		dir.entries.set(d.slug, hubEntry(d as never))
	}
	byScope.set(id, dir)
	return dir
}

/** Forgets cached directories, after a merge or a cleanup. */
export function invalidatePeopleDirectory(handle: WikiDbHandle): void {
	directories.delete(cacheOf(handle))
}

function cacheOf(handle: WikiDbHandle): object {
	return (handle.db as object | undefined) ?? handle
}

/** Where a slug lives now, following merges. */
function follow(dir: Directory, slug: string): string {
	let s = slug
	for (let i = 0; i < 5 && dir.moved.has(s); i++) s = dir.moved.get(s) ?? s
	return s
}

// ---------------------------------------------------------------- matching

interface Match {
	entry?: HubEntry
	ambiguous?: HubEntry[]
}

/** Steps 1-4 of the header. Pure over the directory. */
export function matchPerson(
	entries: HubEntry[],
	ref: ParsedRef,
	context: string[] = [],
): Match {
	const persons = entries.filter((e) => !e.org && !e.ambiguousHub)
	const inContext = (list: HubEntry[]) =>
		list.filter((e) => context.includes(e.slug))
	if (ref.email) {
		const byEmail = entries.find(
			(e) => !e.org && e.emails.includes(ref.email ?? ""),
		)
		if (byEmail) return { entry: byEmail }
	}
	if (ref.key && !ref.firstOnly && !ref.lastInitial) {
		const same = persons.filter((e) => e.keys.includes(ref.key ?? ""))
		// Same name, but a different address on record: a namesake.
		const fits = same.filter(
			(e) =>
				!ref.email || e.emails.length === 0 || e.emails.includes(ref.email),
		)
		if (fits.length === 1) return { entry: fits[0] }
		if (fits.length > 1) return { entry: inContext(fits)[0] ?? fits[0] }
		return {}
	}
	// A partial name with an address of its own is identified by the address
	// (step 1); guessing from the name could join two different people.
	if (ref.email) return {}
	const partial = persons.filter((e) =>
		e.keys.some((k) => partialMatches(ref, k)),
	)
	if (partial.length === 1) return { entry: partial[0] }
	if (partial.length > 1) {
		const ctx = inContext(partial)
		if (ctx.length === 1) return { entry: ctx[0] }
		return { ambiguous: partial }
	}
	if (ref.firstOnly) {
		// Nobody with this first name and a surname: an existing first-name
		// hub, if it has no address of its own.
		const hub = entries.find(
			(e) => !e.org && e.emails.length === 0 && nameKey(e.title) === ref.key,
		)
		if (hub) return { entry: hub }
	}
	return {}
}

function candidates(list: HubEntry[]): IdentityCandidate[] {
	return list.slice(0, 8).map((e) => ({
		slug: e.slug,
		title: e.title,
		reason: e.emails[0] ? `${e.title} (${e.emails[0]})` : e.title,
	}))
}

// ---------------------------------------------------------------- writes

/** Records a full name and an address on a hub, so the next reference
 *  matches directly. */
async function learn(
	handle: WikiDbHandle,
	dir: Directory,
	entry: HubEntry,
	ref: ParsedRef,
	scope: string,
	scopeRef: string,
): Promise<void> {
	const addKey =
		ref.key &&
		!ref.firstOnly &&
		!ref.lastInitial &&
		!entry.keys.includes(ref.key)
	const addEmail = ref.email && !entry.emails.includes(ref.email)
	if (!addKey && !addEmail) return
	const page = await wikiPagesCollection(handle.db, handle.prefix).findOne(
		{ scope, scopeRef, slug: entry.slug },
		{ projection: { personCard: 1 } },
	)
	const card = (page?.personCard as HubCard | null) ?? {}
	const emails = [
		...new Set([
			...(card.emails ?? []),
			...(addEmail ? [ref.email as string] : []),
		]),
	]
	const aliases = [
		...new Set([
			...(card.aliases ?? []),
			...(addKey ? [ref.key as string] : []),
		]),
	]
	await updateWikiPage(handle, entry.slug, scope, scopeRef, {
		personCard: {
			...card,
			canonicalId: card.canonicalId ?? entry.slug,
			emails,
			...(aliases.length ? { aliases } : {}),
		} as never,
	})
	dir.entries.set(entry.slug, {
		...entry,
		emails,
		keys: [...new Set([...entry.keys, ...aliases])],
	})
}

async function createHub(
	handle: WikiDbHandle,
	dir: Directory,
	p: {
		slug: string
		title: string
		org: boolean
		ref: ParsedRef
		ambiguous?: boolean
	},
	options: ResolveOptions,
): Promise<{ slug: string; created: boolean }> {
	const { scope, scopeRef } = options
	const card: HubCard = {
		canonicalId: p.slug,
		...(p.ref.email ? { emails: [p.ref.email] } : {}),
		...(p.ref.key && !p.ref.firstOnly ? { aliases: [p.ref.key] } : {}),
		...(p.ambiguous ? { ambiguous: true } : {}),
	}
	const type = p.org
		? p.ref.kind === "service"
			? "service"
			: "team"
		: "person"
	try {
		await createWikiPage(handle, {
			kind: "entity",
			title: p.title,
			slug: p.slug,
			summary: p.org
				? `${p.ref.kind === "service" ? "Automated sender" : "Team"}: ${p.title}. Messages and meetings from it link here.`
				: p.ambiguous
					? `Mentions of "${p.title}" that could be more than one person. Each is waiting for you to say who it is.`
					: `Person hub for ${p.title}. Meetings and tasks they are part of link here.`,
			body: "",
			frontmatter: { type },
			personCard: card as never,
			scope: scope as never,
			scopeRef,
			trustTier: (options.trustTier ?? "standard") as never,
		})
	} catch (err) {
		// Created by someone else since the lookup: use theirs.
		if (!(err instanceof WikiDuplicateSlugError)) throw err
		return { slug: p.slug, created: false }
	}
	dir.entries.set(
		p.slug,
		hubEntry({ slug: p.slug, title: p.title, personCard: card }),
	)
	return { slug: p.slug, created: true }
}

/** A free slug: the plain one, else qualified by the address, else numbered. */
function freeSlug(dir: Directory, base: string, ref: ParsedRef): string {
	const taken = (s: string) => dir.entries.has(s) || dir.moved.has(s)
	if (!taken(base)) return base
	if (ref.email) {
		const q = `${base.split("/")[0]}/${slugify(`${ref.name ?? ""} ${ref.email}`, 64)}`
		if (!taken(q)) return q
	}
	for (let i = 2; i < 100; i++)
		if (!taken(`${base}-${i}`)) return `${base}-${i}`
	return `${base}-${Date.now()}`
}

async function resolveOrg(
	handle: WikiDbHandle,
	dir: Directory,
	ref: ParsedRef,
	options: ResolveOptions,
): Promise<ResolvedPerson | undefined> {
	const orgs = [...dir.entries.values()].filter((e) => e.org)
	const found =
		(ref.email && orgs.find((e) => e.emails.includes(ref.email ?? ""))) ||
		orgs.find((e) => nameKey(e.title) === ref.key)
	if (found) {
		await learn(
			handle,
			dir,
			found,
			{ ...ref, key: undefined },
			options.scope,
			options.scopeRef,
		)
		return { slug: found.slug, title: found.title, created: false, kind: "org" }
	}
	if (!options.allowCreate || !ref.name) return undefined
	const slug = freeSlug(dir, `orgs/${slugify(ref.name, 48)}`, ref)
	const r = await createHub(
		handle,
		dir,
		{ slug, title: ref.name, org: true, ref },
		options,
	)
	return { slug: r.slug, title: ref.name, created: r.created, kind: "org" }
}

/** Finds or creates the hub for one reference. Undefined when nothing
 *  identifies anyone, or there is no match and creating is not allowed. */
export async function resolvePersonHub(
	handle: WikiDbHandle,
	person: PersonRef,
	options: ResolveOptions,
): Promise<ResolvedPerson | undefined> {
	const ref = parseRef(person)
	if (!ref?.name) return undefined
	const { scope, scopeRef } = options
	const dir = await directory(handle, scope, scopeRef)
	if (ref.kind !== "person") return resolveOrg(handle, dir, ref, options)

	const context = (options.context ?? []).map((s) => follow(dir, s))

	// The owner of the brain, by one of their names or addresses
	// (self.ts) - unless a first name has someone else by that name on the
	// same page ("Matt" in a meeting with Matt Stone).
	const self = await getSelfIdentity(handle, { scope, scopeRef }).catch(
		() => null,
	)
	if (self && isSelfRef(self, ref)) {
		const selfSlug = follow(dir, self.personSlug)
		const entry = dir.entries.get(selfSlug)
		const someoneElse =
			ref.firstOnly &&
			context.some(
				(s) =>
					s !== selfSlug &&
					(dir.entries.get(s)?.keys ?? []).some((k) => partialMatches(ref, k)),
			)
		if (entry && !someoneElse)
			return {
				slug: entry.slug,
				title: entry.title,
				created: false,
				kind: "person",
			}
	}

	const m = matchPerson([...dir.entries.values()], ref, context)
	if (m.entry) {
		await learn(handle, dir, m.entry, ref, scope, scopeRef)
		return {
			slug: m.entry.slug,
			title: m.entry.title,
			created: false,
			kind: "person",
		}
	}

	if (m.ambiguous) {
		// Link to the first-name hub for now, and ask.
		const hubSlug = `people/${slugify(ref.first ?? ref.name, 48)}`
		const existing = dir.entries.get(follow(dir, hubSlug))
		let slug = existing?.slug ?? hubSlug
		let created = false
		if (!existing) {
			const r = await createHub(
				handle,
				dir,
				{ slug: hubSlug, title: ref.name, org: false, ref, ambiguous: true },
				options,
			)
			slug = r.slug
			created = r.created
		}
		const ambiguous = candidates(m.ambiguous)
		if (options.from)
			await recordIdentitySuggestion(handle, {
				scope,
				scopeRef,
				kind: "link",
				subjectSlug: slug,
				subjectTitle: ref.name,
				fromSlug: options.from.slug,
				...(options.from.title ? { fromTitle: options.from.title } : {}),
				edgeKind: options.from.edgeKind,
				candidates: ambiguous,
			})
		return {
			slug,
			title: existing?.title ?? ref.name,
			created,
			kind: "person",
			ambiguous,
		}
	}

	if (!options.allowCreate) return undefined
	const slug = freeSlug(dir, `people/${slugify(ref.name, 48)}`, ref)
	const r = await createHub(
		handle,
		dir,
		{ slug, title: ref.name, org: false, ref },
		options,
	)
	return { slug: r.slug, title: ref.name, created: r.created, kind: "person" }
}

/** The people hubs in a scope, for the cleanup and the Ask path. */
export async function peopleDirectory(
	handle: WikiDbHandle,
	scope: string,
	scopeRef: string,
	opts: { fresh?: boolean } = {},
): Promise<{ entries: HubEntry[]; moved: Map<string, string> }> {
	if (opts.fresh) invalidatePeopleDirectory(handle)
	const dir = await directory(handle, scope, scopeRef)
	return { entries: [...dir.entries.values()], moved: dir.moved }
}
