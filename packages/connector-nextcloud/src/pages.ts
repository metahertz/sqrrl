// How Nextcloud items map onto wiki pages: source paths, slugs, part
// splitting and the header each page's text starts with.

import type { WorkItem } from "./discovery.js"

/** Must match sourceToSlug in @sqrrl/wiki-engine's wiki-maintenance.ts:
 *  maintenance derives the page slug from the path we send, and stale
 *  marking and provenance writes have to address the same page. Duplicated
 *  rather than imported so the runner does not load the engine (and its
 *  MongoDB driver) at runtime; a test pins the two together. */
export function slugForSourcePath(sourcePath: string): string {
	const clean = sourcePath
		.toLowerCase()
		.replace(/[^a-z0-9/.]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return `sources/${clean}`
}

export function partPath(basePath: string, index: number): string {
	// Part 1 keeps the base path so a document that grows past the split
	// threshold does not move its main page.
	return index === 0
		? basePath
		: `${basePath}/part-${String(index + 1).padStart(2, "0")}`
}

/** YYYY-MM-DD, falling back to today for an unparseable date. */
export function dayOf(d: Date): string {
	return Number.isNaN(d.getTime())
		? new Date().toISOString().slice(0, 10)
		: d.toISOString().slice(0, 10)
}

/** Opening lines of every page: what the item is and where it lives, so the
 *  wiki's LLM titles and summarizes it from context rather than guessing. */
export function pageHeader(
	item: WorkItem,
	part: number,
	parts: number,
	extractor: string,
	notes: string[],
): string {
	const where =
		item.kind === "note"
			? `Nextcloud note in category "${item.location || "(none)"}"`
			: `Nextcloud file "${item.location}"`
	const lines = [
		`# ${item.title}`,
		"",
		`Source: ${where}, last modified ${dayOf(item.lastModified)}.`,
	]
	if (parts > 1) lines.push(`Part ${part + 1} of ${parts}.`)
	if (extractor.startsWith("vision")) {
		lines.push("Content: machine description of an image.")
	}
	if (extractor.startsWith("transcription")) {
		lines.push("Content: machine transcript of a recording.")
	}
	for (const n of notes) lines.push(`Note: ${n}.`)
	return `${lines.join("\n")}\n\n`
}

/** Keeps request bodies well under the API's 2 MiB cap. */
export const MAX_BATCH_CHARS = 1_000_000

/** Groups page sources so no single maintenance request gets too large. */
export function batchSources<T extends { content: string }>(
	sources: T[],
	maxChars = MAX_BATCH_CHARS,
): T[][] {
	const batches: T[][] = []
	let batch: T[] = []
	let size = 0
	for (const s of sources) {
		if (batch.length > 0 && size + s.content.length > maxChars) {
			batches.push(batch)
			batch = []
			size = 0
		}
		batch.push(s)
		size += s.content.length
	}
	if (batch.length > 0) batches.push(batch)
	return batches
}
