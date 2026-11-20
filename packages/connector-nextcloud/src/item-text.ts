// Gets the text for one discovered item: note content as-is; files
// downloaded (recordings streamed to disk) and run through extraction.

import { createHash } from "node:crypto"
import { join } from "node:path"
import type { AiClient } from "@sqrrl/extract"
import type { NextcloudConnectorConfig } from "./config.js"
import type { WorkItem } from "./discovery.js"
import {
	classify,
	EXTRACTOR_VERSION,
	type ExtractOptions,
	type ExtractResult,
	extract,
	type WaitingFor,
} from "@sqrrl/extract"
import { transcribeRecording } from "@sqrrl/extract"
import { withTempDir } from "@sqrrl/extract"
import type { NextcloudWebDav } from "./webdav.js"

export type ItemText =
	| {
			ok: true
			text: string
			extractor: string
			notes: string[]
			/** Hash of the source bytes, recorded in sync state (sha256). */
			contentHash: string
			waitingFor?: WaitingFor
	  }
	| {
			ok: false
			reason: string
			retryable: boolean
			/** Unsupported or oversized: record it and leave it alone. */
			skip: boolean
			waitingFor?: WaitingFor
	  }

export interface ItemTextDeps {
	webdav: NextcloudWebDav
	ai: AiClient
	config: NextcloudConnectorConfig
	extractOptions: ExtractOptions
}

function sha(s: string | Uint8Array): string {
	return createHash("sha256").update(s).digest("hex")
}

function fromResult(result: ExtractResult, contentHash: string): ItemText {
	if (!result.ok) {
		return {
			ok: false,
			reason: result.reason,
			retryable: result.retryable,
			skip: result.kind === "unsupported",
			...(result.waitingFor ? { waitingFor: result.waitingFor } : {}),
		}
	}
	return {
		ok: true,
		text: result.text,
		extractor: result.extractor,
		notes: result.notes,
		contentHash,
		...(result.waitingFor ? { waitingFor: result.waitingFor } : {}),
	}
}

export async function textForItem(
	item: WorkItem,
	deps: ItemTextDeps,
): Promise<ItemText> {
	if (item.note) {
		const text = (item.note.content ?? "").trim()
		if (!text) {
			return {
				ok: false,
				reason: "note is empty",
				retryable: false,
				skip: true,
			}
		}
		return {
			ok: true,
			text,
			extractor: `notes-api@${EXTRACTOR_VERSION}`,
			notes: [],
			contentHash: sha(text),
		}
	}
	const file = item.file
	if (!file) throw new Error(`${item.key} has neither a file nor a note`)
	const { config } = deps
	const kind = classify(file.mimeType, file.name)

	if (kind === "audio" || kind === "video") {
		if (file.size > config.maxMediaBytes) {
			return {
				ok: false,
				reason: `${file.size} bytes exceeds NEXTCLOUD_MAX_MEDIA_BYTES (${config.maxMediaBytes})`,
				retryable: false,
				skip: true,
			}
		}
		return withTempDir(async (dir) => {
			const path = join(dir, "recording")
			const { bytes, sha256 } = await deps.webdav.downloadToFile(
				file,
				path,
				config.maxMediaBytes,
			)
			const result = await transcribeRecording(
				path,
				bytes,
				file.mimeType,
				file.name,
				kind,
				deps.ai,
				{
					ffmpeg: deps.extractOptions.tools.ffmpeg,
					segmentSeconds: deps.extractOptions.audioSegmentSeconds,
					maxRawUploadBytes: deps.extractOptions.maxRawUploadBytes,
					timeoutMs: deps.extractOptions.mediaTimeoutMs,
					extractorTag: `transcription@${EXTRACTOR_VERSION}`,
				},
			)
			return fromResult(result, sha256)
		})
	}

	if (file.size > config.maxFileBytes) {
		return {
			ok: false,
			reason: `${file.size} bytes exceeds NEXTCLOUD_MAX_FILE_BYTES (${config.maxFileBytes})`,
			retryable: false,
			skip: true,
		}
	}
	const bytes = await deps.webdav.download(file, config.maxFileBytes)
	const contentHash = sha(bytes)
	const result = await extract(
		bytes,
		file.mimeType,
		file.name,
		deps.ai,
		deps.extractOptions,
	)
	return fromResult(result, contentHash)
}
