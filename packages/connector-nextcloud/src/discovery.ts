// Finds everything the connector is configured to sync, and records enough
// about what was seen to decide deletions safely afterwards.

import type { NextcloudConnectorConfig } from "./config.js"
import { EXTRACTOR_VERSION } from "@sqrrl/extract"
import {
	categorySelected,
	type NextcloudNote,
	type NextcloudNotes,
} from "./notes.js"
import type { SyncState } from "./state.js"
import type { NextcloudFile, NextcloudWebDav } from "./webdav.js"

export interface WorkItem {
	/** "file:<fileid>" or "note:<id>" — the state key. */
	key: string
	kind: "file" | "note"
	/** Source path for part 1; keyed by id so renames keep their page. */
	basePath: string
	etag: string
	title: string
	/** File path, or note category. */
	location: string
	lastModified: Date
	/** Why the item was selected: "folder:X", "tag:Y", "category:Z". */
	origins: string[]
	file?: NextcloudFile
	note?: NextcloudNote
	/** Where a reader opens the original in Nextcloud. */
	sourceUrl: string
}

export interface Discovery {
	/** Every selected item, changed or not. */
	items: WorkItem[]
	seenFiles: Set<string>
	seenNotes: Set<string>
	/** False when any folder or tag lookup failed. Deletions are only
	 *  inferred from a complete listing: one unreachable folder must not
	 *  deprecate everything in it. */
	filesComplete: boolean
	notesComplete: boolean
	notesListedAt?: number
	notesSignature: string
	errors: string[]
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export async function discoverItems(
	config: NextcloudConnectorConfig,
	webdav: NextcloudWebDav,
	notesApi: NextcloudNotes,
	state: SyncState,
): Promise<Discovery> {
	const errors: string[] = []
	const files = new Map<string, WorkItem>()
	let filesComplete = config.folders.length > 0 || config.tags.length > 0

	const addFile = (f: NextcloudFile, origin: string) => {
		if (!f.fileId) {
			errors.push(`${f.path}: server returned no oc:fileid; skipped`)
			return
		}
		const key = `file:${f.fileId}`
		const existing = files.get(key)
		if (existing) {
			if (!existing.origins.includes(origin)) existing.origins.push(origin)
			return
		}
		files.set(key, {
			key,
			kind: "file",
			basePath: `nextcloud/files/${f.fileId}`,
			etag: f.etag,
			title: f.name,
			location: f.path,
			lastModified: new Date(f.lastModified),
			origins: [origin],
			file: f,
			sourceUrl: webdav.fileUrl(f),
		})
	}

	for (const folder of config.folders) {
		try {
			for (const f of await webdav.listFolder(folder)) {
				addFile(f, `folder:${folder}`)
			}
		} catch (err) {
			filesComplete = false
			errors.push(`folder "${folder}": ${message(err)}`)
		}
	}
	if (config.tags.length > 0) {
		try {
			const tagIds = await webdav.systemTags()
			for (const tag of config.tags) {
				const id = tagIds.get(tag.toLowerCase())
				if (!id) {
					// A missing tag is a config error, not an empty result: treating
					// it as "no files" would mark every file it used to select stale.
					filesComplete = false
					errors.push(`tag "${tag}" does not exist in Nextcloud`)
					continue
				}
				for (const f of await webdav.filesWithTag(id)) addFile(f, `tag:${tag}`)
			}
		} catch (err) {
			filesComplete = false
			errors.push(`tags: ${message(err)}`)
		}
	}

	const notes = new Map<string, WorkItem>()
	const seenNotes = new Set<string>()
	const signature = `${[...config.noteCategories].sort().join(",")}|v${EXTRACTOR_VERSION}`
	const listedAt = Math.floor(Date.now() / 1000)
	let notesComplete = config.noteCategories.length > 0
	if (notesComplete) {
		try {
			// A changed selection or extractor must re-list everything: pruned
			// notes carry no category, so newly selected unchanged notes would
			// otherwise never be seen.
			const canPrune =
				state.notesSignature === signature && state.notesListedAt !== undefined
			// Minus a minute: a note saved while the last listing was running
			// must not fall between two cursors.
			const prune = canPrune ? (state.notesListedAt as number) - 60 : undefined
			for (const n of await notesApi.list(prune)) {
				const key = `note:${n.id}`
				if (n.content === undefined) {
					// Pruned: unchanged since the last listing, so its category is
					// the one recorded. Still present, so not a deletion.
					if (state.items[key] && !state.items[key].stale) seenNotes.add(key)
					continue
				}
				if (!categorySelected(n.category, config.noteCategories)) continue
				seenNotes.add(key)
				notes.set(key, {
					key,
					kind: "note",
					basePath: `nextcloud/notes/${n.id}`,
					etag: n.etag,
					title: n.title || `Note ${n.id}`,
					location: n.category,
					lastModified: new Date(n.modified * 1000),
					origins: [n.category ? `category:${n.category}` : "category:(none)"],
					note: n,
					sourceUrl: `${config.baseUrl}/apps/notes/note/${n.id}`,
				})
			}
		} catch (err) {
			notesComplete = false
			errors.push(`notes: ${message(err)}`)
		}
	}

	return {
		items: [...files.values(), ...notes.values()],
		seenFiles: new Set(files.keys()),
		seenNotes,
		filesComplete,
		notesComplete,
		...(notesComplete ? { notesListedAt: listedAt } : {}),
		notesSignature: signature,
		errors,
	}
}

/** Models this run can use. */
export interface Capabilities {
	vision: boolean
	transcription: boolean
}

/** Whether an item has to be (re)ingested this run. */
export function needsSync(
	state: SyncState,
	item: WorkItem,
	caps: Capabilities = { vision: false, transcription: false },
): boolean {
	const prior = state.items[item.key]
	if (!prior) return true
	if (prior.stale) return true
	if (prior.etag !== item.etag) return true
	if (prior.extractorVersion !== EXTRACTOR_VERSION) return true
	if (prior.lastError?.retryable) return true
	if (prior.pending && caps[prior.pending]) return true
	return false
}
