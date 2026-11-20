// Links from the console into the browsable wiki (/wiki on the API origin).
//
// The console and the API are different origins — the console is served on
// :3040 and the wiki lives on the API's :3847 — so these are absolute URLs
// built from the same base the client calls, not Next routes.
//
// The shape must match wikiPageHref in @sqrrl/wiki-engine: each slug
// segment percent-encoded with "/" kept as a separator, and scope carried as
// query params. The browse route decodes the slug and answers 400 without a
// scope, so a link that drops either is a link that does not open.

/** Absolute URL for one wiki page. */
export function wikiPageUrl(
	apiBase: string,
	slug: string,
	scope: string,
	scopeRef: string,
): string {
	const base = apiBase.replace(/\/$/, "")
	const path = String(slug)
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")
	const params = new URLSearchParams({ scope, scopeRef })
	return `${base}/wiki/${path}?${params.toString()}`
}

/** Absolute URL for the scope's index page. */
export function wikiIndexUrl(
	apiBase: string,
	scope: string,
	scopeRef: string,
): string {
	const base = apiBase.replace(/\/$/, "")
	const params = new URLSearchParams({ scope, scopeRef })
	return `${base}/wiki/?${params.toString()}`
}
