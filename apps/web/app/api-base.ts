/** Resolves the sqrrl API base URL for browser calls.
 *
 *  NEXT_PUBLIC_SQRRL_API_URL is inlined at BUILD time, so a deployment that
 *  sets it as a runtime environment variable gets no effect at all — the
 *  bundle still contains whatever was present when it was compiled. A build
 *  made without it therefore hardcodes http://127.0.0.1:3847 into every
 *  client, and the console silently talks to the viewer's own machine instead
 *  of the server it was served from. On any host but localhost that looks
 *  like an API outage rather than a misconfiguration.
 *
 *  So: honour the build-time value when one was supplied, otherwise derive
 *  the origin from wherever the page was actually loaded. The same bundle
 *  then works over a LAN address, a DNS name, and an SSH tunnel with no
 *  rebuild.
 */
const DEFAULT_API_PORT = "3847"

export function resolveApiBaseUrl(): string {
	const configured = process.env.NEXT_PUBLIC_SQRRL_API_URL?.trim()
	if (configured) return configured
	// Prerendering and tests have no window; loopback is the right guess there.
	if (typeof window === "undefined") {
		return `http://127.0.0.1:${DEFAULT_API_PORT}`
	}
	const port =
		process.env.NEXT_PUBLIC_SQRRL_API_PORT?.trim() ?? DEFAULT_API_PORT
	return `${window.location.protocol}//${window.location.hostname}:${port}`
}
