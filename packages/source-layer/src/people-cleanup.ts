// One-off cleanup of people hubs created before references were normalized.
//
// planPeopleCleanup is pure: given the hubs and the links into them, it
// decides what is certain and what to ask about. applyPeopleCleanup carries
// out a plan. The API's dry run returns the plan; apply runs both.
//
// Certain (applied):
//   - teams and automated senders move to orgs/ hubs;
//   - hubs for one person merge: a shared address, or the same full name
//     ("taylor.morgan@acme.example" = "Taylor Morgan" = "Lauren Shaw
//     (via Google Docs)" for Lauren Shaw);
//   - a first-name or "Taylor M" hub whose every link resolves to the same
//     person merges into them; otherwise each link that resolves (by the
//     other people on the same page, or because only one such person is
//     known) moves on its own;
//   - "Lauren / Steffan" links become a link to each.
// Asked (suggestions):
//   - links that fit several people ("Taylor" with two Taylors);
//   - the same name with different addresses;
//   - a single-name address and a full name at the same company
//     (steffan@ and Steffan Mills), and Ben / Benjamin Castell.

import {
	addRelationships,
	createWikiPage,
	deleteWikiPage,
	mergePages,
	removeRelationships,
	updateWikiPage,
	type WikiDbHandle,
	wikiPagesCollection,
} from "@sqrrl/wiki-engine"
import {
	cleanName,
	isServiceEmail,
	nameFromEmail,
	nameKey,
	parseRef,
	splitRefs,
} from "./identity.js"
import {
	type IdentityCandidate,
	recordIdentitySuggestion,
} from "./identity-suggestions.js"
import {
	type HubEntry,
	invalidatePeopleDirectory,
	matchPerson,
	slugify,
} from "./people.js"

export interface HubDoc {
	slug: string
	title: string
	personCard?: { emails?: string[]; aliases?: string[] } | null
	/** Pages that link here. */
	backlinks: string[]
}

/** source page -> its links to hubs (kind, target). */
export type SourceLinks = Map<string, Array<{ kind: string; target: string }>>

export interface CleanupPlan {
	orgs: Array<{
		into: string
		title: string
		type: "service" | "team"
		emails: string[]
		from: string[]
	}>
	merges: Array<{
		into: string
		title: string
		emails: string[]
		aliases: string[]
		from: string[]
		reason: string
	}>
	relinks: Array<{ source: string; kind: string; from: string; to: string[] }>
	/** Hubs left with no links after relinking ("Lauren / Steffan"). */
	retire: string[]
	/** First-name hubs that stay, standing for "one of several people". */
	ambiguousHubs: string[]
	suggestions: Array<{
		kind: "link" | "merge"
		subject: string
		subjectTitle: string
		from?: string
		edgeKind?: string
		candidates: IdentityCandidate[]
	}>
	stats: Record<string, number>
}

const words = (k: string) => k.split(" ").filter(Boolean)

function cleanEmails(h: HubDoc): string[] {
	return (h.personCard?.emails ?? [])
		.map((e) => e.toLowerCase())
		.filter((e) => !isServiceEmail(e))
}

/** Full-name keys a hub answers to. */
function fullKeys(h: HubDoc): string[] {
	const keys = new Set<string>()
	const t = parseRef({ name: h.title })
	if (t?.key && words(t.key).length >= 2 && !t.lastInitial) keys.add(t.key)
	for (const a of h.personCard?.aliases ?? [])
		if (words(a).length >= 2) keys.add(a)
	for (const e of cleanEmails(h)) {
		const k = nameKey(nameFromEmail(e))
		if (words(k).length >= 2) keys.add(k)
	}
	return [...keys]
}

/** The display name a hub deserves: its clean title, or the name in its
 *  address when the title is an address. */
function displayName(h: HubDoc): string {
	if (/@/.test(h.title)) {
		const e = cleanEmails(h)[0] ?? h.title
		return nameFromEmail(e) || h.title
	}
	return cleanName(h.title)
}

/** A real full name as title, not an address or a relay tag. */
function niceTitle(h: HubDoc): boolean {
	return !/@/.test(h.title) && cleanName(h.title) === h.title.trim()
}

class UnionFind {
	private parent = new Map<string, string>()
	find(x: string): string {
		const p = this.parent.get(x)
		if (!p || p === x) return x
		const r = this.find(p)
		this.parent.set(x, r)
		return r
	}
	union(a: string, b: string) {
		const ra = this.find(a)
		const rb = this.find(b)
		if (ra !== rb) this.parent.set(rb, ra)
	}
}

const candidate = (e: HubEntry): IdentityCandidate => ({
	slug: e.slug,
	title: e.title,
	reason: e.emails[0] ? `${e.title} (${e.emails[0]})` : e.title,
})

export function planPeopleCleanup(
	hubs: HubDoc[],
	links: SourceLinks,
): CleanupPlan {
	const plan: CleanupPlan = {
		orgs: [],
		merges: [],
		relinks: [],
		retire: [],
		ambiguousHubs: [],
		suggestions: [],
		stats: {},
	}
	const people = hubs.filter((h) => h.slug.startsWith("people/"))
	const existingOrgs = hubs.filter((h) => h.slug.startsWith("orgs/"))

	// 1. Classify.
	const full: HubDoc[] = []
	const partial: HubDoc[] = []
	const multi: HubDoc[] = []
	const singleWithEmail: HubDoc[] = []
	const orgGroups = new Map<string, CleanupPlan["orgs"][number]>()
	for (const h of people) {
		const emails = h.personCard?.emails ?? []
		const ref = parseRef({ name: h.title, email: emails[0] })
		if (!ref) continue
		if (ref.kind !== "person") {
			const title = ref.name ?? h.title
			const into =
				existingOrgs.find((o) => nameKey(o.title) === nameKey(title))?.slug ??
				`orgs/${slugify(title, 48)}`
			const g = orgGroups.get(into) ?? {
				into,
				title,
				type: ref.kind === "service" ? ("service" as const) : ("team" as const),
				emails: [],
				from: [],
			}
			g.from.push(h.slug)
			for (const e of emails) if (!g.emails.includes(e)) g.emails.push(e)
			orgGroups.set(into, g)
			continue
		}
		if (cleanEmails(h).length === 0 && splitRefs(h.title).length > 1)
			multi.push(h)
		else if (fullKeys(h).length > 0) full.push(h)
		else if (cleanEmails(h).length > 0) singleWithEmail.push(h)
		else partial.push(h)
	}
	plan.orgs = [...orgGroups.values()]

	// 2. Cluster full names: a shared address, or a shared name unless both
	//    sides have different addresses (then ask).
	const uf = new UnionFind()
	const byEmail = new Map<string, string>()
	const byKey = new Map<string, HubDoc[]>()
	for (const h of full) {
		for (const e of cleanEmails(h)) {
			const other = byEmail.get(e)
			if (other) uf.union(other, h.slug)
			else byEmail.set(e, h.slug)
		}
		for (const k of fullKeys(h)) byKey.set(k, [...(byKey.get(k) ?? []), h])
	}
	const askedPairs = new Set<string>()
	for (const [, group] of byKey) {
		for (let i = 1; i < group.length; i++) {
			const a = group[0]
			const b = group[i]
			const ea = cleanEmails(a)
			const eb = cleanEmails(b)
			if (ea.length && eb.length && !ea.some((e) => eb.includes(e))) {
				const pair = [a.slug, b.slug].sort().join("|")
				if (askedPairs.has(pair)) continue
				askedPairs.add(pair)
				plan.suggestions.push({
					kind: "merge",
					subject: b.slug,
					subjectTitle: `${displayName(b)} (${eb[0]})`,
					candidates: [
						{
							slug: a.slug,
							title: displayName(a),
							reason: `same name, address ${ea[0]}`,
						},
					],
				})
			} else uf.union(a.slug, b.slug)
		}
	}
	const clusters = new Map<string, HubDoc[]>()
	for (const h of full) {
		const r = uf.find(h.slug)
		clusters.set(r, [...(clusters.get(r) ?? []), h])
	}
	// The resolved directory after merging, for steps 3-5.
	const entries: HubEntry[] = []
	const winnerOf = new Map<string, string>()
	for (const group of clusters.values()) {
		const ranked = [...group].sort(
			(a, b) =>
				Number(niceTitle(b)) - Number(niceTitle(a)) ||
				b.backlinks.length - a.backlinks.length ||
				a.slug.length - b.slug.length,
		)
		const winner = ranked[0]
		const emails = [...new Set(group.flatMap(cleanEmails))]
		const aliases = [...new Set(group.flatMap(fullKeys))]
		const title = displayName(winner)
		for (const h of group) winnerOf.set(h.slug, winner.slug)
		entries.push({
			slug: winner.slug,
			title,
			org: false,
			emails,
			keys: aliases,
			ambiguousHub: false,
		})
		const needsCard =
			title !== winner.title ||
			emails.join() !== (winner.personCard?.emails ?? []).join() ||
			aliases.some((a) => !(winner.personCard?.aliases ?? []).includes(a))
		if (group.length > 1 || needsCard)
			plan.merges.push({
				into: winner.slug,
				title,
				emails,
				aliases,
				from: ranked.slice(1).map((h) => h.slug),
				reason:
					group.length > 1 ? "same person (address or full name)" : "tidy name",
			})
	}
	const resolveCtx = (source: string) =>
		(links.get(source) ?? [])
			.map((l) => winnerOf.get(l.target) ?? l.target)
			.filter((t) => t.startsWith("people/"))

	// 3. First names and "Taylor M": follow each link.
	for (const h of partial) {
		const ref = parseRef({ name: h.title })
		if (!ref) continue
		const decided: Array<{
			source: string
			kind: string
			to?: string
			amb?: HubEntry[]
		}> = []
		for (const source of h.backlinks) {
			const kinds = (links.get(source) ?? []).filter((l) => l.target === h.slug)
			const m = matchPerson(entries, ref, resolveCtx(source))
			for (const k of kinds)
				decided.push({
					source,
					kind: k.kind,
					to: m.entry?.slug,
					amb: m.ambiguous,
				})
		}
		const targets = new Set(decided.map((d) => d.to))
		const global = matchPerson(entries, ref)
		if (decided.length && targets.size === 1 && decided[0].to) {
			const to = decided[0].to
			const e = entries.find((x) => x.slug === to)
			plan.merges.push({
				into: to,
				title: e?.title ?? to,
				emails: e?.emails ?? [],
				aliases: e?.keys ?? [],
				from: [h.slug],
				reason: `"${h.title}" is ${e?.title ?? to} everywhere it appears`,
			})
			continue
		}
		if (!decided.length && global.entry) {
			plan.merges.push({
				into: global.entry.slug,
				title: global.entry.title,
				emails: global.entry.emails,
				aliases: global.entry.keys,
				from: [h.slug],
				reason: `the only ${h.title} known`,
			})
			continue
		}
		let asked = false
		for (const d of decided) {
			if (d.to)
				plan.relinks.push({
					source: d.source,
					kind: d.kind,
					from: h.slug,
					to: [d.to],
				})
			else if (d.amb) {
				asked = true
				plan.suggestions.push({
					kind: "link",
					subject: h.slug,
					subjectTitle: h.title,
					from: d.source,
					edgeKind: d.kind,
					candidates: d.amb.slice(0, 8).map(candidate),
				})
			}
		}
		if (asked || global.ambiguous) plan.ambiguousHubs.push(h.slug)
	}

	// 4. "Lauren / Steffan": one link to each, when every part resolves.
	for (const h of multi) {
		const parts = splitRefs(h.title)
			.map((n) => parseRef({ name: n }))
			.filter((r): r is NonNullable<typeof r> => Boolean(r))
		let moved = 0
		let total = 0
		for (const source of h.backlinks) {
			for (const l of (links.get(source) ?? []).filter(
				(x) => x.target === h.slug,
			)) {
				total++
				const to = parts.map(
					(r) => matchPerson(entries, r, resolveCtx(source)).entry?.slug,
				)
				if (to.every(Boolean)) {
					plan.relinks.push({
						source,
						kind: l.kind,
						from: h.slug,
						to: to as string[],
					})
					moved++
				}
			}
		}
		if (total > 0 && moved === total) plan.retire.push(h.slug)
	}

	// 5. Ask: single-name addresses vs a full name at the same company, and
	//    first names that are short forms (Ben / Benjamin) at the same company.
	const domain = (e: string) => e.split("@")[1] ?? ""
	for (const h of singleWithEmail) {
		const ref = parseRef({ name: displayName(h) })
		const d = domain(cleanEmails(h)[0])
		const fits = entries.filter(
			(e) =>
				ref?.first &&
				words(e.keys[0] ?? "")[0] === ref.first &&
				e.emails.some((x) => domain(x) === d),
		)
		if (fits.length >= 1 && fits.length <= 3)
			plan.suggestions.push({
				kind: "merge",
				subject: h.slug,
				subjectTitle: `${displayName(h)} (${cleanEmails(h)[0]})`,
				candidates: fits.map((e) => ({
					...candidate(e),
					reason: `same first name at ${d}`,
				})),
			})
	}
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i]
			const b = entries[j]
			const wa = words(nameKey(a.title))
			const wb = words(nameKey(b.title))
			if (wa.length < 2 || wb.length < 2) continue
			if (wa[wa.length - 1] !== wb[wb.length - 1]) continue
			const [s, l] =
				wa[0].length <= wb[0].length ? [wa[0], wb[0]] : [wb[0], wa[0]]
			if (s === l || s.length < 3 || !l.startsWith(s)) continue
			if (!a.emails.some((x) => b.emails.some((y) => domain(x) === domain(y))))
				continue
			plan.suggestions.push({
				kind: "merge",
				subject: b.slug,
				subjectTitle: b.title,
				candidates: [
					{ ...candidate(a), reason: `${s} / ${l} at the same company` },
				],
			})
		}
	}

	plan.stats = {
		hubs: people.length,
		toOrgs: plan.orgs.reduce((n, o) => n + o.from.length, 0),
		merged: plan.merges.reduce((n, m) => n + m.from.length, 0),
		retitled: plan.merges.filter((m) => m.from.length === 0).length,
		relinks: plan.relinks.length,
		retire: plan.retire.length,
		suggestions: plan.suggestions.length,
	}
	return plan
}

// ---------------------------------------------------------------- loading

export async function loadCleanupInput(
	handle: WikiDbHandle,
	scope: string,
	scopeRef: string,
): Promise<{ hubs: HubDoc[]; links: SourceLinks }> {
	const coll = wikiPagesCollection(handle.db, handle.prefix)
	const hubDocs = await coll
		.find(
			{
				scope,
				scopeRef,
				slug: /^(people|orgs)\//,
				deleted: { $ne: true },
				state: { $ne: "superseded" },
			},
			{ projection: { slug: 1, title: 1, personCard: 1, backlinks: 1 } },
		)
		.toArray()
	const hubs: HubDoc[] = hubDocs.map((d) => ({
		slug: d.slug,
		title: d.title ?? d.slug,
		personCard: d.personCard ?? null,
		backlinks: ((d.backlinks ?? []) as Array<{ sourcePageSlug: string }>).map(
			(b) => b.sourcePageSlug,
		),
	}))
	const sources = [...new Set(hubs.flatMap((h) => h.backlinks))]
	const links: SourceLinks = new Map()
	for (let i = 0; i < sources.length; i += 500) {
		const docs = await coll
			.find(
				{ scope, scopeRef, slug: { $in: sources.slice(i, i + 500) } },
				{ projection: { slug: 1, relationships: 1 } },
			)
			.toArray()
		for (const d of docs)
			links.set(
				d.slug,
				(
					(d.relationships ?? []) as Array<{
						kind: string
						targetPageSlug: string
					}>
				)
					.filter((r) => /^(people|orgs)\//.test(r.targetPageSlug))
					.map((r) => ({ kind: r.kind, target: r.targetPageSlug })),
			)
	}
	return { hubs, links }
}

// ---------------------------------------------------------------- applying

export interface CleanupResult {
	applied: Record<string, number>
	errors: string[]
}

export async function applyPeopleCleanup(
	handle: WikiDbHandle,
	plan: CleanupPlan,
	p: { scope: string; scopeRef: string; editor?: { subjectId: string } },
): Promise<CleanupResult> {
	const { scope, scopeRef } = p
	const out: CleanupResult = {
		applied: {
			orgs: 0,
			merged: 0,
			retitled: 0,
			relinked: 0,
			retired: 0,
			suggested: 0,
		},
		errors: [],
	}
	const coll = wikiPagesCollection(handle.db, handle.prefix)
	const attempt = async (what: string, fn: () => Promise<void>) => {
		try {
			await fn()
		} catch (err) {
			out.errors.push(
				`${what}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	const merge = (from: string, into: string) =>
		mergePages(handle, {
			from,
			into,
			scope,
			scopeRef,
			...(p.editor ? { editor: p.editor as never } : {}),
		})

	for (const o of plan.orgs)
		await attempt(`org ${o.into}`, async () => {
			const exists = await coll.findOne({ scope, scopeRef, slug: o.into })
			if (!exists)
				await createWikiPage(handle, {
					kind: "entity",
					title: o.title,
					slug: o.into,
					summary: `${o.type === "service" ? "Automated sender" : "Team"}: ${o.title}. Messages and meetings from it link here.`,
					body: "",
					frontmatter: { type: o.type },
					personCard: { canonicalId: o.into, emails: o.emails } as never,
					scope: scope as never,
					scopeRef,
					trustTier: "standard" as never,
				})
			for (const from of o.from) {
				await merge(from, o.into)
				out.applied.orgs++
			}
		})

	for (const m of plan.merges)
		await attempt(`merge into ${m.into}`, async () => {
			const page = await coll.findOne(
				{ scope, scopeRef, slug: m.into },
				{ projection: { title: 1, personCard: 1 } },
			)
			if (!page) throw new Error("target is gone")
			const card = (page.personCard ?? {}) as Record<string, unknown>
			await updateWikiPage(handle, m.into, scope, scopeRef, {
				...(page.title !== m.title ? { title: m.title } : {}),
				personCard: {
					...card,
					canonicalId: (card.canonicalId as string) ?? m.into,
					emails: m.emails,
					...(m.aliases.length ? { aliases: m.aliases } : {}),
				} as never,
			})
			if (m.from.length === 0) out.applied.retitled++
			for (const from of m.from) {
				await merge(from, m.into)
				out.applied.merged++
			}
		})

	for (const r of plan.relinks)
		await attempt(`relink ${r.source}`, async () => {
			const titles = await coll
				.find(
					{ scope, scopeRef, slug: { $in: r.to } },
					{ projection: { slug: 1, title: 1 } },
				)
				.toArray()
			await addRelationships(
				handle,
				r.source,
				scope,
				scopeRef,
				r.to.map((to) => ({
					targetPageSlug: to,
					targetTitle: titles.find((t) => t.slug === to)?.title ?? to,
					kind: r.kind,
					weight: 1,
					confidence: 0.9,
				})),
			)
			await removeRelationships(handle, r.source, scope, scopeRef, [
				{ targetPageSlug: r.from, kind: r.kind },
			])
			out.applied.relinked++
		})

	for (const slug of plan.retire)
		await attempt(`retire ${slug}`, async () => {
			if (await deleteWikiPage(handle, slug, scope, scopeRef))
				out.applied.retired++
		})

	for (const slug of plan.ambiguousHubs)
		await attempt(`mark ${slug}`, async () => {
			const page = await coll.findOne(
				{ scope, scopeRef, slug },
				{ projection: { personCard: 1 } },
			)
			await updateWikiPage(handle, slug, scope, scopeRef, {
				personCard: {
					...((page?.personCard ?? {}) as Record<string, unknown>),
					canonicalId: slug,
					ambiguous: true,
				} as never,
			})
		})

	for (const s of plan.suggestions)
		await attempt(`suggest ${s.subject}`, async () => {
			await recordIdentitySuggestion(handle, {
				scope,
				scopeRef,
				kind: s.kind,
				subjectSlug: s.subject,
				subjectTitle: s.subjectTitle,
				...(s.from ? { fromSlug: s.from } : {}),
				...(s.edgeKind ? { edgeKind: s.edgeKind } : {}),
				candidates: s.candidates,
			})
			out.applied.suggested++
		})

	invalidatePeopleDirectory(handle)
	return out
}
