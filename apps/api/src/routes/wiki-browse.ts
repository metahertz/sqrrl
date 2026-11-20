// Browsable wiki (/wiki/*).
//
// The engine already had the pieces of a wiki — namespaced slugs, typed
// relationships, auto-maintained backlinks, {{page:slug}} transclusion,
// [[wikilinks]] and an HTML renderer — but nothing served them as something
// a person could read and click through:
//
//   * renderWikiPageHtml returns an <article> fragment: no doctype, no
//     charset, no styles, so a browser cannot render it standalone.
//   * Every href it emitted pointed at /wiki/<slug>, a route that did not
//     exist. The real route was /v1/wiki/<slug>, and it 400s without
//     scope/scopeRef, so every link was dead even with the prefix corrected.
//   * /v1/* requires an Authorization header, which a browser does not send
//     when following a link.
//
// This router closes all three: full documents, links that carry scope, and
// a cookie so ordinary navigation authenticates. Reads go through the same
// governance context as the JSON API — browsing must not see more than
// fetching does.

import { Hono, type Context } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import {
	getWikiPage,
	listWikiPages,
	resolveTransclusions,
	renderWikiPageDocument,
	renderWikiIndexDocument,
	type WikiIndexEntry,
	type WikiPageView,
} from "@sqrrl/wiki-engine"
import type { ApiEnvironment } from "../api-context.js"
import { getWikiStoreHandle } from "../wiki-store-runtime.js"
import { buildWikiGovContext } from "./wiki-context.js"

/** Cookie holding the API token for browser navigation. Path-scoped to the
 *  browse prefix so it is never sent to /v1, and HttpOnly so page script
 *  cannot read it back out. */
export const WIKI_SESSION_COOKIE = "mdbrain_wiki_key"

/** Login path. Underscore-prefixed so it cannot collide with a generated
 *  slug — ingest writes sources/, people/, topics/ and tasks/ namespaces. */
export const WIKI_LOGIN_PATH = "/wiki/_login"

/** Reads the browse token from the cookie. Exported so the auth middleware
 *  can fall back to it without knowing the cookie's name. */
export function readWikiSessionCookie(c: {
	req: { raw: Request }
}): string | undefined {
	return getCookie(c as never, WIKI_SESSION_COOKIE)
}

/** Login and error pages: the console's tokens, light and dark, so the
 *  standalone reader matches the console end to end. */
const PAGE_CSS = `:root{color-scheme:light dark;--bg:#f7f8fa;--panel:#fff;--border:#cfd6e0;
 --ink:#111827;--muted:#6b7280;--accent:#0d9488;--accent-ink:#fff;--danger:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0b0d12;--panel:#12151c;--border:#323a4b;
 --ink:#e8ebf1;--muted:#8b93a5;--accent:#2dd4bf;--accent-ink:#042f2e;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6
 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:26rem;margin:12vh auto 0;padding:28px;background:var(--panel);
 border:1px solid var(--border);border-radius:14px;box-shadow:0 24px 64px rgb(16 24 40/.12)}
h1{font-size:18px;margin:0 0 .75rem;display:flex;gap:9px;align-items:center}
h1::before{content:"m";width:24px;height:24px;border-radius:7px;display:grid;place-items:center;
 background:linear-gradient(135deg,var(--accent),#6366f1);color:#fff;font-size:12px}
input,button{font:inherit;padding:.5rem .65rem;border-radius:7px;
 border:1px solid var(--border);width:100%;background:var(--panel);color:var(--ink)}
button{margin-top:.75rem;cursor:pointer;background:var(--accent);color:var(--accent-ink);
 border-color:var(--accent);font-weight:550}
.err{color:var(--danger);margin:0 0 1rem}
label{display:block;margin-bottom:.35rem;font-size:13px;color:var(--muted)}
p{color:var(--muted)}`

/** Where "Open in console" points (SQRRL_CONSOLE_URL); unset, no link. */
function consoleUrl(): { consoleUrl?: string } {
	const url = process.env.SQRRL_CONSOLE_URL?.trim()
	return url && /^https?:\/\//.test(url) ? { consoleUrl: url } : {}
}

function escapeHtml(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

/** An error a reader sees, not a JSON body they have to decode. */
function errorDocument(title: string, detail: string, status: number): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		'<head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		`<title>${escapeHtml(title)} — SQRRL wiki</title>`,
		`<style>${PAGE_CSS}</style></head>`,
		`<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>`,
		"</html>",
	].join("\n")
}

function loginDocument(next: string, error?: string): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		'<head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex, nofollow">',
		"<title>Sign in — SQRRL wiki</title>",
		`<style>${PAGE_CSS}</style></head>`,
		"<body><main>",
		"<h1>SQRRL wiki</h1>",
		error ? `<p class="err">${escapeHtml(error)}</p>` : "",
		`<form method="post" action="${escapeHtml(WIKI_LOGIN_PATH)}">`,
		`<input type="hidden" name="next" value="${escapeHtml(next)}">`,
		'<label for="key">API key</label>',
		'<input id="key" name="key" type="password" autocomplete="current-password" autofocus>',
		"<button type=submit>Sign in</button>",
		"</form></main></body>",
		"</html>",
	].join("\n")
}

/** Keeps a post-login redirect pointed at this site: an attacker-supplied
 *  absolute URL in ?next= would otherwise turn the login form into an open
 *  redirect. Only a single-slash-prefixed path is accepted. */
function safeNextPath(raw: unknown): string {
	const value = typeof raw === "string" ? raw : ""
	if (!value.startsWith("/") || value.startsWith("//")) return "/wiki/"
	return value
}

export function createWikiBrowseRouter(): Hono<ApiEnvironment> {
	const wiki = new Hono<ApiEnvironment>()

	wiki.get("/_login", (c) =>
		c.html(loginDocument(safeNextPath(c.req.query("next")))),
	)

	wiki.post("/_login", async (c) => {
		const form = await c.req
			.parseBody()
			.catch(() => ({}) as Record<string, unknown>)
		const key = typeof form.key === "string" ? form.key.trim() : ""
		const next = safeNextPath(form.next)
		if (!key) {
			return c.html(loginDocument(next, "Enter an API key."), 400)
		}
		// The key is not validated here: the auth middleware on the next
		// request is the single place that decides whether a token is real,
		// so there is only one answer to keep correct.
		setCookie(c, WIKI_SESSION_COOKIE, key, {
			path: "/wiki",
			httpOnly: true,
			sameSite: "Strict",
			secure: new URL(c.req.url).protocol === "https:",
			maxAge: 60 * 60 * 12,
		})
		return c.redirect(next, 303)
	})

	wiki.get("/_logout", (c) => {
		deleteCookie(c, WIKI_SESSION_COOKIE, { path: "/wiki" })
		return c.html(
			errorDocument("Signed out", "The browse cookie has been cleared.", 200),
		)
	})

	// Scope index — the entry point. Without it a reader has to know a slug
	// before they can see anything at all.
	//
	// Reached both as "/wiki/" and as the empty-slug case of the wildcard
	// below: Hono resolves a mounted "/" against the wildcard first, so
	// relying on the "/" registration alone silently served a redirect loop
	// instead of the index.
	const indexResponse = async (c: Context<ApiEnvironment>) => {
		const scope = c.req.query("scope") ?? ""
		const scopeRef = c.req.query("scopeRef") ?? ""
		if (!scope || !scopeRef) {
			return c.html(
				errorDocument(
					"Pick a scope",
					"Add ?scope=<scope>&scopeRef=<ref> to browse a wiki, for example /wiki/?scope=workspace&scopeRef=brain",
					400,
				),
				400,
			)
		}
		try {
			const handle = await getWikiStoreHandle()
			const result = await listWikiPages(handle, {
				scope,
				scopeRef,
				state: "active",
				limit: 500,
				governance: buildWikiGovContext(c, scope, scopeRef),
			})
			const entries: WikiIndexEntry[] = result.pages.map(
				(page: WikiPageView) => ({
					slug: page.slug,
					title: page.title || page.slug,
					kind: page.kind,
				}),
			)
			return c.html(
				renderWikiIndexDocument(entries, { scope, scopeRef, ...consoleUrl() }),
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return c.html(errorDocument("Could not list pages", message, 500), 500)
		}
	}

	wiki.get("/", indexResponse)

	// Page view. Transclusion is resolved here (unlike the JSON route, which
	// leaves the raw {{page:slug}} markers in place for editors) because a
	// reader wants the composed page, not its source.
	wiki.get("/*", async (c) => {
		const slug = c.req.path
			.split("/wiki/")
			.slice(1)
			.join("/wiki/")
			.replace(/\/$/, "")
		const scope = c.req.query("scope") ?? ""
		const scopeRef = c.req.query("scopeRef") ?? ""
		if (!slug) return indexResponse(c)
		if (!scope || !scopeRef) {
			return c.html(
				errorDocument(
					"Missing scope",
					`This link is missing its scope. Try /wiki/?scope=<scope>&scopeRef=<ref> and navigate to "${slug}" from the index.`,
					400,
				),
				400,
			)
		}
		try {
			const handle = await getWikiStoreHandle()
			const governance = buildWikiGovContext(c, scope, scopeRef)
			const page = await getWikiPage(
				handle,
				decodeURIComponent(slug),
				scope,
				scopeRef,
				governance,
			)
			if (!page) {
				return c.html(
					errorDocument(
						"Page not found",
						`No page "${decodeURIComponent(slug)}" in scope ${scope}:${scopeRef}.`,
						404,
					),
					404,
				)
			}
			const body = await resolveTransclusions(handle, page.body, governance)
			return c.html(
				renderWikiPageDocument(
					{ ...page, body },
					{ scope, scopeRef, ...consoleUrl() },
				),
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return c.html(errorDocument("Could not load page", message, 500), 500)
		}
	})

	return wiki
}
