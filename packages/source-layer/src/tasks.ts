// Task extraction and reconciliation.
//
// Turning a source document into action items is the other half of wiki
// maintenance: runGitDiffMaintenance produces a page with claims, but a claim
// is prose. An action item needs an owner, a due date and a lifecycle, and
// something has to derive those from the text.
//
// The work lives here rather than in a caller because it is not a formatting
// concern: it decides page identity across runs. Extraction is
// non-deterministic — the same commitment comes back as "Migrate the auth
// service to OIDC" one run and "Migrate auth service to OIDC" the next — so a
// slug derived from task text forks a new page every run and orphans the old
// one. Matching, and the reconcile that follows it, are what make repeated
// ingestion of the same note idempotent.

import {
	addRelationships,
	createWikiPage,
	ensureHubPage,
	getWikiPage,
	listWikiPages,
	searchWikiPages,
	updateWikiPage,
	WikiSearchUnavailableError,
	type WikiDbHandle,
	type WikiRelationshipSpec,
	type WikiTaskCard,
} from "@sqrrl/wiki-engine"
import { splitRefs } from "./identity.js"
import { resolvePersonHub } from "./people.js"

/** The extractor contract. Callers supply the model; the engine supplies the
 *  prompt, so every ingestion path extracts tasks the same way. */
export type TaskExtractFn = (input: {
	sourcePath: string
	/** Anchors relative dates like "next Friday". */
	noteDate: string
	text: string
	/** Topic labels already in use in this scope, so the model reuses one
	 *  instead of coining a near-synonym. */
	existingTopics?: string[]
}) => Promise<TaskExtractionResult>

export interface ExtractedTask {
	task: string
	owner?: string
	/** YYYY-MM-DD, or null/absent when the note gives no deadline. */
	due?: string | null
	/** The span of the source the task came from, verbatim. */
	sourceQuote?: string
}

export interface TaskExtractionResult {
	tasks: ExtractedTask[]
	topics?: string[]
}

/** The extraction instructions.
 *
 *  Deliberately NOT scoped to the reader. Memongo's enrichment prompt asks for
 *  "atomic personal facts about the user", which discards other people's
 *  commitments — and in a meeting note those are usually the ones that matter.
 *  Ownership is the point of a task, so the prompt asks for it explicitly. */
const TOPIC_PREFIX = "topics/"

export const TASK_EXTRACTION_PROMPT = [
	"You extract action items from a note (meeting notes, a todo list, or freeform text).",
	"",
	"Return ONLY a JSON object, no prose, no code fences:",
	'{"tasks":[{"task":"...","owner":"...","due":"YYYY-MM-DD or null","source_quote":"..."}],',
	' "topics":["..."]}',
	"",
	"Rules:",
	"- One entry per distinct action item or commitment.",
	'- owner is whoever is responsible. Use "me" when the note\'s author owns it.',
	"  Capture OTHER PEOPLE's commitments too - they matter most.",
	"- due: resolve relative dates against the note date given below. null if absent.",
	"- source_quote: the span of the note the task came from, verbatim.",
	"- If there are no action items, return an empty tasks array.",
	"- topics: 2-6 short subject tags for the note. Topics are shared hubs that",
	"  join notes about the same subject, so they are only useful when reused.",
	"  Reuse a label from the existing topics list verbatim whenever one fits.",
	"  Never emit two labels for the same subject in one note: pick the one a",
	'  future note is most likely to share. "groceries" or "shopping list",',
	'  not both; "house maintenance" or "boiler", not both.',
	"  Prefer the broader label unless the specific one is the real subject.",
].join("\n")

/** Renders the existing topic vocabulary for the prompt.
 *
 *  Similarity matching cannot solve this on its own: the duplicate labels
 *  observed in practice ("groceries" / "shopping list", "boiler" / "house
 *  maintenance") share no words, so they score zero lexically, and when both
 *  come from the SAME note the semantic pass cannot help either — the first
 *  hub was written milliseconds earlier and Atlas Search has not indexed it.
 *  The model making the extraction call is the only participant that can see
 *  both labels at once and knows they mean the same thing. */
export function renderTopicVocabulary(topics: string[], limit = 120): string {
	if (topics.length === 0) return "Existing topics: (none yet)"
	const shown = topics.slice(0, limit)
	return [
		`Existing topics (reuse verbatim where one fits): ${shown.join(", ")}`,
		topics.length > shown.length
			? `(+${topics.length - shown.length} more not shown)`
			: "",
	]
		.filter(Boolean)
		.join("\n")
}

/** Lists the topic hub labels already in a scope. */
export async function listTopicLabels(
	handle: WikiDbHandle,
	scope: string,
	scopeRef: string,
): Promise<string[]> {
	const out: string[] = []
	let skip = 0
	for (;;) {
		const { pages, total } = await listWikiPages(handle, {
			scope,
			scopeRef,
			kind: "concept",
			limit: 100,
			skip,
		})
		for (const page of pages as unknown as Array<{
			slug: string
			title: string
		}>) {
			if (page.slug.startsWith(TOPIC_PREFIX)) out.push(page.title)
		}
		skip += pages.length
		if (pages.length < 100 || skip >= total) return out
	}
}

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"to",
	"for",
	"of",
	"and",
	"by",
	"in",
	"on",
	"from",
	"with",
	"is",
	"are",
	"be",
	"will",
	"that",
	"this",
	"it",
	"as",
	"at",
	"or",
])

function contentWords(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
			(w) => !STOP_WORDS.has(w),
		),
	)
}

/** Jaccard similarity over content words. */
export function taskSimilarity(a: string, b: string): number {
	const left = contentWords(a)
	const right = contentWords(b)
	if (left.size === 0 || right.size === 0) return 0
	let shared = 0
	for (const w of left) if (right.has(w)) shared++
	return shared / (left.size + right.size - shared)
}

/** Default similarity floor for treating two phrasings as the same task.
 *  Chosen so "Migrate the auth service to OIDC" matches "Migrate auth service
 *  to OIDC" while distinct tasks by the same owner do not collide. */
export const TASK_MATCH_THRESHOLD = 0.6

/** Finds the page already representing this task, or null.
 *
 *  Owner must match: two people can legitimately owe similar work, and merging
 *  those would silently reassign one of them. */
export function matchExistingTaskPage(
	task: ExtractedTask,
	existing: Array<{
		slug: string
		title: string
		taskCard?: WikiTaskCard | null
	}>,
	threshold = TASK_MATCH_THRESHOLD,
): string | null {
	const owner = (task.owner ?? "unassigned").toLowerCase()
	let best: string | null = null
	let bestScore = 0
	for (const page of existing) {
		if ((page.taskCard?.owner ?? "").toLowerCase() !== owner) continue
		const score = taskSimilarity(task.task, page.title)
		if (score > bestScore) {
			best = page.slug
			bestScore = score
		}
	}
	return bestScore >= threshold ? best : null
}

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

export function taskSlug(task: ExtractedTask): string {
	const owner = slugify(task.owner ?? "unassigned", 24)
	return `tasks/${owner}-${slugify(task.task, 40)}`
}

export interface TaskSyncResult {
	created: number
	updated: number
	reopened: number
	dropped: number
	kept: number
	slugs: string[]
	errors: string[]
}

/** Lists the task pages previously derived from one source page. */
export async function listTasksForSource(
	handle: WikiDbHandle,
	sourceSlug: string,
	scope: string,
	scopeRef: string,
): Promise<
	Array<{ slug: string; title: string; taskCard?: WikiTaskCard | null }>
> {
	const out: Array<{
		slug: string
		title: string
		taskCard?: WikiTaskCard | null
	}> = []
	let skip = 0
	// taskCard.sourceRef is not indexed as a filter, so page through the
	// procedure pages in scope and match locally.
	for (;;) {
		const { pages, total } = await listWikiPages(handle, {
			scope,
			scopeRef,
			kind: "procedure",
			limit: 100,
			skip,
		})
		for (const page of pages as unknown as Array<{
			slug: string
			title: string
			taskCard?: WikiTaskCard | null
		}>) {
			if (page.taskCard?.sourceRef === sourceSlug) out.push(page)
		}
		skip += pages.length
		if (pages.length < 100 || skip >= total) return out
	}
}

/** Writes the tasks extracted from one source page, and reconciles the ones
 *  that source no longer produces.
 *
 *  Reconciliation marks a vanished task "dropped" rather than deleting it. A
 *  wiki delete is a soft delete that supersedes the page, and a superseded
 *  slug cannot be written to meaningfully — an update returns 200 and bumps
 *  the revision while the page stays invisible — so deleting here would
 *  poison the slug for the next run that re-extracts the same task.
 *
 *  A status set by hand (done, in-progress, blocked) survives re-extraction.
 *  Only "dropped" is reopened, because that means the task came back. */
/** What a task page keeps from the card already stored when its source note
 *  is extracted again.
 *
 *  A status set by hand wins over the extractor's default: someone marking a
 *  task done or in-progress is stating something the note cannot. The one
 *  exception is "dropped", which is the extractor's OWN marker for a task
 *  that disappeared from its note — seeing the task again means it is back,
 *  so that one reopens.
 *
 *  completedAt rides along only while the status it belongs to is unchanged.
 *  The card is rebuilt from scratch each run, so without this a task marked
 *  done keeps "done" and silently loses WHEN; and a task moved off done must
 *  not keep a stale completion date. */
export function carriedTaskState(existing: WikiTaskCard | null | undefined): {
	status: WikiTaskCard["status"]
	reopened: boolean
	completedAt?: string
} {
	const held = existing?.status
	if (held === "dropped") {
		return { status: "open", reopened: true }
	}
	const status = held ?? "open"
	return {
		status,
		reopened: false,
		...(status === held && existing?.completedAt
			? { completedAt: existing.completedAt }
			: {}),
	}
}

export async function syncTasksForSource(
	handle: WikiDbHandle,
	params: {
		sourceSlug: string
		sourceTitle: string
		tasks: ExtractedTask[]
		topics?: string[]
		noteDate?: string
		scope: string
		scopeRef: string
		trustTier?: string
	},
): Promise<TaskSyncResult> {
	const result: TaskSyncResult = {
		created: 0,
		updated: 0,
		reopened: 0,
		dropped: 0,
		kept: 0,
		slugs: [],
		errors: [],
	}
	const prior = await listTasksForSource(
		handle,
		params.sourceSlug,
		params.scope,
		params.scopeRef,
	)
	const priorBySlug = new Map(prior.map((p) => [p.slug, p]))

	for (const task of params.tasks) {
		if (!task.task?.trim()) continue
		try {
			const owner = (task.owner ?? "unassigned").trim() || "unassigned"
			const slug = matchExistingTaskPage(task, prior) ?? taskSlug(task)
			const existingCard = priorBySlug.get(slug)?.taskCard ?? null
			const carried = carriedTaskState(existingCard)
			const status = carried.status
			if (carried.reopened) result.reopened++

			const due = task.due?.trim() ? task.due.trim() : undefined
			const taskCard: WikiTaskCard = {
				owner,
				status,
				sourceRef: params.sourceSlug,
				...(due ? { dueDate: due } : {}),
				...(carried.completedAt ? { completedAt: carried.completedAt } : {}),
			}
			const frontmatter: Record<string, unknown> = {
				type: "task",
				...(params.topics?.length ? { tags: params.topics.slice(0, 6) } : {}),
				...(params.noteDate ? { noteDate: params.noteDate } : {}),
				// stale_after is the schema's own YYYY-MM-DD field, so the built-in
				// freshness logic sees the deadline too.
				...(due ? { stale_after: due } : {}),
			}
			const title = task.task.trim().slice(0, 120)
			const summary =
				`${owner} owns: ${task.task.trim()}` + (due ? ` (due ${due})` : "")

			const existingPage = await getWikiPage(
				handle,
				slug,
				params.scope,
				params.scopeRef,
			)
			if (existingPage) {
				await updateWikiPage(handle, slug, params.scope, params.scopeRef, {
					title,
					summary,
					body: task.sourceQuote?.trim() ?? "",
					frontmatter,
					taskCard,
				} as never)
				result.updated++
			} else {
				await createWikiPage(handle, {
					kind: "procedure",
					title,
					slug,
					summary,
					body: task.sourceQuote?.trim() ?? "",
					frontmatter: frontmatter as { type: string },
					taskCard,
					// The edge back to the note. Nothing else in the engine creates
					// relationships, so without this the graph has no edges at all.
					relationships: [
						{
							targetPageSlug: params.sourceSlug,
							targetTitle: params.sourceTitle,
							kind: "derived_from",
							weight: 1,
							confidence: 0.9,
						},
					],
					scope: params.scope as never,
					scopeRef: params.scopeRef,
					trustTier: (params.trustTier ?? "standard") as never,
				})
				result.created++
			}
			result.slugs.push(slug)
		} catch (err) {
			result.errors.push(
				`task "${task.task.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	const fresh = new Set(result.slugs)
	for (const page of prior) {
		if (fresh.has(page.slug)) continue
		const status = page.taskCard?.status
		if (status && status !== "open") {
			// Someone closed or annotated this by hand; re-extraction does not
			// get to overwrite that.
			result.kept++
			continue
		}
		try {
			await updateWikiPage(handle, page.slug, params.scope, params.scopeRef, {
				taskCard: { ...(page.taskCard ?? {}), status: "dropped" },
			} as never)
			result.dropped++
		} catch (err) {
			result.errors.push(
				`drop ${page.slug}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Graph links
//
// Task -> source edges alone produce a set of disconnected stars: one note
// with its tasks hanging off it, and nothing joining one note to the next.
// Two more edge kinds turn that into a graph you can actually traverse:
//
//   task   --owned_by-->  person entity   "what does Dana owe me across notes"
//   source --relates_to-> topic concept   joins notes that share a subject
//
// Both target pages are created on demand as minimal stubs and accumulate
// backlinks, which is what makes them useful: the person page is worth
// nothing on its own and everything as a hub.
// ---------------------------------------------------------------------------

/** Light stemming so "topic" and "topics", "grocery" and "groceries" collapse
 *  to the same token. Crude on purpose — a real stemmer is a dependency, and
 *  the semantic pass below catches what this misses. */
function stem(word: string): string {
	if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`
	if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2)
	if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1)
	return word
}

function topicTokens(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
			.filter((w) => !STOP_WORDS.has(w))
			.map(stem),
	)
}

/** Lexical closeness of two topic labels, order-insensitive and stemmed. */
export function topicSimilarity(a: string, b: string): number {
	const left = topicTokens(a)
	const right = topicTokens(b)
	if (left.size === 0 || right.size === 0) return 0
	let shared = 0
	for (const w of left) if (right.has(w)) shared++
	return shared / (left.size + right.size - shared)
}

/** Lexical floor for treating two labels as the same topic. Catches
 *  "Q4 roadmap" / "roadmap Q4" and singular-plural drift. */
export const TOPIC_LEXICAL_THRESHOLD = 0.6
/** Cosine floor for the semantic pass, matching the value Dreamer uses for
 *  the same kind of decision. Catches "groceries" / "shopping list", which
 *  share no words at all and so score 0 lexically. */
export const TOPIC_SEMANTIC_THRESHOLD = 0.65

/** Picks the hub an incoming topic belongs to, or null to create a new one.
 *
 *  Without this every note mints its own hubs and near-synonyms proliferate:
 *  two notes produced topics/groceries and topics/shopping-list for one
 *  shopping list, and topics/boiler and topics/house-maintenance for one
 *  boiler. Hubs only earn their place by being shared, so a hub per phrasing
 *  is worse than no hub at all — it adds nodes without adding connections.
 *
 *  `alreadyResolved` covers hubs created earlier in the same run: Atlas Search
 *  is eventually consistent, so a hub written moments ago is not yet
 *  searchable and the semantic pass cannot see it. */
export async function resolveTopicHub(
	handle: WikiDbHandle,
	title: string,
	params: {
		scope: string
		scopeRef: string
		alreadyResolved?: Array<{ slug: string; title: string }>
		lexicalThreshold?: number
		semanticThreshold?: number
	},
): Promise<{ slug: string; matchedBy: "run" | "lexical" | "semantic" } | null> {
	const lexFloor = params.lexicalThreshold ?? TOPIC_LEXICAL_THRESHOLD
	const semFloor = params.semanticThreshold ?? TOPIC_SEMANTIC_THRESHOLD

	// 1. hubs this run already decided on
	let best: { slug: string; score: number } | null = null
	for (const candidate of params.alreadyResolved ?? []) {
		const score = topicSimilarity(title, candidate.title)
		if (score >= lexFloor && (!best || score > best.score)) {
			best = { slug: candidate.slug, score }
		}
	}
	if (best) return { slug: best.slug, matchedBy: "run" }

	// 2. existing hubs, lexically
	let skip = 0
	for (;;) {
		const { pages, total } = await listWikiPages(handle, {
			scope: params.scope,
			scopeRef: params.scopeRef,
			kind: "concept",
			limit: 100,
			skip,
		})
		for (const page of pages as unknown as Array<{
			slug: string
			title: string
		}>) {
			if (!page.slug.startsWith(TOPIC_PREFIX)) continue
			const score = topicSimilarity(title, page.title)
			if (score >= lexFloor && (!best || score > best.score)) {
				best = { slug: page.slug, score }
			}
		}
		skip += pages.length
		if (pages.length < 100 || skip >= total) break
	}
	if (best) return { slug: best.slug, matchedBy: "lexical" }

	// 3. existing hubs, semantically. "fast" is vector-only, so the score is a
	// cosine similarity and the floor means something; hybrid scores are
	// rank-fusion values orders of magnitude smaller and would never clear it.
	try {
		const found = await searchWikiPages(handle, {
			query: title,
			scope: params.scope,
			scopeRef: params.scopeRef,
			kind: "concept",
			maxResults: 3,
			minScore: semFloor,
			recipe: "fast",
		})
		for (const hit of found.results) {
			if (hit.page.slug.startsWith(TOPIC_PREFIX)) {
				return { slug: hit.page.slug, matchedBy: "semantic" }
			}
		}
	} catch (err) {
		// No mongot, or the index is still building: fall through and create.
		// Degrading to a duplicate hub is better than failing the ingestion.
		if (!(err instanceof WikiSearchUnavailableError)) throw err
	}
	return null
}

export interface GraphLinkResult {
	peopleCreated: number
	topicsCreated: number
	/** Topics that matched an existing hub instead of minting a new one. */
	topicsReused: number
	edgesAdded: number
	errors: string[]
}

/** Links a freshly ingested source and its tasks into the wider graph. */
export async function linkIngestedGraph(
	handle: WikiDbHandle,
	params: {
		sourceSlug: string
		sourceTitle: string
		taskSlugs: string[]
		tasks: ExtractedTask[]
		topics?: string[]
		scope: string
		scopeRef: string
		trustTier?: string
	},
): Promise<GraphLinkResult> {
	const out: GraphLinkResult = {
		peopleCreated: 0,
		topicsCreated: 0,
		topicsReused: 0,
		edgesAdded: 0,
		errors: [],
	}

	// topics: source --relates_to--> concept
	const topicRels: WikiRelationshipSpec[] = []
	// Hubs decided during this run, so two near-synonym topics from the same
	// note collapse even though neither is searchable yet.
	const resolvedThisRun: Array<{ slug: string; title: string }> = []
	for (const topic of (params.topics ?? []).slice(0, 6)) {
		const title = topic.trim()
		if (!title) continue
		try {
			const match = await resolveTopicHub(handle, title, {
				scope: params.scope,
				scopeRef: params.scopeRef,
				alreadyResolved: resolvedThisRun,
			})
			let slug: string
			let hubTitle = title
			if (match) {
				slug = match.slug
				const existing = (await getWikiPage(
					handle,
					slug,
					params.scope,
					params.scopeRef,
				)) as { title?: string } | null
				// Link under the hub's own label, not this note's phrasing of it.
				hubTitle = existing?.title ?? title
				out.topicsReused++
			} else {
				slug = `topics/${slugify(title, 48)}`
				await ensureHubPage(handle, {
					slug,
					title,
					kind: "concept",
					summary: `Topic hub for ${title}. Sources referencing it link here.`,
					scope: params.scope,
					scopeRef: params.scopeRef,
					trustTier: params.trustTier,
				})
				out.topicsCreated++
			}
			resolvedThisRun.push({ slug, title: hubTitle })
			if (topicRels.some((r) => r.targetPageSlug === slug)) continue
			topicRels.push({
				targetPageSlug: slug,
				targetTitle: hubTitle,
				kind: "relates_to",
				weight: 0.5,
				confidence: 0.6,
			})
		} catch (err) {
			out.errors.push(
				`topic ${title}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	try {
		out.edgesAdded += await addRelationships(
			handle,
			params.sourceSlug,
			params.scope,
			params.scopeRef,
			topicRels,
		)
	} catch (err) {
		out.errors.push(
			`link source topics: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	// owners: task --owned_by--> person hub. "me" is the note's author and
	// gets no hub page — a self-link adds an edge without adding
	// information. "Lauren / Steffan" is two owners. The resolver joins
	// spellings ("Taylor M", "taylor.morgan@…") and, when a first name fits
	// several people, links the first-name hub and asks (people.ts).
	const context = await linkedPeople(
		handle,
		params.sourceSlug,
		params.scope,
		params.scopeRef,
	)
	for (let i = 0; i < params.tasks.length && i < params.taskSlugs.length; i++) {
		const owner = (params.tasks[i].owner ?? "").trim()
		if (
			!owner ||
			owner.toLowerCase() === "me" ||
			owner.toLowerCase() === "unassigned"
		) {
			continue
		}
		for (const name of splitRefs(owner)) {
			try {
				const hub = await resolvePersonHub(
					handle,
					{ name },
					{
						scope: params.scope,
						scopeRef: params.scopeRef,
						trustTier: params.trustTier,
						allowCreate: true,
						context,
						from: {
							slug: params.taskSlugs[i],
							title: params.tasks[i].task,
							edgeKind: "owned_by",
						},
					},
				)
				if (!hub) continue
				if (hub.created) out.peopleCreated++
				out.edgesAdded += await addRelationships(
					handle,
					params.taskSlugs[i],
					params.scope,
					params.scopeRef,
					[
						{
							targetPageSlug: hub.slug,
							targetTitle: hub.title,
							kind: "owned_by",
							weight: 1,
							confidence: hub.ambiguous ? 0.5 : 0.9,
						},
					],
				)
			} catch (err) {
				out.errors.push(
					`owner ${name}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
	}
	return out
}

/** People hubs the source page already links to (meeting attendees, mail
 *  participants): context for resolving a first name. */
async function linkedPeople(
	handle: WikiDbHandle,
	slug: string,
	scope: string,
	scopeRef: string,
): Promise<string[]> {
	try {
		const page = await getWikiPage(handle, slug, scope, scopeRef)
		return ((page?.relationships ?? []) as Array<{ targetPageSlug: string }>)
			.map((r) => r.targetPageSlug)
			.filter((t) => t.startsWith("people/"))
	} catch {
		return []
	}
}
