// Nextcloud → sqrrl wiki connector.
//
// The first connector that does real work. Implements the wiki-engine
// SourceConnector contract, but writes through the sqrrl HTTP API rather
// than straight into wiki_pages, so Nextcloud content takes the same path as
// every other ingest: git-diff maintenance (title, summary, claims, tasks,
// graph edges) plus a /v1/add event for conversational recall, under the
// API's own auth, governance and rate limits.

import type {
	ConnectorAuthenticateResult,
	ConnectorDiscoverResult,
	ConnectorIngestResult,
	ConnectorMapPermissionsResult,
	DiscoveredSource,
	IngestOpts,
	SourceConnector,
} from "@sqrrl/wiki-engine"
import type { AiClient } from "@sqrrl/extract"
import type { NextcloudConnectorConfig } from "./config.js"
import {
	type Capabilities,
	type Discovery,
	discoverItems,
	needsSync,
	type WorkItem,
} from "./discovery.js"
import {
	DEFAULT_EXTRACT_OPTIONS,
	EXTRACTOR_VERSION,
	type ExtractOptions,
	splitText,
} from "@sqrrl/extract"
import { textForItem } from "./item-text.js"
import { NextcloudNotes } from "./notes.js"
import {
	batchSources,
	dayOf,
	pageHeader,
	partPath,
	slugForSourcePath,
} from "./pages.js"
import { type ItemState, type SyncState, saveState } from "./state.js"
import { NextcloudWebDav } from "./webdav.js"

export { partPath, slugForSourcePath } from "./pages.js"

/** One raw item as the connector writes it (see @sqrrl/source-layer). */
export interface RawItemWrite {
	source: string
	sourceId: string
	kind: "note" | "file"
	text: string
	title?: string
	unit?: string
	occurredAt?: string
	invalidAt?: string
	attachments?: Array<{ name: string; ref: string; contentType?: string }>
	metadata?: Record<string, unknown>
}

/** The slice of SqrrlClient the connector uses — narrow so tests can fake it. */
export interface WikiWriter {
	rawWrite(input: {
		scope: string
		scopeRef: string
		items: RawItemWrite[]
	}): Promise<unknown>
	wikiMaintenance(
		input: {
			scope: string
			scopeRef: string
			changedSources: Array<{ path: string; content: string }>
			trustTier?: string
			extractTasks?: boolean
			noteDate?: string
		},
		requestOptions?: { timeoutMs?: number },
	): Promise<{ errors: string[]; pagesCreated: number; pagesUpdated: number }>
	wikiMergeFrontmatter(input: {
		slug: string
		scope: string
		scopeRef: string
		frontmatter: Record<string, unknown>
	}): Promise<unknown>
}

export interface SyncReport {
	discovered: number
	changed: number
	synced: number
	skipped: Array<{ key: string; title: string; reason: string }>
	failed: Array<{
		key: string
		title: string
		reason: string
		retryable: boolean
	}>
	/** Parked until a model is configured; not retried until then. */
	waiting: Array<{ key: string; title: string; reason: string }>
	markedStale: number
	restored: number
	/** Discovery problems. A non-empty list means stale marking was withheld
	 *  for the affected source. */
	discoveryErrors: string[]
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export interface ConnectorOptions {
	fetchFn?: typeof globalThis.fetch
	/** Saves state; defaults to writing config.stateFile. */
	persist?: (s: SyncState) => Promise<void>
	/** Local tools available on this host — see probeTools(). */
	tools?: ExtractOptions["tools"]
}

export class NextcloudConnector implements SourceConnector {
	name = "nextcloud"
	readonly webdav: NextcloudWebDav
	readonly notes: NextcloudNotes
	private discovery: Discovery | null = null
	private readonly persist: (s: SyncState) => Promise<void>
	private readonly extractOptions: ExtractOptions
	private readonly caps: Capabilities

	constructor(
		private readonly config: NextcloudConnectorConfig,
		private readonly writer: WikiWriter,
		private readonly ai: AiClient,
		private readonly state: SyncState,
		options: ConnectorOptions = {},
	) {
		const { baseUrl, user, appPassword } = config
		const fetchFn = options.fetchFn ?? globalThis.fetch
		this.webdav = new NextcloudWebDav(baseUrl, user, appPassword, fetchFn)
		this.notes = new NextcloudNotes(baseUrl, user, appPassword, fetchFn)
		this.persist = options.persist ?? ((s) => saveState(config.stateFile, s))
		this.extractOptions = {
			...DEFAULT_EXTRACT_OPTIONS,
			tools: options.tools ?? DEFAULT_EXTRACT_OPTIONS.tools,
			maxScannedPages: config.maxScannedPages,
			pdfRenderScale: config.pdfRenderScale,
			maxImageEdge: config.maxImageEdge,
			verifyImages: config.verifyImages,
			audioSegmentSeconds: config.audioSegmentSeconds,
			maxRawUploadBytes: config.maxRawUploadBytes,
			mediaTimeoutMs: config.aiTimeoutMs,
		}
		const aiReady = Boolean(config.aiBaseUrl)
		this.caps = {
			vision: aiReady && Boolean(config.visionModel),
			transcription:
				Boolean(config.transcriptionBaseUrl) &&
				Boolean(config.transcriptionModel),
		}
	}

	async authenticate(): Promise<ConnectorAuthenticateResult> {
		try {
			await this.webdav.ping()
			return {
				authenticated: true,
				context: { baseUrl: this.config.baseUrl, user: this.config.user },
			}
		} catch (err) {
			return { authenticated: false, error: message(err) }
		}
	}

	mapPermissions(_source: DiscoveredSource): ConnectorMapPermissionsResult {
		// Nextcloud shares are per-user and do not map onto wiki readers; the
		// tier is an operator decision made per connector instance.
		return { privacyTier: this.config.privacyTier }
	}

	/** Lists everything selected and returns the items that need (re)syncing.
	 *  `cursor` is accepted for the SourceConnector contract; change detection
	 *  is per-item etag, which survives clock skew and partial runs. */
	async discover(_cursor?: string): Promise<ConnectorDiscoverResult> {
		this.discovery = await discoverItems(
			this.config,
			this.webdav,
			this.notes,
			this.state,
		)
		const changed = this.discovery.items.filter((i) =>
			needsSync(this.state, i, this.caps),
		)
		return {
			sources: changed.map((i) => ({
				id: i.key,
				path: i.basePath,
				// Extracted lazily in ingest(): downloads are the expensive part.
				content: "",
				metadata: { title: i.title, location: i.location, kind: i.kind },
			})),
			cursor: new Date().toISOString(),
		}
	}

	async ingest(
		sources: DiscoveredSource[],
		_opts?: IngestOpts,
	): Promise<ConnectorIngestResult> {
		const report = await this.sync(sources.map((s) => s.id))
		return {
			pagesProcessed:
				report.synced + report.failed.length + report.skipped.length,
			pagesCreated: 0,
			pagesUpdated: report.synced,
			errors: report.failed.map((f) => `${f.title}: ${f.reason}`),
		}
	}

	/** Discovers, ingests changed items, and marks vanished ones stale. */
	async run(): Promise<SyncReport> {
		await this.discover()
		return this.sync()
	}

	private async sync(onlyKeys?: string[]): Promise<SyncReport> {
		const d = this.discovery
		if (!d) throw new Error("discover() must run before ingest()")
		const changed = d.items.filter((i) => needsSync(this.state, i, this.caps))
		const report: SyncReport = {
			discovered: d.seenFiles.size + d.seenNotes.size,
			changed: changed.length,
			synced: 0,
			skipped: [],
			waiting: [],
			failed: [],
			markedStale: 0,
			restored: 0,
			discoveryErrors: [...d.errors],
		}
		const wanted = onlyKeys ? new Set(onlyKeys) : null

		for (const item of changed) {
			if (wanted && !wanted.has(item.key)) continue
			await this.syncItem(item, report)
			// Persist after every item so a crash mid-run keeps the progress.
			await this.persist(this.state)
		}

		// A partial ingest() call never infers deletions; only a full run does.
		if (!wanted) {
			await this.retireVanished(d, report)
			if (d.notesComplete) {
				this.state.notesListedAt = d.notesListedAt
				this.state.notesSignature = d.notesSignature
			}
			await this.persist(this.state)
		}
		return report
	}

	private async syncItem(item: WorkItem, report: SyncReport): Promise<void> {
		const cfg = this.config
		const prior = this.state.items[item.key]
		const now = new Date().toISOString()
		try {
			const got = await textForItem(item, {
				webdav: this.webdav,
				ai: this.ai,
				config: this.config,
				extractOptions: this.extractOptions,
			})
			if (!got.ok) {
				if (got.waitingFor) {
					report.waiting.push({
						key: item.key,
						title: item.title,
						reason: got.reason,
					})
					// Pinned at this etag and parked: picked up again when the
					// model is configured or the file changes, not every pass.
					this.recordOutcome(item, prior, {
						etag: item.etag,
						pending: got.waitingFor,
						lastError: { message: got.reason, retryable: false, at: now },
					})
				} else if (got.skip) {
					report.skipped.push({
						key: item.key,
						title: item.title,
						reason: got.reason,
					})
					// Recorded at this etag so an unsupported file is not
					// downloaded again every run; a new version is retried.
					this.recordOutcome(item, prior, {
						etag: item.etag,
						lastError: { message: got.reason, retryable: false, at: now },
					})
				} else {
					report.failed.push({
						key: item.key,
						title: item.title,
						reason: got.reason,
						retryable: got.retryable,
					})
					this.recordFailure(item, prior, got.reason, got.retryable, now)
				}
				return
			}

			const chunks = splitText(got.text, cfg.maxPartChars)
			// Layer 1 first: the exact extracted text, one raw item per part
			// (parts keep each write well under the API body limit). The
			// wiki pages below are distilled from the same text.
			for (const [i, text] of chunks.entries()) {
				await this.writer.rawWrite({
					scope: cfg.scope,
					scopeRef: cfg.scopeRef,
					items: [this.rawItem(item, i, chunks.length, text, got.extractor)],
				})
			}
			const sources = chunks.map((text, i) => ({
				path: partPath(item.basePath, i),
				content:
					pageHeader(item, i, chunks.length, got.extractor, got.notes) + text,
			}))
			for (const batch of batchSources(sources)) {
				const res = await this.writer.wikiMaintenance(
					{
						scope: cfg.scope,
						scopeRef: cfg.scopeRef,
						trustTier: cfg.trustTier,
						changedSources: batch,
						extractTasks: true,
						noteDate: dayOf(item.lastModified),
					},
					{ timeoutMs: cfg.wikiTimeoutMs },
				)
				if (res.errors.length > 0) {
					throw new Error(`wiki maintenance: ${res.errors.join("; ")}`)
				}
			}

			for (const [i, s] of sources.entries()) {
				await this.writer.wikiMergeFrontmatter({
					slug: slugForSourcePath(s.path),
					scope: cfg.scope,
					scopeRef: cfg.scopeRef,
					frontmatter: this.provenance(
						item,
						got.extractor,
						i,
						chunks.length,
						now,
					),
				})
			}

			// A document that shrank leaves part pages behind; retire them.
			for (let i = chunks.length; i < (prior?.parts ?? 0); i++) {
				await this.deprecate(partPath(item.basePath, i))
				await this.retireRaw(item.key, item.kind, i, now)
			}
			if (prior?.stale) report.restored++
			this.recordOutcome(item, prior, {
				etag: item.etag,
				parts: chunks.length,
				stale: false,
				lastSyncedAt: now,
				sha256: got.contentHash,
				...(got.waitingFor ? { pending: got.waitingFor } : {}),
			})
			report.synced++
		} catch (err) {
			// Download and API failures are environmental; the next run retries.
			const reason = message(err)
			report.failed.push({
				key: item.key,
				title: item.title,
				reason,
				retryable: true,
			})
			this.recordFailure(item, prior, reason, true, now)
		}
	}

	/** OKF provenance fields the wiki schema already defines, so phase 2 can
	 *  find each page's original file and how its text was produced. */
	private provenance(
		item: WorkItem,
		extractor: string,
		part: number,
		parts: number,
		now: string,
	): Record<string, unknown> {
		const tags = [
			"nextcloud",
			...item.origins
				.filter((o) => !o.startsWith("folder:"))
				.map((o) => o.replace(/^(tag|category):/, "")),
		]
		return {
			type: "source",
			title: item.title,
			status: "stable",
			privacyTier: this.config.privacyTier,
			tags: [...new Set(tags)].slice(0, 12),
			generated: { by: `sqrrl-connector-nextcloud/${extractor}`, at: now },
			sources: [
				{
					resource: item.sourceUrl,
					id: `${item.key}${parts > 1 ? `#part-${part + 1}` : ""}`,
					title: item.location || item.title,
					last_modified: Number.isNaN(item.lastModified.getTime())
						? now
						: item.lastModified.toISOString(),
				},
			],
		}
	}

	/** sourceId of one part's raw item. Always suffixed, so a document that
	 *  grows from one part to two keeps part 1's identity. */
	private rawSourceId(key: string, part: number): string {
		return `${key}#${part + 1}`
	}

	private rawItem(
		item: WorkItem,
		part: number,
		parts: number,
		text: string,
		extractor: string,
	): RawItemWrite {
		return {
			source: "nextcloud",
			sourceId: this.rawSourceId(item.key, part),
			kind: item.kind,
			text,
			title:
				parts > 1 ? `${item.title} (part ${part + 1}/${parts})` : item.title,
			unit: item.key,
			occurredAt: item.lastModified.toISOString(),
			attachments:
				item.kind === "file"
					? [
							{
								name: item.title,
								ref: item.sourceUrl,
								...(item.file?.mimeType
									? { contentType: item.file.mimeType }
									: {}),
							},
						]
					: [],
			// No etag: a re-upload with the same text is not a new version.
			metadata: {
				location: item.location,
				origins: item.origins,
				extractor,
				part: part + 1,
				parts,
			},
		}
	}

	/** Retires a part in Layer 1 without deleting it: a tombstone version
	 *  (empty text, invalidAt) supersedes the last one, and a file that
	 *  comes back simply writes a newer version over it. */
	private async retireRaw(
		key: string,
		kind: "file" | "note",
		part: number,
		at: string,
	): Promise<void> {
		await this.writer.rawWrite({
			scope: this.config.scope,
			scopeRef: this.config.scopeRef,
			items: [
				{
					source: "nextcloud",
					sourceId: this.rawSourceId(key, part),
					kind,
					text: "",
					unit: key,
					invalidAt: at,
					metadata: { retired: true },
				},
			],
		})
	}

	private async deprecate(sourcePath: string): Promise<void> {
		// Never DELETE: a soft-deleted wiki slug can never be reused, so a file
		// that comes back (restored from trash, re-tagged) would be locked out
		// of its own page. OKF status "deprecated" is reversible.
		await this.writer.wikiMergeFrontmatter({
			slug: slugForSourcePath(sourcePath),
			scope: this.config.scope,
			scopeRef: this.config.scopeRef,
			frontmatter: { type: "source", status: "deprecated" },
		})
	}

	private async retireVanished(
		d: Discovery,
		report: SyncReport,
	): Promise<void> {
		for (const [key, prior] of Object.entries(this.state.items)) {
			if (prior.stale) continue
			const complete = prior.kind === "file" ? d.filesComplete : d.notesComplete
			const seen = prior.kind === "file" ? d.seenFiles : d.seenNotes
			if (!complete || seen.has(key)) continue
			try {
				for (let i = 0; i < Math.max(prior.parts, 1); i++) {
					await this.deprecate(partPath(prior.basePath, i))
					await this.retireRaw(key, prior.kind, i, new Date().toISOString())
				}
				this.state.items[key] = { ...prior, stale: true }
				report.markedStale++
			} catch (err) {
				report.discoveryErrors.push(
					`could not mark ${prior.title} stale: ${message(err)}`,
				)
			}
		}
	}

	private recordOutcome(
		item: WorkItem,
		prior: ItemState | undefined,
		fields: Partial<ItemState>,
	): void {
		this.state.items[item.key] = {
			kind: item.kind,
			basePath: item.basePath,
			etag: prior?.etag ?? "",
			extractorVersion: EXTRACTOR_VERSION,
			parts: prior?.parts ?? 0,
			title: item.title,
			location: item.location,
			stale: prior?.stale ?? false,
			...fields,
		}
	}

	private recordFailure(
		item: WorkItem,
		prior: ItemState | undefined,
		reason: string,
		retryable: boolean,
		at: string,
	): void {
		this.recordOutcome(item, prior, {
			// Keep the last successful etag on a retryable failure, so the item
			// is retried; a permanent failure pins this etag so it is not
			// re-downloaded until the file changes.
			etag: retryable ? (prior?.etag ?? "") : item.etag,
			extractorVersion: prior?.extractorVersion ?? EXTRACTOR_VERSION,
			...(prior?.lastSyncedAt ? { lastSyncedAt: prior.lastSyncedAt } : {}),
			lastError: { message: reason, retryable, at },
		})
	}
}
