// Nextcloud WebDAV: folder listing, system-tag lookup, download.
//
// Nextcloud usually disables `Depth: infinity`, so folders are walked one
// level at a time. Files are identified by oc:fileid rather than by path so a
// rename or move keeps its wiki page instead of forking a new one.

import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { XMLParser } from "fast-xml-parser"

export interface NextcloudFile {
	/** oc:fileid — stable across renames and moves. */
	fileId: string
	/** Path relative to the account's file root, e.g. "Company/Q3 plan.pdf". */
	path: string
	name: string
	etag: string
	/** RFC 1123 date from d:getlastmodified. */
	lastModified: string
	mimeType: string
	size: number
	/** Server-absolute href, used to download. */
	href: string
}

export type FetchFn = typeof globalThis.fetch

export class NextcloudHttpError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
		detail: string,
	) {
		super(`Nextcloud ${status} for ${url}${detail ? `: ${detail}` : ""}`)
	}
}

const FILE_PROPS = `<d:prop>
<d:getetag/><d:getlastmodified/><d:getcontenttype/><d:getcontentlength/>
<d:resourcetype/><d:displayname/><oc:fileid/>
</d:prop>`

const NS = `xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"`

const parser = new XMLParser({
	removeNSPrefix: true,
	ignoreAttributes: true,
	parseTagValue: false,
	trimValues: true,
	isArray: (name) => name === "response" || name === "propstat",
})

interface Propstat {
	prop?: Record<string, unknown>
	status?: string
}
interface DavResponse {
	href?: string
	propstat?: Propstat[]
}

/** Merges every propstat that answered 200; 404 propstats name properties
 *  the server does not have for this resource and are ignored. */
function okProps(r: DavResponse): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const ps of r.propstat ?? []) {
		if (!/\s200\b/.test(String(ps.status ?? ""))) continue
		Object.assign(out, ps.prop ?? {})
	}
	return out
}

export function parseMultistatus(xml: string): DavResponse[] {
	const doc = parser.parse(xml) as {
		multistatus?: { response?: DavResponse[] }
	}
	return doc.multistatus?.response ?? []
}

function str(v: unknown): string {
	if (v === undefined || v === null) return ""
	if (typeof v === "object") return ""
	return String(v)
}

export class NextcloudWebDav {
	private readonly origin: string
	private readonly auth: string
	private readonly filesRoot: string

	constructor(
		private readonly baseUrl: string,
		private readonly user: string,
		appPassword: string,
		private readonly fetchFn: FetchFn = globalThis.fetch,
	) {
		this.origin = new URL(baseUrl).origin
		this.auth = `Basic ${Buffer.from(`${user}:${appPassword}`).toString("base64")}`
		this.filesRoot = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(user)}`
	}

	private async dav(
		method: string,
		url: string,
		body?: string,
		headers: Record<string, string> = {},
	): Promise<string> {
		const res = await this.fetchFn(url, {
			method,
			headers: {
				Authorization: this.auth,
				"Content-Type": "application/xml; charset=utf-8",
				...headers,
			},
			...(body !== undefined ? { body } : {}),
		})
		const text = await res.text()
		if (res.status !== 207 && !res.ok) {
			throw new NextcloudHttpError(res.status, url, text.slice(0, 200))
		}
		return text
	}

	/** Confirms the credentials work by listing the account root. */
	async ping(): Promise<void> {
		await this.dav(
			"PROPFIND",
			`${this.filesRoot}/`,
			`<?xml version="1.0"?><d:propfind ${NS}><d:prop><d:resourcetype/></d:prop></d:propfind>`,
			{ Depth: "0" },
		)
	}

	/** Path relative to the account root, decoded, for an href. */
	relativePath(href: string): string {
		const decoded = decodeURIComponent(href)
		const marker = `/remote.php/dav/files/${this.user}/`
		const i = decoded.indexOf(marker)
		return (i === -1 ? decoded : decoded.slice(i + marker.length)).replace(
			/\/$/,
			"",
		)
	}

	private toFile(r: DavResponse): NextcloudFile | null {
		const p = okProps(r)
		const isCollection =
			typeof p.resourcetype === "object" &&
			p.resourcetype !== null &&
			"collection" in (p.resourcetype as object)
		if (isCollection || !r.href) return null
		const path = this.relativePath(r.href)
		return {
			fileId: str(p.fileid),
			path,
			name: str(p.displayname) || path.split("/").pop() || path,
			etag: str(p.getetag).replace(/"/g, ""),
			lastModified: str(p.getlastmodified),
			mimeType: str(p.getcontenttype) || "application/octet-stream",
			size: Number(str(p.getcontentlength) || 0),
			href: r.href,
		}
	}

	/** Every file under a folder, recursively. Throws if any level fails, so
	 *  a partial listing is never mistaken for a complete one. */
	async listFolder(folder: string, limit = 50_000): Promise<NextcloudFile[]> {
		const files: NextcloudFile[] = []
		const queue = [folder.replace(/^\/+|\/+$/g, "")]
		const seen = new Set<string>()
		while (queue.length > 0) {
			const dir = queue.shift() as string
			if (seen.has(dir)) continue
			seen.add(dir)
			const url = `${this.filesRoot}/${dir
				.split("/")
				.filter(Boolean)
				.map(encodeURIComponent)
				.join("/")}/`
			const xml = await this.dav(
				"PROPFIND",
				url,
				`<?xml version="1.0"?><d:propfind ${NS}>${FILE_PROPS}</d:propfind>`,
				{ Depth: "1" },
			)
			for (const r of parseMultistatus(xml)) {
				if (!r.href) continue
				const rel = this.relativePath(r.href)
				if (rel === dir) continue // the folder itself
				const file = this.toFile(r)
				if (file) {
					files.push(file)
					if (files.length > limit) {
						throw new Error(
							`more than ${limit} files under "${folder}"; narrow NEXTCLOUD_FOLDERS`,
						)
					}
				} else {
					queue.push(rel)
				}
			}
		}
		return files
	}

	/** Maps system tag display names to their ids. */
	async systemTags(): Promise<Map<string, string>> {
		const xml = await this.dav(
			"PROPFIND",
			`${this.baseUrl}/remote.php/dav/systemtags/`,
			`<?xml version="1.0"?><d:propfind ${NS}><d:prop><oc:id/><oc:display-name/></d:prop></d:propfind>`,
			{ Depth: "1" },
		)
		const out = new Map<string, string>()
		for (const r of parseMultistatus(xml)) {
			const p = okProps(r)
			const id = str(p.id)
			const name = str(p["display-name"])
			if (id && name) out.set(name.toLowerCase(), id)
		}
		return out
	}

	/** Every file carrying a system tag, anywhere in the account. */
	async filesWithTag(tagId: string): Promise<NextcloudFile[]> {
		const xml = await this.dav(
			"REPORT",
			`${this.filesRoot}/`,
			`<?xml version="1.0"?><oc:filter-files ${NS}>${FILE_PROPS}<oc:filter-rules><oc:systemtag>${tagId}</oc:systemtag></oc:filter-rules></oc:filter-files>`,
		)
		return parseMultistatus(xml)
			.map((r) => this.toFile(r))
			.filter((f): f is NextcloudFile => f !== null)
	}

	/** Downloads a file, refusing anything over maxBytes even if the listing
	 *  under-reported its size. */
	async download(file: NextcloudFile, maxBytes: number): Promise<Uint8Array> {
		const url = `${this.origin}${file.href}`
		const res = await this.fetchFn(url, {
			headers: { Authorization: this.auth },
		})
		if (!res.ok) {
			throw new NextcloudHttpError(res.status, url, "")
		}
		const declared = Number(res.headers.get("content-length") ?? 0)
		if (declared > maxBytes) {
			await res.body?.cancel()
			throw new Error(`${file.path} is ${declared} bytes, over ${maxBytes}`)
		}
		const buf = new Uint8Array(await res.arrayBuffer())
		if (buf.byteLength > maxBytes) {
			throw new Error(
				`${file.path} is ${buf.byteLength} bytes, over ${maxBytes}`,
			)
		}
		return buf
	}

	/** Streams a file to disk, hashing as it goes. For recordings, which can
	 *  be gigabytes: holding them in memory would not survive this host. */
	async downloadToFile(
		file: NextcloudFile,
		destPath: string,
		maxBytes: number,
	): Promise<{ bytes: number; sha256: string }> {
		const url = `${this.origin}${file.href}`
		const res = await this.fetchFn(url, {
			headers: { Authorization: this.auth },
		})
		if (!res.ok || !res.body) {
			throw new NextcloudHttpError(res.status, url, "")
		}
		const declared = Number(res.headers.get("content-length") ?? 0)
		if (declared > maxBytes) {
			await res.body.cancel()
			throw new Error(`${file.path} is ${declared} bytes, over ${maxBytes}`)
		}
		const hash = createHash("sha256")
		const out = createWriteStream(destPath)
		let total = 0
		try {
			const reader = res.body.getReader()
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				total += value.byteLength
				if (total > maxBytes) {
					await reader.cancel()
					throw new Error(
						`${file.path} exceeded ${maxBytes} bytes while downloading`,
					)
				}
				hash.update(value)
				if (!out.write(value)) {
					await new Promise<void>((resolve) => out.once("drain", resolve))
				}
			}
		} finally {
			await new Promise<void>((resolve, reject) => {
				out.once("error", reject)
				out.end(resolve)
			})
		}
		return { bytes: total, sha256: hash.digest("hex") }
	}

	/** Browser link to the file in Nextcloud's own UI. */
	fileUrl(file: NextcloudFile): string {
		return `${this.baseUrl}/f/${file.fileId}`
	}
}
