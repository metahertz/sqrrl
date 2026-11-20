// Nextcloud Notes app, API v1: /index.php/apps/notes/api/v1/notes

import { type FetchFn, NextcloudHttpError } from "./webdav.js"

export interface NextcloudNote {
	id: number
	etag: string
	title: string
	category: string
	/** Absent when the note was pruned (unchanged since pruneBefore). */
	content?: string
	/** Unix seconds. */
	modified: number
}

/** True when a note's category is one of the selected ones or nested under
 *  one: selecting "Work" includes "Work/1:1s". "*" selects everything. */
export function categorySelected(
	category: string,
	selected: string[],
): boolean {
	if (selected.includes("*")) return true
	const c = category.replace(/^\/+|\/+$/g, "").toLowerCase()
	return selected.some((s) => {
		const want = s.replace(/^\/+|\/+$/g, "").toLowerCase()
		return c === want || c.startsWith(`${want}/`)
	})
}

export class NextcloudNotes {
	private readonly auth: string

	constructor(
		private readonly baseUrl: string,
		user: string,
		appPassword: string,
		private readonly fetchFn: FetchFn = globalThis.fetch,
	) {
		this.auth = `Basic ${Buffer.from(`${user}:${appPassword}`).toString("base64")}`
	}

	/** Every note. With pruneBefore, notes unchanged since then come back as
	 *  bare ids — still listed, so they are not mistaken for deletions, but
	 *  without content to re-send. */
	async list(pruneBefore?: number): Promise<NextcloudNote[]> {
		const qs = new URLSearchParams()
		if (pruneBefore) qs.set("pruneBefore", String(pruneBefore))
		const url = `${this.baseUrl}/index.php/apps/notes/api/v1/notes${
			qs.size ? `?${qs}` : ""
		}`
		const res = await this.fetchFn(url, {
			headers: { Authorization: this.auth, Accept: "application/json" },
		})
		const text = await res.text()
		if (!res.ok) {
			throw new NextcloudHttpError(res.status, url, text.slice(0, 200))
		}
		let raw: unknown
		try {
			raw = JSON.parse(text)
		} catch {
			// The Notes app answers with the login page (HTML, 200) when the app
			// is not installed or the URL is wrong; say so rather than "Unexpected token <".
			throw new Error(
				`Notes API at ${url} did not return JSON — is the Notes app installed?`,
			)
		}
		if (!Array.isArray(raw)) {
			throw new Error(`Notes API at ${url} returned a non-array body`)
		}
		return raw.map((n: Record<string, unknown>) => ({
			id: Number(n.id),
			etag: String(n.etag ?? ""),
			title: String(n.title ?? ""),
			category: String(n.category ?? ""),
			...(typeof n.content === "string" ? { content: n.content } : {}),
			modified: Number(n.modified ?? 0),
		}))
	}
}
