// An in-memory Nextcloud answering the WebDAV and Notes requests the
// connector makes, shaped like real server responses (d:/oc: prefixes,
// separate 200 and 404 propstats, quoted etags, URL-encoded hrefs).

// Document fixtures moved to @sqrrl/extract with the extraction code;
// re-exported so the connector tests keep one import site.
export {
	makeDocx,
	makePdf,
	makeScannedPdf,
	PNG_1PX,
} from "@sqrrl/extract/testing"

export interface FakeFile {
	fileId: string
	etag: string
	mimeType: string
	bytes: Uint8Array
	lastModified?: string
	tags?: string[]
}

export interface FakeNote {
	id: number
	etag: string
	title: string
	category: string
	content: string
	modified: number
}

export const BASE = "https://cloud.example.com"
export const USER = "sqrrl bot"

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/")

export class FakeNextcloud {
	/** Keyed by path relative to the account root. */
	files = new Map<string, FakeFile>()
	tags = new Map<string, string>([
		["meetings", "7"],
		["policy", "9"],
	])
	notes: FakeNote[] = []
	failPaths = new Set<string>()
	/** Folders persist when emptied, as they do in Nextcloud. */
	dirs = new Set<string>([""])
	notesInstalled = true
	requests: Array<{ method: string; url: string; body?: string }> = []
	private nextId = 100

	addFile(
		path: string,
		f: Partial<FakeFile> & { bytes: Uint8Array; mimeType: string },
	): FakeFile {
		const file: FakeFile = {
			fileId: f.fileId ?? String(this.nextId++),
			etag: f.etag ?? `e${this.nextId}`,
			lastModified: f.lastModified ?? "Tue, 15 Sep 2026 10:00:00 GMT",
			tags: f.tags ?? [],
			...f,
		}
		this.files.set(path, file)
		const segs = path.split("/")
		for (let i = 1; i < segs.length; i++)
			this.dirs.add(segs.slice(0, i).join("/"))
		return file
	}

	private root = `/remote.php/dav/files/${encodeURIComponent(USER)}`

	private fileResponse(path: string, f: FakeFile): string {
		return `<d:response><d:href>${this.root}/${enc(path)}</d:href><d:propstat><d:prop>
<d:getetag>&quot;${f.etag}&quot;</d:getetag><d:getlastmodified>${f.lastModified}</d:getlastmodified>
<d:getcontenttype>${f.mimeType}</d:getcontenttype><d:getcontentlength>${f.bytes.byteLength}</d:getcontentlength>
<d:resourcetype/><oc:fileid>${f.fileId}</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
<d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`
	}

	private dirResponse(path: string): string {
		return `<d:response><d:href>${this.root}/${enc(path)}${path ? "/" : ""}</d:href><d:propstat><d:prop>
<d:getetag>&quot;dir&quot;</d:getetag><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>1</oc:fileid>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
	}

	private multistatus(inner: string): Response {
		return new Response(
			`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${inner}</d:multistatus>`,
			{ status: 207, headers: { "Content-Type": "application/xml" } },
		)
	}

	fetch = async (
		input: string | URL | Request,
		init: RequestInit = {},
	): Promise<Response> => {
		const url = new URL(String(input))
		const method = init.method ?? "GET"
		const body = typeof init.body === "string" ? init.body : undefined
		this.requests.push({ method, url: url.toString(), body })
		const auth = new Headers(init.headers).get("Authorization") ?? ""
		if (!auth.startsWith("Basic "))
			return new Response("no auth", { status: 401 })

		if (url.pathname === "/index.php/apps/notes/api/v1/notes") {
			if (!this.notesInstalled) {
				return new Response("<html>login</html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				})
			}
			const prune = Number(url.searchParams.get("pruneBefore") ?? 0)
			return Response.json(
				this.notes.map((n) => (prune && n.modified < prune ? { id: n.id } : n)),
			)
		}
		if (url.pathname === "/remote.php/dav/systemtags/") {
			return this.multistatus(
				[...this.tags]
					.map(
						([name, id]) =>
							`<d:response><d:href>/remote.php/dav/systemtags/${id}</d:href><d:propstat><d:prop><oc:id>${id}</oc:id><oc:display-name>${name}</oc:display-name></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
					)
					.join(""),
			)
		}
		const decoded = decodeURIComponent(url.pathname)
		const rootDecoded = decodeURIComponent(this.root)
		if (!decoded.startsWith(rootDecoded))
			return new Response("nope", { status: 404 })
		const rel = decoded.slice(rootDecoded.length).replace(/^\/|\/$/g, "")

		if (method === "REPORT") {
			const tagId = /<oc:systemtag>(\d+)<\/oc:systemtag>/.exec(body ?? "")?.[1]
			const name = [...this.tags].find(([, id]) => id === tagId)?.[0]
			return this.multistatus(
				[...this.files]
					.filter(([, f]) => name && f.tags?.includes(name))
					.map(([p, f]) => this.fileResponse(p, f))
					.join(""),
			)
		}
		if (method === "PROPFIND") {
			if (this.failPaths.has(rel)) return new Response("boom", { status: 503 })
			const depth = new Headers(init.headers).get("Depth")
			if (depth === "0") return this.multistatus(this.dirResponse(rel))
			const prefix = rel ? `${rel}/` : ""
			const children = new Set<string>()
			const parts: string[] = []
			let exists = this.dirs.has(rel)
			for (const [p, f] of this.files) {
				if (!p.startsWith(prefix)) continue
				exists = true
				const rest = p.slice(prefix.length)
				if (!rest.includes("/")) parts.push(this.fileResponse(p, f))
				else children.add(rest.split("/")[0])
			}
			if (!exists) return new Response("not found", { status: 404 })
			for (const d of this.dirs) {
				if (
					d.startsWith(prefix) &&
					d !== rel &&
					!d.slice(prefix.length).includes("/")
				) {
					children.add(d.slice(prefix.length))
				}
			}
			for (const c of children) parts.push(this.dirResponse(prefix + c))
			return this.multistatus(this.dirResponse(rel) + parts.join(""))
		}
		if (method === "GET") {
			const f = this.files.get(rel)
			if (!f) return new Response("gone", { status: 404 })
			return new Response(new Blob([f.bytes]), {
				status: 200,
				headers: {
					"Content-Length": String(f.bytes.byteLength),
					"Content-Type": f.mimeType,
				},
			})
		}
		return new Response("unsupported", { status: 405 })
	}
}
