// Connector settings, all from the environment (bin/slack-sync.sh sources
// env/common.env and secrets/slack.secrets).

export class ConfigError extends Error {}

export const CONVERSATION_TYPES = [
	"public_channel",
	"private_channel",
	"mpim",
	"im",
] as const
export type ConversationType = (typeof CONVERSATION_TYPES)[number]

export interface SlackConfig {
	token: string
	scope: string
	scopeRef: string
	types: ConversationType[]
	/** Channel names to include (without #); empty means all. DMs are not
	 *  filtered by this list. */
	channels: string[]
	/** Channel names to leave out (without #). */
	excludeChannels: string[]
	/** How far back the first sync of a conversation reaches. */
	backfillDays: number
	/** How many recent days every run re-reads, to catch edits and deletes. */
	refreshDays: number
	/** How old a thread may be and still have new replies picked up. */
	threadLookbackDays: number
	/** A conversation silent this long is checked at most once a day. */
	coldAfterDays: number
	timeZone: string
	/** Conversation-days with less text than this stay in Layer 1 only
	 *  (searchable) and get no wiki page: "ok", "thanks" are not knowledge. */
	distillMinChars: number
	stateFile: string
	wikiTimeoutMs: number
	apiBase?: string
}

function list(v: string | undefined): string[] {
	return (v ?? "")
		.split(",")
		.map((s) => s.trim().replace(/^#/, ""))
		.filter(Boolean)
}

function int(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	min = 0,
): number {
	const raw = env[name]?.trim()
	if (!raw) return fallback
	const n = Number(raw)
	if (!Number.isInteger(n) || n < min)
		throw new ConfigError(`${name} must be an integer >= ${min}, got "${raw}"`)
	return n
}

export function loadConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): SlackConfig {
	const token = env.SLACK_USER_TOKEN?.trim()
	if (!token)
		throw new ConfigError("SLACK_USER_TOKEN is not set (secrets/slack.secrets)")
	if (!token.startsWith("xoxp-"))
		throw new ConfigError(
			"SLACK_USER_TOKEN must be a user token (xoxp-...), not a bot or app token",
		)
	const types = list(env.SLACK_TYPES)
	const bad = types.filter(
		(t) => !(CONVERSATION_TYPES as readonly string[]).includes(t),
	)
	if (bad.length)
		throw new ConfigError(`SLACK_TYPES has unknown types: ${bad.join(", ")}`)
	const timeZone = env.SLACK_TIMEZONE?.trim() || "Europe/London"
	try {
		new Intl.DateTimeFormat("en", { timeZone })
	} catch {
		throw new ConfigError(`SLACK_TIMEZONE "${timeZone}" is not a time zone`)
	}
	return {
		token,
		scope: env.SLACK_SCOPE?.trim() || "workspace",
		scopeRef: env.SLACK_SCOPE_REF?.trim() || "default",
		types: (types.length
			? types
			: [...CONVERSATION_TYPES]) as ConversationType[],
		channels: list(env.SLACK_CHANNELS),
		excludeChannels: list(env.SLACK_EXCLUDE_CHANNELS),
		backfillDays: int(env, "SLACK_BACKFILL_DAYS", 30, 1),
		refreshDays: int(env, "SLACK_REFRESH_DAYS", 7, 1),
		threadLookbackDays: int(env, "SLACK_THREAD_LOOKBACK_DAYS", 30, 1),
		coldAfterDays: int(env, "SLACK_COLD_AFTER_DAYS", 14, 1),
		timeZone,
		distillMinChars: int(env, "SLACK_DISTILL_MIN_CHARS", 200),
		stateFile: env.SLACK_STATE_FILE?.trim() || "connectors/slack/state.json",
		wikiTimeoutMs: int(env, "SLACK_WIKI_TIMEOUT_MS", 1_800_000, 1000),
		...(env.SLACK_API_BASE?.trim()
			? { apiBase: env.SLACK_API_BASE.trim() }
			: {}),
	}
}
