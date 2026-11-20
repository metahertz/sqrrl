// What the connector remembers between runs: per conversation, when it last
// spoke and when it was last checked. A JSON file owned by one runner, as
// for the Nextcloud connector. Message content is never kept here; Layer 1
// holds that.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface ConversationState {
	name: string
	/** ts of the newest message seen, Slack's own format. */
	lastActivityTs?: string
	/** ISO time of the last run that read this conversation. */
	lastCheckedAt?: string
	/** ISO time of the first successful sync, after which only refreshDays
	 *  are re-read rather than the full backfill. */
	firstSyncedAt?: string
}

export interface SlackState {
	version: 1
	conversations: Record<string, ConversationState>
}

export function emptyState(): SlackState {
	return { version: 1, conversations: {} }
}

export async function loadState(file: string): Promise<SlackState> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as SlackState
		return parsed.version === 1 && parsed.conversations ? parsed : emptyState()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState()
		throw err
	}
}

/** Written to a temp file and renamed, so a crash never leaves half a file. */
export async function saveState(
	file: string,
	state: SlackState,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true })
	const tmp = `${file}.tmp`
	await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
	await rename(tmp, file)
}
