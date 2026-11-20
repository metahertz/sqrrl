// @sqrrl/wiki-engine — wiki page rendering (markdown + HTML).
//
// Markdown render: agent-readable, dense, OKF-export-friendly structure.
// HTML render: human-browsable, minimal styling (no framework dependency).

import type { WikiPageView } from "./wiki-bridge.js"

// ---------------------------------------------------------------------------
// Link construction
// ---------------------------------------------------------------------------

/** Where the browse UI is mounted and which scope its links should carry.
 *  Every generated href has to name a scope: the wiki store is partitioned by
 *  scope:scopeRef, and a link that drops it lands on a route that cannot tell
 *  which partition to read and answers 400. */
/** Document options: link options plus where the console lives, so a
 *  reader can jump from a shared page into the full app. */
export interface WikiDocumentOptions extends WikiLinkOptions {
	/** Console origin, e.g. http://host:3040. Omitted: no console link. */
	consoleUrl?: string
}

function consoleLink(opts: WikiDocumentOptions, slug?: string): string {
	if (!opts.consoleUrl) return ""
	const base = opts.consoleUrl.replace(/\/$/, "")
	const hash = slug ? `#wiki/${encodeSlugPath(slug)}` : "#wiki"
	return `<a class="console" href="${htmlEscape(`${base}/dashboard${hash}`)}">Open in console ↗</a>`
}

export interface WikiLinkOptions {
	/** Path prefix the browse UI is mounted at. Default "/wiki". */
	basePath?: string
	/** Scope carried into links. Defaults to the rendered page's own scope. */
	scope?: string
	/** scopeRef carried into links. Defaults to the rendered page's own. */
	scopeRef?: string
}

/** Percent-encodes each slug segment while keeping "/" as a path separator:
 *  slugs are file-path shaped ("sources/notes/a.md") and the browse route
 *  parses them out of the path, so the separators must survive encoding. */
function encodeSlugPath(slug: string): string {
	return String(slug)
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")
}

/** Builds an href for one page, carrying scope through as query params.
 *  Query rather than path segments because the API's scoped-key
 *  authorization reads scope/scopeRef out of the query string for GET
 *  requests — putting them in the path would leave a scoped key
 *  unconstrained on exactly the routes that serve page content. */
export function wikiPageHref(slug: string, opts: WikiLinkOptions = {}): string {
	const basePath = (opts.basePath ?? "/wiki").replace(/\/$/, "")
	const params = new URLSearchParams()
	if (opts.scope) params.set("scope", opts.scope)
	if (opts.scopeRef) params.set("scopeRef", opts.scopeRef)
	const query = params.toString()
	return `${basePath}/${encodeSlugPath(slug)}${query ? `?${query}` : ""}`
}

/** Href for the scope's index page. */
export function wikiIndexHref(opts: WikiLinkOptions = {}): string {
	const basePath = (opts.basePath ?? "/wiki").replace(/\/$/, "")
	const params = new URLSearchParams()
	if (opts.scope) params.set("scope", opts.scope)
	if (opts.scopeRef) params.set("scopeRef", opts.scopeRef)
	const query = params.toString()
	return `${basePath}/${query ? `?${query}` : ""}`
}

function htmlEscape(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

/** Renders a wiki page view as markdown (agent-readable). */
export function renderWikiPageMarkdown(view: WikiPageView): string {
	const lines: string[] = []
	lines.push(`# ${view.title}`)
	lines.push("")
	if (view.aliases.length > 0) {
		lines.push(`**Aliases:** ${view.aliases.join(", ")}`)
		lines.push("")
	}
	lines.push(`> ${view.summary}`)
	lines.push("")
	if (view.body) {
		lines.push(view.body)
		lines.push("")
	}
	if (view.claims.length > 0) {
		lines.push("## Claims")
		lines.push("")
		for (const claim of view.claims as Array<Record<string, unknown>>) {
			const status = claim.status ? ` _[${claim.status}]_` : ""
			const conf =
				typeof claim.confidence === "number"
					? ` (conf: ${claim.confidence})`
					: ""
			lines.push(`- ${claim.text}${status}${conf}`)
		}
		lines.push("")
	}
	if (
		(view as unknown as { contradictions?: unknown[] }).contradictions?.length
	) {
		lines.push("## Contradictions")
		lines.push("")
		const contradictions = (
			view as unknown as { contradictions: Array<Record<string, unknown>> }
		).contradictions
		for (const c of contradictions) {
			const claimIds = Array.isArray(c.claimIds)
				? (c.claimIds as string[]).join(" ↔ ")
				: ""
			lines.push(`- [${c.resolution ?? "unresolved"}] ${claimIds}`)
		}
		lines.push("")
	}
	if (view.questions.length > 0) {
		lines.push("## Open Questions")
		lines.push("")
		for (const q of view.questions as Array<Record<string, unknown>>) {
			const marker = q.status === "answered" ? "✓" : "?"
			lines.push(`- ${marker} ${q.text}`)
		}
		lines.push("")
	}
	if (view.relationships.length > 0) {
		lines.push("## Relationships")
		lines.push("")
		for (const r of view.relationships as Array<Record<string, unknown>>) {
			lines.push(`- [${r.kind}] → [[${r.targetPageSlug}]] ${r.targetTitle}`)
		}
		lines.push("")
	}
	if (view.personCard) {
		const pc = view.personCard as Record<string, unknown>
		lines.push("## Person Card")
		lines.push("")
		if (pc.canonicalId) lines.push(`- **Canonical ID:** ${pc.canonicalId}`)
		if (Array.isArray(pc.handles) && pc.handles.length)
			lines.push(`- **Handles:** ${pc.handles.join(", ")}`)
		if (Array.isArray(pc.socials) && pc.socials.length)
			lines.push(`- **Socials:** ${pc.socials.join(", ")}`)
		if (Array.isArray(pc.emails) && pc.emails.length)
			lines.push(`- **Emails:** ${pc.emails.join(", ")}`)
		if (pc.timezone) lines.push(`- **Timezone:** ${pc.timezone}`)
		if (pc.bestUsedFor) lines.push(`- **Best used for:** ${pc.bestUsedFor}`)
		if (pc.notEnoughFor) lines.push(`- **Not enough for:** ${pc.notEnoughFor}`)
		lines.push("")
	}
	if (view.backlinks.length > 0) {
		lines.push("## Backlinks")
		lines.push("")
		for (const b of view.backlinks as Array<Record<string, unknown>>) {
			lines.push(`- ← [[${b.sourcePageSlug}]] ${b.sourceTitle}`)
		}
		lines.push("")
	}
	lines.push("---")
	lines.push(
		`_kind: ${view.kind} · scope: ${view.scope}:${view.scopeRef} · trust: ${view.trustTier} · state: ${view.state} · rev: ${view.revision} · freshness: ${view.freshness}_`,
	)
	return lines.join("\n")
}

/** Renders a wiki page view as HTML (human-browsable). Minimal inline styling —
 *  no framework dependency. The web console can wrap this in its own layout. */
export function renderWikiPageHtml(
	view: WikiPageView,
	opts: WikiLinkOptions = {},
): string {
	const esc = htmlEscape
	// The page's own scope is the right default: a link out of this page
	// stays in the partition the reader is already browsing.
	const link: WikiLinkOptions = {
		basePath: opts.basePath ?? "/wiki",
		scope: opts.scope ?? view.scope,
		scopeRef: opts.scopeRef ?? view.scopeRef,
	}
	const bodyHtml = markdownToHtml(esc(view.body), link)
	const parts: string[] = []
	parts.push(
		`<article class="sqrrl-wiki-page" data-slug="${esc(view.slug)}" data-kind="${esc(view.kind)}">`,
	)
	parts.push(`<h1>${esc(view.title)}</h1>`)
	if (view.aliases.length > 0) {
		parts.push(
			`<p class="aliases"><strong>Aliases:</strong> ${view.aliases.map(esc).join(", ")}</p>`,
		)
	}
	parts.push(`<blockquote>${esc(view.summary)}</blockquote>`)
	parts.push(`<div class="body">${bodyHtml}</div>`)
	if (view.claims.length > 0) {
		parts.push(`<h2>Claims</h2><ul>`)
		for (const claim of view.claims as Array<Record<string, unknown>>) {
			const status = claim.status ? ` <em>[${esc(claim.status)}]</em>` : ""
			parts.push(`<li>${esc(claim.text)}${status}</li>`)
		}
		parts.push(`</ul>`)
	}
	if (view.questions.length > 0) {
		parts.push(`<h2>Open Questions</h2><ul>`)
		for (const q of view.questions as Array<Record<string, unknown>>) {
			const marker = q.status === "answered" ? "✓" : "?"
			parts.push(`<li>${marker} ${esc(q.text)}</li>`)
		}
		parts.push(`</ul>`)
	}
	if (view.relationships.length > 0) {
		parts.push(`<h2>Relationships</h2><ul>`)
		for (const r of view.relationships as Array<Record<string, unknown>>) {
			parts.push(
				`<li>[${esc(r.kind)}] → <a href="${esc(wikiPageHref(String(r.targetPageSlug), link))}">${esc(r.targetTitle)}</a></li>`,
			)
		}
		parts.push(`</ul>`)
	}
	if (view.backlinks.length > 0) {
		parts.push(`<h2>Backlinks</h2><ul>`)
		for (const b of view.backlinks as Array<Record<string, unknown>>) {
			parts.push(
				`<li>← <a href="${esc(wikiPageHref(String(b.sourcePageSlug), link))}">${esc(b.sourceTitle)}</a></li>`,
			)
		}
		parts.push(`</ul>`)
	}
	parts.push(
		`<footer><small>kind: ${esc(view.kind)} · scope: ${esc(view.scope)}:${esc(view.scopeRef)} · trust: ${esc(view.trustTier)} · state: ${esc(view.state)} · rev: ${view.revision} · freshness: ${esc(view.freshness)}</small></footer>`,
	)
	parts.push(`</article>`)
	return parts.join("\n")
}

/** Minimal markdown → HTML (headings, bold, italic, code, paragraphs, links).
 *  No external dependency — keeps the wiki-engine self-contained. */
function markdownToHtml(md: string, link: WikiLinkOptions = {}): string {
	if (!md) return ""
	const lines = md.split("\n")
	const out: string[] = []
	let inList = false
	const closeList = () => {
		if (inList) {
			out.push("</ul>")
			inList = false
		}
	}
	const inline = (s: string): string =>
		s
			.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
			.replace(/\*(.+?)\*/g, "<em>$1</em>")
			.replace(/`(.+?)`/g, "<code>$1</code>")
			.replace(
				/\[\[(.+?)\]\]/g,
				(_m, target: string) =>
					`<a href="${htmlEscape(wikiPageHref(target, link))}">${target}</a>`,
			)
	for (const raw of lines) {
		const line = raw
		if (/^###\s+/.test(line)) {
			closeList()
			out.push(`<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`)
		} else if (/^##\s+/.test(line)) {
			closeList()
			out.push(`<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`)
		} else if (/^#\s+/.test(line)) {
			closeList()
			out.push(`<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`)
		} else if (/^[-*]\s+/.test(line)) {
			if (!inList) {
				out.push("<ul>")
				inList = true
			}
			out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`)
		} else if (line.trim() === "") {
			closeList()
		} else {
			closeList()
			out.push(`<p>${inline(line)}</p>`)
		}
	}
	closeList()
	return out.join("\n")
}

// ---------------------------------------------------------------------------
// Full-document rendering (browsable)
// ---------------------------------------------------------------------------

/** The standalone reader's stylesheet: the same tokens as the console
 *  (apps/web/app/dashboard/console.css), light and dark, so a page opened
 *  from a shared link looks like the console's Wiki view. Inlined so the
 *  browse route stays one self-contained response with no asset pipeline. */
const BROWSE_CSS = `
:root { color-scheme: light dark; --bg:#f7f8fa; --panel:#fff; --panel-2:#f3f5f8;
  --border:#e3e7ee; --ink:#111827; --label:#374151; --muted:#6b7280; --faint:#9ca3af;
  --accent:#0d9488; --accent-strong:#0f766e; --accent-soft:#ccfbf1; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b0d12; --panel:#12151c;
  --panel-2:#171b24; --border:#232937; --ink:#e8ebf1; --label:#c4cad6; --muted:#8b93a5;
  --faint:#5f6779; --accent:#2dd4bf; --accent-strong:#5eead4;
  --accent-soft:rgb(45 212 191 / .14); } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.7 ui-sans-serif,
  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing:antialiased; }
nav { position:sticky; top:0; z-index:1; display:flex; gap:12px; align-items:center;
  flex-wrap:wrap; padding:10px 20px; background:var(--panel); border-bottom:1px solid var(--border); }
nav .brand { display:flex; gap:9px; align-items:center; font-weight:650; }
nav .brand a { color:var(--ink); text-decoration:none; }
nav .mark { width:24px; height:24px; border-radius:7px; display:grid; place-items:center;
  background:linear-gradient(135deg,var(--accent),#6366f1); color:#fff; font-size:12px; font-weight:700; }
nav .scope { color:var(--muted); font-size:12.5px; padding:2px 9px; border-radius:99px;
  background:var(--panel-2); border:1px solid var(--border); }
nav .console { margin-left:auto; font-size:13px; padding:5px 11px; border-radius:7px;
  border:1px solid var(--border); color:var(--ink); text-decoration:none; background:var(--panel); }
nav .console:hover { border-color:var(--accent); }
main { max-width:780px; margin:0 auto; padding:28px 24px 80px; }
a { color:var(--accent-strong); text-decoration:none; }
a:hover { text-decoration:underline; }
h1 { font-size:30px; line-height:1.2; letter-spacing:-.02em; margin:.2rem 0 1rem; }
h2 { font-size:16px; font-weight:650; margin:2rem 0 .75rem; padding-bottom:6px;
  border-bottom:1px solid var(--border); }
h3 { font-size:15px; margin:1.4rem 0 .4rem; }
.sqrrl-wiki-page > blockquote { margin:0 0 1.5rem; padding:0; border:0; background:none;
  font-size:17px; line-height:1.6; color:var(--label); }
blockquote { margin:0 0 1rem; padding-left:12px; border-left:3px solid var(--border); color:var(--label); }
.aliases { color:var(--muted); font-size:13px; margin-top:-.5rem; }
code { background:var(--panel-2); padding:.1em .35em; border-radius:5px; font-size:.88em; overflow-wrap:anywhere; }
ul { padding-left:1.2rem; }
li { margin:.3rem 0; }
.sqrrl-wiki-page h2 + ul:has(a) { list-style:none; padding:0; display:flex; flex-wrap:wrap; gap:6px; }
.sqrrl-wiki-page h2 + ul:has(a) li { margin:0; padding:3px 11px; border:1px solid var(--border);
  border-radius:99px; background:var(--panel); font-size:13px; color:var(--muted); }
footer { margin-top:2.5rem; padding-top:.75rem; border-top:1px solid var(--border);
  color:var(--faint); font-size:12px; }
.kind { display:inline-block; font-size:11.5px; font-weight:500; color:var(--muted);
  background:var(--panel-2); border:1px solid var(--border); border-radius:99px;
  padding:0 .5rem; margin-left:.35rem; vertical-align:middle; }
.index li { list-style:none; margin:0; padding:6px 10px; border-radius:7px; }
.index li:hover { background:var(--panel-2); }
.index { padding:0; }
.empty { color:var(--muted); font-style:italic; }
table { border-collapse:collapse; width:100%; }
.body table td, .body table th { border:1px solid var(--border); padding:.4rem; }
`

/** Wraps rendered page HTML in a complete document: doctype, head, styles and
 *  a nav bar back to the scope index.
 *
 *  renderWikiPageHtml alone returns an <article> fragment, which is correct
 *  for embedding in a console but is not a page a browser can render on its
 *  own — no doctype, no charset, no styles. This is the browsable entry
 *  point; the fragment stays available for callers that supply their layout. */
export function renderWikiPageDocument(
	view: WikiPageView,
	opts: WikiDocumentOptions = {},
): string {
	const link: WikiLinkOptions = {
		basePath: opts.basePath ?? "/wiki",
		scope: opts.scope ?? view.scope,
		scopeRef: opts.scopeRef ?? view.scopeRef,
	}
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		// Slugs and titles can carry anything the ingest saw; never interpolate
		// them into the document unescaped.
		`<title>${htmlEscape(view.title)} — sqrrl wiki</title>`,
		// A wiki page is private knowledge: keep it out of any crawler that
		// can reach the host.
		'<meta name="robots" content="noindex, nofollow">',
		`<style>${BROWSE_CSS}</style>`,
		"</head>",
		"<body>",
		"<nav>",
		`<span class="brand"><span class="mark">m</span><a href="${htmlEscape(wikiIndexHref(link))}">sqrrl wiki</a></span>`,
		`<span class="scope">${htmlEscape(view.scope)}:${htmlEscape(view.scopeRef)}</span>`,
		consoleLink(opts, view.slug),
		"</nav>",
		"<main>",
		renderWikiPageHtml(view, link),
		"</main>",
		"</body>",
		"</html>",
	].join("\n")
}

/** One row of the scope index. */
export interface WikiIndexEntry {
	slug: string
	title: string
	kind: string
	updatedAt?: string
}

/** Renders the scope index: every page grouped by kind, each a link.
 *  This is what makes the wiki browsable rather than addressable — without an
 *  index a reader needs to know a slug before they can see anything. */
export function renderWikiIndexDocument(
	entries: WikiIndexEntry[],
	opts: WikiDocumentOptions = {},
): string {
	const link: WikiLinkOptions = {
		basePath: opts.basePath ?? "/wiki",
		scope: opts.scope,
		scopeRef: opts.scopeRef,
	}
	const byKind = new Map<string, WikiIndexEntry[]>()
	for (const e of entries) {
		const list = byKind.get(e.kind) ?? []
		list.push(e)
		byKind.set(e.kind, list)
	}
	const parts: string[] = []
	parts.push(
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${htmlEscape(opts.scope ?? "")}:${htmlEscape(opts.scopeRef ?? "")} — sqrrl wiki</title>`,
		'<meta name="robots" content="noindex, nofollow">',
		`<style>${BROWSE_CSS}</style>`,
		"</head>",
		"<body>",
		"<nav>",
		'<span class="brand"><span class="mark">m</span>sqrrl wiki</span>',
		`<span class="scope">${htmlEscape(opts.scope ?? "")}:${htmlEscape(opts.scopeRef ?? "")} · ${entries.length} page${entries.length === 1 ? "" : "s"}</span>`,
		consoleLink(opts),
		"</nav>",
		"<main>",
	)
	if (entries.length === 0) {
		parts.push(
			'<p class="empty">No pages in this scope yet.</p>',
			"</main>",
			"</body>",
			"</html>",
		)
		return parts.join("\n")
	}
	for (const kind of [...byKind.keys()].sort()) {
		const list = (byKind.get(kind) ?? [])
			.slice()
			.sort((a, b) => a.title.localeCompare(b.title))
		parts.push(
			`<h2>${htmlEscape(kind)} <span class="kind">${list.length}</span></h2>`,
		)
		parts.push('<ul class="index">')
		for (const e of list) {
			parts.push(
				`<li><a href="${htmlEscape(wikiPageHref(e.slug, link))}">${htmlEscape(e.title)}</a>` +
					` <span class="kind">${htmlEscape(e.slug)}</span></li>`,
			)
		}
		parts.push("</ul>")
	}
	parts.push("</main>", "</body>", "</html>")
	return parts.join("\n")
}
