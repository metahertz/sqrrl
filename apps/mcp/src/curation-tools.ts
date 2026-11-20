// Curation tools: let an agent do over MCP what the dashboard's maintenance
// panel does by hand — list and update tasks, fix links, merge duplicate
// pages — plus search Layer 1's raw items. roadmap phase 4.
//
// Each tool wraps existing client methods and adds only what an agent
// cannot do in one call: listing pages through every status, resolving an
// owner name to an existing person page, reading a target's title before
// linking to it, re-sending a task card with its revision.

import type { SqrrlClient } from "@sqrrl/client"

export type CurationClient = Pick<
	SqrrlClient,
	| "wikiList"
	| "wikiGet"
	| "wikiSetTaskStatus"
	| "wikiReassignTask"
	| "wikiEditRelationships"
	| "wikiMerge"
	| "rawSearch"
>

/** Mirrors WIKI_SCOPE_VALUES in @sqrrl/wiki-engine; contract-parity
 *  in apps/api fails if they drift. */
export const SCOPES = ["workspace", "user"]
const TASK_STATUSES = [
	"open",
	"in-progress",
	"blocked",
	"done",
	"dropped",
] as const
type TaskStatus = (typeof TASK_STATUSES)[number]
const UNFINISHED: TaskStatus[] = ["open", "in-progress", "blocked"]
const PAGE_SIZE = 100
const MAX_TASKS = 200

const scopeProps = {
	scope: { type: "string", enum: SCOPES },
	scopeRef: {
		type: "string",
		description: 'Concrete namespace for the scope, e.g. "default".',
	},
} as const

export const curationTools = [
	{
		name: "sqrrl_wiki_tasks",
		description:
			"List task pages (commitments extracted from notes, with owner, status and due date). Defaults to unfinished tasks (open, in-progress, blocked), soonest due first. Use overdue:true for tasks past their due date.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				status: {
					type: "string",
					enum: ["unfinished", "all", ...TASK_STATUSES],
					description: 'Default "unfinished".',
				},
				owner: {
					type: "string",
					description: "Owner name, case-insensitive exact match.",
				},
				overdue: {
					type: "boolean",
					description: "Only tasks whose due date is before asOf.",
				},
				dueBefore: {
					type: "string",
					description: "Only tasks due on or before this date (YYYY-MM-DD).",
				},
				asOf: {
					type: "string",
					description:
						"Today for the overdue test (YYYY-MM-DD); defaults to today (UTC).",
				},
				limit: { type: "number", description: "Default 50, at most 200." },
			},
			required: ["scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_wiki_task_set_status",
		description:
			"Set a task's status (open, in-progress, blocked, done, dropped). done records completedAt. A status set here survives re-ingestion of the source note. Fails with REVISION_CONFLICT if the task changed since it was read; re-run to retry.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				slug: {
					type: "string",
					description: 'Task page slug, e.g. "tasks/...".',
				},
				status: { type: "string", enum: [...TASK_STATUSES] },
			},
			required: ["slug", "scope", "scopeRef", "status"],
		},
	},
	{
		name: "sqrrl_wiki_task_reassign",
		description:
			"Reassign a task to another person. The owner must already have a person page (people/...): give its slug or the person's name. Person pages are created by ingestion, never here, so a name with no page is an error that lists the closest existing people.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				slug: { type: "string", description: "Task page slug." },
				owner: {
					type: "string",
					description: 'Person name or person page slug ("people/...").',
				},
			},
			required: ["slug", "scope", "scopeRef", "owner"],
		},
	},
	{
		name: "sqrrl_wiki_link",
		description:
			"Add or remove links (relationships) from one wiki page to others in the same scope. Common kinds: relates_to, derived_from, depends_on, uses, works_at. To change a task's owner use sqrrl_wiki_task_reassign, not an owned_by link.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				slug: { type: "string", description: "Page the links go from." },
				add: {
					type: "array",
					items: {
						type: "object",
						properties: {
							target: { type: "string", description: "Target page slug." },
							kind: { type: "string" },
						},
						required: ["target", "kind"],
					},
				},
				remove: {
					type: "array",
					items: {
						type: "object",
						properties: {
							target: { type: "string" },
							kind: {
								type: "string",
								description: "Omit to remove every link to the target.",
							},
						},
						required: ["target"],
					},
				},
			},
			required: ["slug", "scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_wiki_merge",
		description:
			"Merge a duplicate page into another: links into `from` are moved to `into`, and `from` is superseded. Use for two pages that mean the same thing (e.g. two topic hubs for one subject). Cannot be undone through MCP — confirm with the user first.",
		inputSchema: {
			type: "object",
			properties: {
				...scopeProps,
				from: {
					type: "string",
					description: "The duplicate, which is retired.",
				},
				into: { type: "string", description: "The page that remains." },
			},
			required: ["from", "into", "scope", "scopeRef"],
		},
	},
	{
		name: "sqrrl_raw_search",
		description:
			"Search raw source items (Layer 1): the exact text of notes, files and transcripts the wiki was distilled from. Use it for quotes and for detail a wiki summary dropped. Filter by source, kind, author, channel, thread and an occurredAt range; rerank:true improves ordering.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				...scopeProps,
				source: {
					type: "string",
					description: 'e.g. "apple-notes", "nextcloud".',
				},
				kind: {
					type: "string",
					enum: ["note", "file", "message", "email", "event"],
				},
				channel: { type: "string" },
				thread: { type: "string" },
				author: { type: "string" },
				from: {
					type: "string",
					description: "occurredAt lower bound (ISO date).",
				},
				to: {
					type: "string",
					description: "occurredAt upper bound (ISO date).",
				},
				includeHistory: {
					type: "boolean",
					description: "Also search superseded versions.",
				},
				limit: { type: "number", description: "Default 10, at most 50." },
				rerank: { type: "boolean" },
			},
			required: ["query", "scope", "scopeRef"],
		},
	},
] as const

export const CURATION_TOOL_NAMES: ReadonlySet<string> = new Set(
	curationTools.map((t) => t.name),
)

// ---------------------------------------------------------------------------

type Args = Record<string, unknown>
type Page = {
	slug: string
	title: string
	kind?: string
	revision?: number
	taskCard?: {
		owner: string
		status?: string
		dueDate?: string
		completedAt?: string | null
		sourceRef?: string
	} | null
}

function str(args: Args, key: string, required = true): string {
	const value = args[key]
	if (typeof value === "string" && value.trim()) return value.trim()
	if (required) throw new Error(`${key} is required`)
	return ""
}

function scopeOf(args: Args): { scope: string; scopeRef: string } {
	return { scope: str(args, "scope"), scopeRef: str(args, "scopeRef") }
}

function isoDay(value: unknown, key: string): string | undefined {
	if (value === undefined || value === "") return undefined
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value))
		throw new Error(`${key} must be a date (YYYY-MM-DD)`)
	return value.slice(0, 10)
}

/** Same as the source layer's slugify for people/ hubs, so a name resolves
 *  to the page ingestion would have made for it. */
function slugify(text: string, maxLen: number): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, maxLen)
			.replace(/-+$/, "") || "untitled"
	)
}

async function listAll(
	client: CurationClient,
	params: {
		scope: string
		scopeRef: string
		kind: string
		taskStatus?: string
	},
): Promise<Page[]> {
	const out: Page[] = []
	for (let skip = 0; ; skip += PAGE_SIZE) {
		const res = (await client.wikiList({
			...params,
			limit: PAGE_SIZE,
			skip,
		})) as {
			pages?: Page[]
			total?: number
		}
		const pages = res.pages ?? []
		out.push(...pages)
		if (pages.length === 0 || out.length >= (res.total ?? 0)) return out
	}
}

async function getPage(
	client: CurationClient,
	slug: string,
	scope: { scope: string; scopeRef: string },
): Promise<Page> {
	return (await client.wikiGet({ slug, ...scope, format: "json" })) as Page
}

function toolResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		structuredContent: payload as Record<string, unknown>,
	}
}

async function listTasks(client: CurationClient, args: Args) {
	const scope = scopeOf(args)
	const status = typeof args.status === "string" ? args.status : "unfinished"
	const statuses: readonly string[] =
		status === "unfinished"
			? UNFINISHED
			: status === "all"
				? TASK_STATUSES
				: [status]
	if (!statuses.every((s) => (TASK_STATUSES as readonly string[]).includes(s)))
		throw new Error(
			`status must be unfinished, all, or one of ${TASK_STATUSES.join("|")}`,
		)
	const asOf =
		isoDay(args.asOf, "asOf") ?? new Date().toISOString().slice(0, 10)
	const dueBefore = isoDay(args.dueBefore, "dueBefore")
	const owner =
		typeof args.owner === "string" ? args.owner.trim().toLowerCase() : ""
	const limit = Math.max(
		1,
		Math.min(
			MAX_TASKS,
			typeof args.limit === "number" ? Math.floor(args.limit) : 50,
		),
	)

	const pages: Page[] = []
	for (const s of statuses)
		pages.push(
			...(await listAll(client, {
				...scope,
				kind: "procedure",
				taskStatus: s,
			})),
		)

	const tasks = pages
		.filter((p) => p.taskCard)
		.map((p) => {
			const card = p.taskCard as NonNullable<Page["taskCard"]>
			const dueDate = card.dueDate?.slice(0, 10)
			const unfinished = UNFINISHED.includes(card.status as TaskStatus)
			return {
				slug: p.slug,
				title: p.title,
				owner: card.owner,
				status: card.status ?? "open",
				...(dueDate ? { dueDate } : {}),
				overdue: Boolean(dueDate && unfinished && dueDate < asOf),
				...(card.sourceRef ? { sourceRef: card.sourceRef } : {}),
				revision: p.revision,
			}
		})
		.filter((t) => !owner || t.owner.toLowerCase() === owner)
		.filter((t) => !args.overdue || t.overdue)
		.filter(
			(t) => !dueBefore || (t.dueDate !== undefined && t.dueDate <= dueBefore),
		)
		.sort(
			(a, b) =>
				(a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
				a.title.localeCompare(b.title),
		)
	return {
		...scope,
		asOf,
		matched: tasks.length,
		returned: Math.min(limit, tasks.length),
		tasks: tasks.slice(0, limit),
	}
}

async function setTaskStatus(client: CurationClient, args: Args) {
	const scope = scopeOf(args)
	const slug = str(args, "slug")
	const status = str(args, "status")
	if (!(TASK_STATUSES as readonly string[]).includes(status))
		throw new Error(`status must be one of ${TASK_STATUSES.join("|")}`)
	const page = await getPage(client, slug, scope)
	if (!page.taskCard)
		throw new Error(`${slug} is not a task page (no taskCard)`)
	await client.wikiSetTaskStatus({
		slug,
		...scope,
		status: status as TaskStatus,
		taskCard: page.taskCard,
		// Re-sending the whole card is only safe if nobody changed it meanwhile.
		...(typeof page.revision === "number"
			? { expectedRevision: page.revision }
			: {}),
	})
	return {
		slug,
		title: page.title,
		owner: page.taskCard.owner,
		previousStatus: page.taskCard.status ?? "open",
		status,
	}
}

async function reassignTask(client: CurationClient, args: Args) {
	const scope = scopeOf(args)
	const slug = str(args, "slug")
	const wanted = str(args, "owner")
	const people = (await listAll(client, { ...scope, kind: "entity" })).filter(
		(p) => p.slug.startsWith("people/"),
	)
	const bySlug = wanted.startsWith("people/")
		? wanted
		: `people/${slugify(wanted, 48)}`
	const hub =
		people.find((p) => p.slug === bySlug) ??
		people.find((p) => p.title.toLowerCase() === wanted.toLowerCase())
	if (!hub) {
		const words = wanted
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean)
		const near = people
			.filter((p) => words.some((w) => p.title.toLowerCase().includes(w)))
			.slice(0, 5)
			.map((p) => `${p.title} (${p.slug})`)
		throw new Error(
			`no person page for "${wanted}" in ${scope.scope}/${scope.scopeRef}${near.length ? `; closest: ${near.join(", ")}` : ""}. Person pages are created by ingestion.`,
		)
	}
	const out = await client.wikiReassignTask({
		slug,
		...scope,
		owner: { name: hub.title, hubSlug: hub.slug },
	})
	return { slug, owner: hub.title, ownerPage: hub.slug, result: out }
}

async function editLinks(client: CurationClient, args: Args) {
	const scope = scopeOf(args)
	const slug = str(args, "slug")
	const addIn = Array.isArray(args.add) ? (args.add as Args[]) : []
	const removeIn = Array.isArray(args.remove) ? (args.remove as Args[]) : []
	if (addIn.length === 0 && removeIn.length === 0)
		throw new Error("give add and/or remove")
	const add = []
	for (const a of addIn) {
		const target = str(a, "target")
		// Reading the target checks it exists in this scope and supplies the
		// title the edge stores; a link to a missing page would dangle.
		const page = await getPage(client, target, scope)
		add.push({
			targetPageSlug: target,
			targetTitle: page.title,
			kind: str(a, "kind"),
		})
	}
	const remove = removeIn.map((r) => ({
		targetPageSlug: str(r, "target"),
		...(typeof r.kind === "string" && r.kind ? { kind: r.kind } : {}),
	}))
	const out = await client.wikiEditRelationships({
		slug,
		...scope,
		...(add.length ? { add } : {}),
		...(remove.length ? { remove } : {}),
	})
	// The API answers with the whole page; an agent needs the outcome and
	// the links as they now stand, not the body.
	const res = out as {
		added?: number
		removed?: number
		page?: { relationships?: Array<{ targetPageSlug: string; kind: string }> }
	}
	return {
		slug,
		added: res.added ?? 0,
		removed: res.removed ?? 0,
		links: (res.page?.relationships ?? []).map((r) => ({
			target: r.targetPageSlug,
			kind: r.kind,
		})),
	}
}

async function merge(client: CurationClient, args: Args) {
	const scope = scopeOf(args)
	const from = str(args, "from")
	const into = str(args, "into")
	if (from === into) throw new Error("from and into must differ")
	const out = await client.wikiMerge({ from, into, ...scope })
	return { from, into, ...(out as Record<string, unknown>) }
}

async function rawSearch(client: CurationClient, args: Args) {
	const scope = scopeOf(args)
	const opt = (k: string) =>
		typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined
	return client.rawSearch({
		query: str(args, "query"),
		...scope,
		source: opt("source"),
		kind: opt("kind") as
			| "note"
			| "file"
			| "message"
			| "email"
			| "event"
			| undefined,
		channel: opt("channel"),
		thread: opt("thread"),
		author: opt("author"),
		from: opt("from"),
		to: opt("to"),
		includeHistory: args.includeHistory === true ? true : undefined,
		limit: typeof args.limit === "number" ? args.limit : undefined,
		rerank: args.rerank === true ? true : undefined,
	})
}

const HANDLERS: Record<
	string,
	(c: CurationClient, a: Args) => Promise<unknown>
> = {
	sqrrl_wiki_tasks: listTasks,
	sqrrl_wiki_task_set_status: setTaskStatus,
	sqrrl_wiki_task_reassign: reassignTask,
	sqrrl_wiki_link: editLinks,
	sqrrl_wiki_merge: merge,
	sqrrl_raw_search: rawSearch,
}

/** Runs a curation tool, or returns undefined for a name it does not own.
 *  Errors propagate to the server's handler, which forwards API error
 *  envelopes (REVISION_CONFLICT, FORBIDDEN, ...) to the agent. */
export async function handleCurationTool(
	name: string,
	args: Args,
	client: CurationClient,
) {
	const handler = HANDLERS[name]
	if (!handler) return undefined
	return toolResult(await handler(client, args))
}
