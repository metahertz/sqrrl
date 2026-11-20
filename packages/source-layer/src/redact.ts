// Secret redaction for everything a connector sends.
//
// Notes and documents carry credentials: connection strings, API keys,
// tokens pasted for later. Found 2026-11-17 when three Apple Notes with
// MongoDB connection strings had been ingested verbatim into the wiki, its
// revisions, memongo and the embedding pipeline. Everything that enters
// Layer 1 or is distilled now passes through redactSecrets first, so a
// secret is never stored, embedded, or sent to an LLM.
//
// Patterns are deliberately specific (a known key shape, or an explicit
// credential assignment) rather than entropy-based: a false positive
// silently destroys note text, and the common leaks have recognizable
// shapes. Each match is replaced by [REDACTED:<kind>], keeping enough
// context (the user name, the host, the variable name) for the text to
// stay meaningful. Values are never logged; only counts per kind.

export interface RedactionResult {
	text: string
	/** Matches per kind, e.g. { "uri-password": 2 }. Empty when clean. */
	found: Record<string, number>
}

interface Rule {
	kind: string
	pattern: RegExp
	/** Builds the replacement from the match; default replaces it whole. */
	replace?: (match: string, ...groups: string[]) => string
}

const R = (kind: string) => `[REDACTED:${kind}]`

const RULES: Rule[] = [
	{
		// PEM private keys, whole block.
		kind: "private-key",
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{
		// scheme://user:password@host — keeps scheme, user and host.
		kind: "uri-password",
		// Skips an already-redacted value, so scanning redacted text finds 0.
		pattern:
			/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)(?!\[REDACTED)([^\s@/]+)(@)/gi,
		replace: (_m, head: string, _pw: string, at: string) =>
			`${head}${R("uri-password")}${at}`,
	},
	{ kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{
		kind: "github-token",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
	},
	{ kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "llm-api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{
		// Atlas Model API (al-) and Voyage (pa-) keys: long, so ordinary
		// hyphenated words never reach the length.
		kind: "voyage-key",
		pattern: /\b(?:al|pa)-[A-Za-z0-9_-]{40,}\b/g,
	},
	{
		kind: "jwt",
		pattern:
			/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	},
	{
		// Nextcloud app passwords: five groups of five.
		kind: "app-password",
		pattern:
			/\b[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}\b/g,
	},
	{
		// password = x, api_key: "x", secret=x, token: x — keeps the name.
		kind: "assignment",
		pattern:
			// [\w-]*? lets env-style names match (DB_PASSWORD, AWS_SECRET_ACCESS_KEY):
			// "_" is a word character, so \b alone never sits before PASSWORD.
			/\b([\w-]*?(?:pass(?:word|wd|code)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"']{6,})/gi,
		replace: (_m, head: string) => `${head}${R("assignment")}`,
	},
	{
		// db_user:Passw0rdXyz12 — a login and its password written as a pair,
		// found 2026-11-17 in a note the other rules missed. The name must
		// contain "user" or "login", and the value needs upper, lower and a
		// digit, 10+ chars, so "user:alice" or "login:Monday" never match.
		kind: "user-colon-password",
		pattern:
			/\b([\w.-]*(?:[Uu][Ss][Ee][Rr]|[Ll][Oo][Gg][Ii][Nn])[\w.-]*:)(?=[A-Za-z0-9!#$%^&*_+=-]*[A-Z])(?=[A-Za-z0-9!#$%^&*_+=-]*[a-z])(?=[A-Za-z0-9!#$%^&*_+=-]*\d)([A-Za-z0-9!#$%^&*_+=-]{10,})/g,
		replace: (_m, head: string) => `${head}${R("user-colon-password")}`,
	},
	{
		// user@Password1 with no domain after it — how the leaked note's
		// title was written. Needs upper, lower and a digit, 10+ chars, and
		// no "." after it, so name@example.com and name@company never match.
		kind: "user-at-password",
		pattern:
			/\b([\w.-]+@)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*\d)([A-Za-z0-9]{10,})\b(?!\.)/g,
		replace: (_m, head: string) => `${head}${R("user-at-password")}`,
	},
]

export function redactSecrets(text: string): RedactionResult {
	const found: Record<string, number> = {}
	let out = text
	for (const rule of RULES) {
		out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
			found[rule.kind] = (found[rule.kind] ?? 0) + 1
			// The callback gets (match, ...captures, offset, input); no rule
			// uses named groups, so the captures are all but the last two.
			const groups = rest.slice(0, -2) as string[]
			return rule.replace ? rule.replace(match, ...groups) : R(rule.kind)
		})
	}
	return { text: out, found }
}

/** Total matches in a result, for receipts and logs. */
export function redactionCount(found: Record<string, number>): number {
	return Object.values(found).reduce((a, b) => a + b, 0)
}

/** Adds one result's counts into a running tally. */
export function mergeRedactions(
	into: Record<string, number>,
	found: Record<string, number>,
): Record<string, number> {
	for (const [k, n] of Object.entries(found)) into[k] = (into[k] ?? 0) + n
	return into
}
