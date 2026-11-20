// Shared setup for the connector tests: a fake API writer that records
// what would have been written, and a config pointing at the fake server.

import { strToU8 } from "fflate"
import { vi } from "vitest"
import type { AiClient } from "@sqrrl/extract"
import { loadConfigFromEnv, type NextcloudConnectorConfig } from "../config.js"
import type { RawItemWrite, WikiWriter } from "../connector.js"
import { BASE, type FakeNextcloud, USER } from "./fake-nextcloud.js"

export interface Writes {
	raw: Array<RawItemWrite & { scope: string; scopeRef: string }>
	maintenance: Array<{ path: string; content: string; noteDate?: string }>
	frontmatter: Array<{ slug: string; frontmatter: Record<string, unknown> }>
}

export function fakeWriter(
	writes: Writes,
	opts: { maintenanceErrors?: string[] } = {},
): WikiWriter {
	return {
		rawWrite: vi.fn(async (input) => {
			for (const item of input.items) {
				writes.raw.push({
					...item,
					scope: input.scope,
					scopeRef: input.scopeRef,
				})
			}
		}),
		wikiMaintenance: vi.fn(async (input) => {
			for (const s of input.changedSources) {
				writes.maintenance.push({ ...s, noteDate: input.noteDate })
			}
			return {
				errors: opts.maintenanceErrors ?? [],
				pagesCreated: 1,
				pagesUpdated: 0,
			}
		}),
		wikiMergeFrontmatter: vi.fn(async (input) => {
			writes.frontmatter.push({
				slug: input.slug,
				frontmatter: input.frontmatter,
			})
		}),
	}
}

export function config(
	overrides: Partial<NextcloudConnectorConfig> = {},
): NextcloudConnectorConfig {
	return {
		...loadConfigFromEnv({
			NEXTCLOUD_URL: BASE,
			NEXTCLOUD_USER: USER,
			NEXTCLOUD_APP_PASSWORD: "p",
			NEXTCLOUD_FOLDERS: "Company",
			NEXTCLOUD_TAGS: "meetings",
			NEXTCLOUD_NOTES_CATEGORIES: "Work",
		}),
		...overrides,
	}
}

export function fakeAi(): AiClient {
	return {
		caption: vi.fn(async () => "A whiteboard.\nText in image: Q3 goals"),
		transcribe: vi.fn(async () => "Alice: we ship Friday."),
	}
}

/** One policy doc in a synced folder, one tagged recording, two notes (one
 *  in a selected category). */
export function seed(nc: FakeNextcloud): void {
	nc.addFile("Company/Policy.md", {
		fileId: "11",
		etag: "p1",
		bytes: strToU8("Remote work is allowed."),
		mimeType: "text/markdown",
	})
	nc.addFile("Recordings/standup.mp3", {
		fileId: "12",
		etag: "s1",
		bytes: new Uint8Array([1, 2, 3]),
		mimeType: "audio/mpeg",
		tags: ["meetings"],
	})
	nc.notes = [
		{
			id: 5,
			etag: "n1",
			title: "1:1 with Bob",
			category: "Work/1:1s",
			content: "Bob wants a raise.",
			modified: 1_789_000_000,
		},
		{
			id: 6,
			etag: "n2",
			title: "Groceries",
			category: "Personal",
			content: "milk",
			modified: 1_789_000_000,
		},
	]
}
