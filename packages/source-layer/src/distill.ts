// Distilling changed sources into the wiki.
//
// One pass per batch of changed sources: runGitDiffMaintenance writes each
// source page (title, summary, claims), then, if asked, the task extractor
// reads each source and syncTasksForSource / linkIngestedGraph reconcile its
// tasks and join it to person and topic hubs.
//
// Moved verbatim from the POST /v1/wiki/maintenance route, which now only
// validates and maps errors. The route was the one place this ran, and it had
// no tests; a function can have them.

import {
	type ChangedSource,
	getWikiPage,
	type LlmGenerateFn,
	type MaintenanceResult,
	runGitDiffMaintenance,
	sourceToSlug,
	type WikiDbHandle,
} from "@sqrrl/wiki-engine"
import { mergeRedactions, redactionCount, redactSecrets } from "./redact.js"
import { enqueueSourceReview } from "./task-review/store.js"
import {
	linkIngestedGraph,
	listTopicLabels,
	syncTasksForSource,
	type TaskExtractFn,
} from "./tasks.js"

export interface DistillOptions {
	scope: string
	scopeRef: string
	trustTier?: string
	agentId?: string
	/** Second LLM call per source; opt-in because it doubles the cost. */
	extractTasks?: boolean
	/** ISO date the source was written, for resolving relative due dates.
	 *  Defaults to today. */
	noteDate?: string
	/** Overlap the extraction calls (SQRRL_ENRICHMENT_PARALLEL_EXTRACTION). */
	parallelExtraction?: boolean
}

export interface DistillDeps {
	llmGenerate: LlmGenerateFn
	/** Called only when tasks are extracted, so a deployment without an
	 *  extractor configured can still distill pages. */
	createExtractor: () => TaskExtractFn
}

export interface DistillTasksSummary {
	created: number
	updated: number
	reopened: number
	dropped: number
	kept: number
	peopleCreated: number
	topicsCreated: number
	edgesAdded: number
}

export type DistillResult = MaintenanceResult & {
	tasks?: DistillTasksSummary
	/** Secrets replaced before any page was written or LLM called, by kind. */
	redacted?: Record<string, number>
}

export async function distillChangedSources(
	handle: WikiDbHandle,
	input: ChangedSource[],
	deps: DistillDeps,
	options: DistillOptions,
): Promise<DistillResult> {
	const { scope, scopeRef, trustTier, agentId, noteDate } = options
	// Before the page LLM, the task extractor and the wiki ever see the text.
	const redacted: Record<string, number> = {}
	const changed = input.map((source) => {
		const r = redactSecrets(source.content)
		mergeRedactions(redacted, r.found)
		return { ...source, content: r.text }
	})
	const withRedactions = <T extends DistillResult>(out: T): T =>
		redactionCount(redacted) > 0 ? { ...out, redacted } : out
	const result = await runGitDiffMaintenance(
		handle,
		changed,
		deps.llmGenerate,
		{
			scope,
			scopeRef,
			...(trustTier ? { trustTier } : {}),
			...(agentId ? { agentId } : {}),
		},
	)
	// Task extraction is opt-in: it is a second LLM call per source, and
	// callers who only want the page should not pay for it.
	// Every page written is new input that might close an open task; the
	// review itself runs later (task-review), never inside ingestion.
	await queueForTaskReview(handle, changed, result.errors, scope, scopeRef)
	if (!options.extractTasks || result.errors.length > 0) {
		return withRedactions(result)
	}
	const extractor = deps.createExtractor()
	const tasksSummary: DistillTasksSummary = {
		created: 0,
		updated: 0,
		reopened: 0,
		dropped: 0,
		kept: 0,
		peopleCreated: 0,
		topicsCreated: 0,
		edgesAdded: 0,
	}
	// Extraction can run ahead of the writes, but the writes cannot run
	// concurrently: syncTasksForSource and linkIngestedGraph resolve
	// person and topic hubs, and two sources resolving the same hub at
	// once would each miss the other's uncommitted page and create a
	// duplicate. So the LLM calls may overlap; everything after stays
	// serial and in input order.
	//
	// Overlapping them costs the in-batch vocabulary hint: a hub created
	// while processing an earlier source in the same batch is no longer
	// offered to the next source's prompt. resolveTopicHub still merges
	// them at write time, so this trades some dedup quality at the prompt
	// layer for throughput — hence opt-in.
	const sharedTopics = options.parallelExtraction
		? await listTopicLabels(handle, scope, scopeRef)
		: undefined
	const prefetched = options.parallelExtraction
		? await Promise.all(
				changed.map((source) =>
					extractor({
						sourcePath: source.path,
						noteDate: noteDate ?? new Date().toISOString().slice(0, 10),
						text: source.content,
						existingTopics: sharedTopics ?? [],
					}).then(
						(value) => ({ value, error: undefined }),
						// A rejection here must not take down the whole batch
						// before the other sources have been written.
						(error: unknown) => ({ value: undefined, error }),
					),
				),
			)
		: undefined
	for (const [index, source] of changed.entries()) {
		const sourceSlug = sourceToSlug(source.path)
		const sourcePage = await getWikiPage(handle, sourceSlug, scope, scopeRef)
		if (!sourcePage) continue
		let extracted: Awaited<ReturnType<TaskExtractFn>>
		if (prefetched) {
			const settled = prefetched[index]
			if (settled.error !== undefined) {
				result.errors.push(
					`${source.path}: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`,
				)
				continue
			}
			extracted = settled.value as Awaited<ReturnType<TaskExtractFn>>
		} else {
			// The vocabulary is read per source, so a hub created while
			// processing an earlier file in the same batch is offered to the
			// next one — which the search index would not yet reflect.
			const existingTopics = await listTopicLabels(handle, scope, scopeRef)
			extracted = await extractor({
				sourcePath: source.path,
				noteDate: noteDate ?? new Date().toISOString().slice(0, 10),
				text: source.content,
				existingTopics,
			})
		}
		const sourceTitle = (sourcePage as { title: string }).title
		const synced = await syncTasksForSource(handle, {
			sourceSlug,
			sourceTitle,
			tasks: extracted.tasks,
			topics: extracted.topics,
			noteDate,
			scope,
			scopeRef,
			trustTier,
		})
		const linked = await linkIngestedGraph(handle, {
			sourceSlug,
			sourceTitle,
			taskSlugs: synced.slugs,
			tasks: extracted.tasks,
			topics: extracted.topics,
			scope,
			scopeRef,
			trustTier,
		})
		tasksSummary.created += synced.created
		tasksSummary.updated += synced.updated
		tasksSummary.reopened += synced.reopened
		tasksSummary.dropped += synced.dropped
		tasksSummary.kept += synced.kept
		tasksSummary.peopleCreated += linked.peopleCreated
		tasksSummary.topicsCreated += linked.topicsCreated
		tasksSummary.edgesAdded += linked.edgesAdded
		result.errors.push(...synced.errors, ...linked.errors)
	}
	return withRedactions({ ...result, tasks: tasksSummary })
}

async function queueForTaskReview(
	handle: WikiDbHandle,
	changed: ChangedSource[],
	errors: string[],
	scope: string,
	scopeRef: string,
): Promise<void> {
	for (const source of changed) {
		if (errors.some((e) => e.startsWith(source.path))) continue
		try {
			await enqueueSourceReview(handle, {
				scope,
				scopeRef,
				sourceSlug: sourceToSlug(source.path),
			})
		} catch {
			// Best effort: a review queue problem must never fail ingestion.
		}
	}
}
