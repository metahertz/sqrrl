// Remembering the API key between visits.
//
// The console and the API are different origins (:3040 and :3847), so this
// cookie is never sent to the API — the key still travels as an Authorization
// header the client sets. The cookie is only this browser's memory of what was
// typed, and it has to be readable by script for that, so no HttpOnly.
//
// It IS sent to the Next.js server on :3040 with every page and asset request,
// which browser storage would not be. That costs nothing today because the
// console is statically served, but it is the reason to keep the cookie
// short-lived and scoped rather than permanent.

const COOKIE = "mdbrain_api_key"
/** Two weeks. Long enough to stop retyping it every session, short enough that
 *  a forgotten browser does not hold a master key indefinitely. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14

/** Reads one cookie out of a raw `document.cookie` string. Exported for the
 *  tests; callers want `loadApiKey`. */
export function parseCookie(raw: string, name = COOKIE): string {
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=")
		if (eq < 0) continue
		if (part.slice(0, eq).trim() !== name) continue
		try {
			return decodeURIComponent(part.slice(eq + 1).trim())
		} catch {
			// A value that is not valid percent-encoding was not written by us.
			return ""
		}
	}
	return ""
}

/** Builds the `document.cookie` assignment. `secure` is passed in rather than
 *  read from location so the tests can cover both, and because the console is
 *  served over plain http on the LAN today — setting Secure there would make
 *  the cookie silently never persist. */
export function serializeCookie(
	value: string,
	{ secure, maxAge = MAX_AGE_SECONDS }: { secure: boolean; maxAge?: number },
	name = COOKIE,
): string {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		"path=/",
		`max-age=${maxAge}`,
		// Strict, not Lax: nothing should carry this cookie on a navigation
		// that started anywhere else.
		"SameSite=Strict",
	]
	if (secure) parts.push("Secure")
	return parts.join("; ")
}

/** Cookies can throw or be absent — a prerender has no document at all, and a
 *  browser with site data blocked throws on access — so every call site treats
 *  "no remembered key" as the normal case rather than an error. */
export function loadApiKey(): string {
	if (typeof document === "undefined") return ""
	try {
		return parseCookie(document.cookie)
	} catch {
		return ""
	}
}

export function saveApiKey(value: string): void {
	if (typeof document === "undefined") return
	try {
		// biome-ignore lint/suspicious/noDocumentCookie: the async CookieStore API is not available in Safari or Firefox, and loadApiKey has to read synchronously during the mount effect.
		document.cookie = serializeCookie(value, {
			secure: location.protocol === "https:",
		})
	} catch {
		// Storage blocked; the key still works for this session.
	}
}

export function clearApiKey(): void {
	if (typeof document === "undefined") return
	try {
		// biome-ignore lint/suspicious/noDocumentCookie: the async CookieStore API is not available in Safari or Firefox, and loadApiKey has to read synchronously during the mount effect.
		document.cookie = serializeCookie("", {
			secure: location.protocol === "https:",
			maxAge: 0,
		})
	} catch {
		// Nothing to do: if it cannot be written it cannot have been stored.
	}
}
