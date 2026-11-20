#!/usr/bin/osascript -l JavaScript
//
// Export Apple Notes to markdown files for sqrrl ingestion.
//
// Run with:  osascript -l JavaScript sqrrl-notes-export.js [--all] [--dry-run]
//
// Why AppleScript/JXA and not the SQLite store: Notes keeps note bodies as
// gzipped protobuf inside ZICNOTEDATA in NoteStore.sqlite. That format is
// undocumented, changes between macOS releases, and reading it needs Full Disk
// Access. The scripting interface is the supported surface and survives
// upgrades.
//
// Filenames are a hash of the note's stable Core Data id, NOT its title.
// sqrrl derives a wiki page slug from the file path, so a title-based
// filename would fork a brand new page every time you renamed a note and
// orphan the old one. The human title lives inside the file instead, where
// the ingestion LLM reads it anyway.
//
ObjC.import("Foundation")

const HOME = $.NSHomeDirectory().js
const OUT_DIR =
	$.NSProcessInfo.processInfo.environment.objectForKey("SQRRL_NOTES_DIR").js ||
	`${HOME}/mdbrain-notes`
const STATE = `${OUT_DIR}/.last-run`
// Which wiki scope the notes land in. Override to keep, say, work and
// personal notes in separate scopes.
const SCOPE =
	$.NSProcessInfo.processInfo.environment.objectForKey("SQRRL_SCOPE").js ||
	"workspace"
const SCOPE_REF =
	$.NSProcessInfo.processInfo.environment.objectForKey("SQRRL_SCOPE_REF").js ||
	"default"

const args = $.NSProcessInfo.processInfo.arguments.js.map((a) => a.js)
const ALL = args.indexOf("--all") !== -1
const DRY = args.indexOf("--dry-run") !== -1

function readText(path) {
	const s = $.NSString.stringWithContentsOfFileEncodingError(
		path,
		$.NSUTF8StringEncoding,
		null,
	)
	return s && !s.isNil() ? s.js : null
}

function writeText(path, text) {
	const s = $.NSString.alloc.initWithUTF8String(text)
	return s.writeToFileAtomicallyEncodingError(
		path,
		true,
		$.NSUTF8StringEncoding,
		null,
	)
}

function ensureDir(path) {
	$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
		path,
		true,
		$.null,
		$.null,
	)
}

// FNV-1a over the note id — short, stable, no crypto dependency.
function shortHash(str) {
	let h = 0x811c9dc5
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i)
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
	}
	return ("0000000" + h.toString(16)).slice(-8)
}

function iso(d) {
	return d ? new Date(d).toISOString() : ""
}

function yamlEscape(s) {
	// Strip every C0 control character, not just newlines. A note's title is its
	// first line, and text synced or pasted from elsewhere frequently carries a
	// carriage return — which corrupts the YAML scalar here and, when echoed by
	// a terminal later, returns the cursor to column 0 and overwrites the line.
	return (
		String(s == null ? "" : s)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/"/g, '\\"')
			.replace(/\s+/g, " ")
			.trim()
	)
}

ensureDir(OUT_DIR)

const since = ALL ? null : readText(STATE)
const sinceDate = since ? new Date(since.trim()) : null
const startedAt = new Date()

const Notes = Application("Notes")
Notes.includeStandardAdditions = true

// Filter in the app rather than pulling every note across the bridge: a large
// library is slow to enumerate one property at a time.
let notes
try {
	notes = sinceDate
		? Notes.notes.whose({ modificationDate: { _greaterThan: sinceDate } })()
		: Notes.notes()
} catch (e) {
	console.log(`error: could not read Notes: ${e}`)
	console.log(
		"If this is the first run, grant automation access when macOS asks,",
	)
	console.log("or in System Settings > Privacy & Security > Automation.")
	$.exit(1)
}

let written = 0
let skipped = 0
const seen = []

for (const note of notes) {
	let id, title, modified, created, folder, text
	try {
		id = note.id()
		title = note.name()
		modified = note.modificationDate()
		created = note.creationDate()
		try {
			folder = note.container.name()
		} catch (e) {
			folder = "Notes"
		}
		// plaintext avoids having to convert Notes' HTML body. Fall back to the
		// HTML body with tags stripped if this macOS version lacks it.
		try {
			text = note.plaintext()
		} catch (e) {
			text = String(note.body() || "")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
				.replace(/<[^>]+>/g, "")
		}
	} catch (e) {
		skipped++
		continue
	}
	if (note.passwordProtected && note.passwordProtected()) {
		skipped++
		continue
	}

	const slug = shortHash(String(id))
	seen.push(slug)
	const path = `${OUT_DIR}/${slug}.md`
	const body = [
		"---",
		`title: "${yamlEscape(title)}"`,
		`source: apple-notes`,
		`folder: "${yamlEscape(folder)}"`,
		`note_id: "${yamlEscape(id)}"`,
		`created: ${iso(created)}`,
		`modified: ${iso(modified)}`,
		"---",
		"",
		`# ${title}`,
		"",
		String(text || "").trim(),
		"",
	].join("\n")

	if (DRY) {
		console.log(`would export ${slug}  <-  ${folder} / ${title}`)
		written++
		continue
	}
	if (!writeText(path, body)) {
		skipped++
		continue
	}

	// The exact request body for POST /v1/wiki/maintenance. Emitting it here
	// means the sync script can curl it directly rather than parsing markdown
	// frontmatter in shell.
	const noteDate = iso(modified).slice(0, 10)
	const payload = {
		source: "git-diff",
		scope: SCOPE,
		scopeRef: SCOPE_REF,
		trustTier: "standard",
		extractTasks: true,
		noteDate: noteDate,
		changedSources: [{ path: `apple-notes/${slug}.md`, content: body }],
		// Layer 1 copy for POST /v1/raw/items: the note's own words, keyed by
		// the same stable hash, so a rename is a new version, not a new item.
		// The sync script sends it first; the maintenance route ignores it.
		raw: {
			source: "apple-notes",
			sourceId: slug,
			kind: "note",
			title: String(title),
			text: String(text || "").trim(),
			unit: slug,
			occurredAt: iso(modified),
			metadata: { folder: String(folder), created: iso(created) },
		},
	}
	writeText(`${OUT_DIR}/${slug}.json`, JSON.stringify(payload))
	written++
}

if (!DRY) {
	writeText(STATE, startedAt.toISOString())
	writeText(`${OUT_DIR}/.manifest`, seen.join("\n"))
}
console.log(
	`${DRY ? "[dry-run] " : ""}exported ${written} note(s), skipped ${skipped}` +
		(sinceDate
			? `, changed since ${sinceDate.toISOString()}`
			: ", full export"),
)
