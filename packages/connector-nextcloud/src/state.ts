// Sync state persisted between runs: what has been ingested, at which etag,
// under which page slugs. A JSON file, like ingest.py's hashes.json — one
// runner owns it, so there is no concurrency to arbitrate.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface ItemState {
	kind: "file" | "note"
	/** Source path sent to maintenance for part 1; later parts append /part-NN. */
	basePath: string
	etag: string
	extractorVersion: number
	/** How many part pages the last successful sync wrote. */
	parts: number
	title: string
	/** File path, or note category — kept because pruned notes arrive with
	 *  neither, and selection must still be decidable for them. */
	location: string
	/** True once the item vanished from Nextcloud (or from the selection) and
	 *  its pages were marked deprecated. */
	stale: boolean
	lastSyncedAt?: string
	/** SHA-256 of the bytes last synced (of the text, for notes). Phase 2
	 *  uses it to find byte-identical images without downloading them. */
	sha256?: string
	/** A model the item still needs (no vision or transcription model was
	 *  configured). It is re-synced once that model is set, rather than being
	 *  downloaded again every pass. */
	pending?: "vision" | "transcription"
	/** Set when the last attempt failed; retryable failures are re-attempted
	 *  even though the etag has not moved. */
	lastError?: { message: string; retryable: boolean; at: string }
}

export interface SyncState {
	version: 1
	items: Record<string, ItemState>
	/** Unix seconds at the start of the last complete notes listing. */
	notesListedAt?: number
	/** Selection + extractor fingerprint the notes cursor is valid for. A
	 *  changed category list must re-list everything: pruned notes carry no
	 *  category, so newly selected unchanged notes would never be seen. */
	notesSignature?: string
}

export function emptyState(): SyncState {
	return { version: 1, items: {} }
}

export async function loadState(file: string): Promise<SyncState> {
	let raw: string
	try {
		raw = await readFile(file, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState()
		throw err
	}
	const parsed = JSON.parse(raw) as SyncState
	if (parsed.version !== 1 || typeof parsed.items !== "object") {
		throw new Error(`${file} is not a version 1 sync state file`)
	}
	return parsed
}

/** Write-then-rename, so a crash mid-write never leaves a truncated file
 *  that would make the next run believe nothing was ever synced. */
export async function saveState(file: string, state: SyncState): Promise<void> {
	await mkdir(dirname(file), { recursive: true })
	const tmp = `${file}.tmp-${process.pid}`
	await writeFile(tmp, `${JSON.stringify(state, null, 1)}\n`, "utf-8")
	await rename(tmp, file)
}
