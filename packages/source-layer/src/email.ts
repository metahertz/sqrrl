// Email threads into the wiki (roadmap, Phase 6.3).
//
// The unit is a thread: every message sharing a References root is one
// raw-item unit (email:<root>), and a thread that gained or changed a
// message is re-read whole and distilled like a note — page, claims, tasks
// with owners, topics — at a stable path, so a long thread is one page that
// grows rather than a page per reply. The mailbox owner reads as "me", as
// in notes. Correspondents become participant edges to people/ pages:
// someone who wrote in the thread may get a new hub in a small thread
// (six people or fewer); recipients only link to hubs that already exist,
// so a large cc list never mints pages.

import { createHash } from "node:crypto"
import {
	addRelationships,
	sourceToSlug,
	type WikiDbHandle,
	type WikiRelationshipSpec,
} from "@sqrrl/wiki-engine"
import { type DistillDeps, distillChangedSources } from "./distill.js"
import type { MailAddress } from "./mail-parse.js"
import { resolvePersonHub, slugify } from "./people.js"
import { listRawItemsInUnit, type RawItemView } from "./raw-items.js"

const MAX_NEW_PEOPLE_THREAD = 6
const MIN_TRANSCRIPT_CHARS = 120

export interface EmailDistillSummary {
	threads: number
	distilled: number
	tasksCreated: number
	peopleCreated: number
	peopleLinked: number
	errors: string[]
}

type Meta = {
	subject?: string
	from?: MailAddress
	to?: MailAddress[]
	cc?: MailAddress[]
}

function meta(item: RawItemView): Meta {
	return (item.metadata ?? {}) as Meta
}

function who(a: MailAddress | undefined): string {
	if (!a) return "unknown"
	return a.self ? "me" : (a.name ?? a.email)
}

/** The page path for a thread: month it started, subject, and a short hash
 *  of the root id, so two "Re: update" threads never share a page. */
export function threadPath(
	root: string,
	subject: string,
	firstAt: Date | undefined,
): string {
	const month = (firstAt ?? new Date()).toISOString().slice(0, 7)
	const clean =
		subject.replace(/^((re|fw|fwd|aw|sv)\s*:\s*)+/i, "").trim() || "no subject"
	const hash = createHash("sha1").update(root).digest("hex").slice(0, 6)
	return `email/${month}/${slugify(clean, 50)}-${hash}`
}

/** A thread as the distiller reads it: oldest first, each message's new
 *  text under who wrote it to whom. */
export function renderThread(items: RawItemView[]): string {
	const sorted = [...items].sort((a, b) =>
		String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")),
	)
	const first = sorted[0]
	const subject = meta(first).subject ?? first.title ?? "(no subject)"
	const day = (i: RawItemView) =>
		i.occurredAt
			? new Date(i.occurredAt).toISOString().replace("T", " ").slice(0, 16)
			: ""
	const blocks = sorted.map((i) => {
		const m = meta(i)
		const to = (m.to ?? []).map(who)
		const cc = (m.cc ?? []).map(who)
		const head = `[${day(i)}] ${who(m.from)} → ${to.join(", ") || "?"}${cc.length ? ` (cc ${cc.join(", ")})` : ""}`
		// The raw text leads with From/To/Subject lines; the body follows the
		// first blank line.
		const at = i.text.indexOf("\n\n")
		const body = (at === -1 ? i.text : i.text.slice(at + 2)).trim()
		return `${head}\n${body}`
	})
	return [
		`Email thread: ${subject}`,
		`${sorted.length} message(s)`,
		"",
		blocks.join("\n\n"),
	].join("\n")
}

export async function distillEmailThreads(
	handle: WikiDbHandle,
	roots: string[],
	deps: DistillDeps,
	options: { scope: string; scopeRef: string; trustTier?: string },
): Promise<EmailDistillSummary> {
	const { scope, scopeRef } = options
	const out: EmailDistillSummary = {
		threads: 0,
		distilled: 0,
		tasksCreated: 0,
		peopleCreated: 0,
		peopleLinked: 0,
		errors: [],
	}
	for (const root of [...new Set(roots)]) {
		out.threads++
		try {
			const items = (
				await listRawItemsInUnit(handle, {
					scope,
					scopeRef,
					unit: `email:${root}`,
				})
			).filter((i) => i.text !== "")
			if (!items.length) continue
			const transcript = renderThread(items)
			if (transcript.length < MIN_TRANSCRIPT_CHARS) continue
			const sorted = [...items].sort((a, b) =>
				String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")),
			)
			const first = sorted[0]
			const last = sorted[sorted.length - 1]
			const path = threadPath(
				root,
				meta(first).subject ?? first.title ?? "",
				first.occurredAt ? new Date(first.occurredAt) : undefined,
			)
			const result = await distillChangedSources(
				handle,
				[{ path, content: transcript }],
				deps,
				{
					scope,
					scopeRef,
					...(options.trustTier ? { trustTier: options.trustTier } : {}),
					extractTasks: true,
					noteDate: last.occurredAt
						? new Date(last.occurredAt).toISOString().slice(0, 10)
						: undefined,
				},
			)
			if (result.errors.length) {
				out.errors.push(`${path}: ${result.errors.join("; ")}`)
				continue
			}
			out.distilled++
			out.tasksCreated += result.tasks?.created ?? 0
			await linkPeople(handle, sourceToSlug(path), sorted, options, out)
		} catch (err) {
			out.errors.push(
				`${root}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return out
}

async function linkPeople(
	handle: WikiDbHandle,
	pageSlug: string,
	items: RawItemView[],
	options: { scope: string; scopeRef: string; trustTier?: string },
	out: EmailDistillSummary,
) {
	const senders = new Map<string, MailAddress>()
	const everyone = new Map<string, MailAddress>()
	for (const i of items) {
		const m = meta(i)
		if (m.from && !m.from.self) senders.set(m.from.email, m.from)
		for (const a of [m.from, ...(m.to ?? []), ...(m.cc ?? [])])
			if (a && !a.self) everyone.set(a.email, a)
	}
	const small = everyone.size <= MAX_NEW_PEOPLE_THREAD
	const edges: WikiRelationshipSpec[] = []
	for (const [email, a] of everyone) {
		const hub = await resolvePersonHub(
			handle,
			{ name: a.name, email },
			{
				...options,
				allowCreate: small && senders.has(email),
				context: edges.map((e) => e.targetPageSlug),
				from: { slug: pageSlug, edgeKind: "participant" },
			},
		)
		if (!hub) continue
		if (hub.created) out.peopleCreated++
		if (edges.some((e) => e.targetPageSlug === hub.slug)) continue
		edges.push({
			targetPageSlug: hub.slug,
			targetTitle: hub.title,
			kind: "participant",
			weight: senders.has(email) ? 0.7 : 0.4,
			confidence: 0.9,
		})
	}
	if (edges.length) {
		await addRelationships(
			handle,
			pageSlug,
			options.scope,
			options.scopeRef,
			edges,
		)
		out.peopleLinked += edges.length
	}
}
