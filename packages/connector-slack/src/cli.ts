#!/usr/bin/env node
// sqrrl-slack-sync — one sync pass, then exit (run by a systemd timer).
//
//   --dry-run   list conversations and message counts per day; write nothing
//
// Exit codes: 0 all good · 1 some conversations failed · 2 configuration or
// authentication error.

// Old MDBRAIN_* settings still work (packages/lib/src/legacy-env.ts).
import "@sqrrl/lib/legacy-env"
import { SqrrlClient } from "@sqrrl/client"
import { ConfigError, loadConfigFromEnv } from "./config.js"
import { SlackConnector } from "./connector.js"
import { SlackApi, SlackApiError } from "./slack-api.js"
import { loadState } from "./state.js"

const AUTH_ERRORS: Record<string, string> = {
	invalid_auth:
		"the token is not valid; reinstall the app and copy the new User OAuth Token",
	not_authed: "no token was sent",
	token_revoked: "the token was revoked; reinstall the app",
	account_inactive: "the Slack account is deactivated",
	missing_scope:
		"the token lacks a scope this connector needs; add it under OAuth & Permissions and reinstall",
}

async function main(): Promise<number> {
	const dryRun = process.argv.includes("--dry-run")
	let config: ReturnType<typeof loadConfigFromEnv>
	try {
		config = loadConfigFromEnv()
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`config: ${err.message}`)
			return 2
		}
		throw err
	}
	const apiUrl = process.env.SQRRL_API_URL?.trim()
	const apiKey = process.env.SQRRL_API_KEY?.trim()
	if (!dryRun && (!apiUrl || !apiKey)) {
		console.error("config: SQRRL_API_URL and SQRRL_API_KEY are required")
		return 2
	}
	const client = new SqrrlClient({
		baseUrl: apiUrl ?? "http://127.0.0.1:3847",
		apiKey,
		defaultDeadlineMs: 120_000,
	})
	const slack = new SlackApi(
		config.token,
		config.apiBase ? { baseUrl: config.apiBase } : {},
	)
	const state = await loadState(config.stateFile)
	const started = Date.now()
	console.log(
		`slack-sync ${new Date().toISOString()} → ${config.scope}:${config.scopeRef} types=[${config.types.join(", ")}]${dryRun ? " (dry run)" : ""}`,
	)
	try {
		const connector = new SlackConnector(config, slack, client, state, {
			dryRun,
		})
		const s = await connector.run()
		console.log(
			`${s.conversations} conversation(s) read, ${s.skippedCold} quiet skipped · ${s.messages} message(s) · ` +
				`${s.daysSynced} day(s) synced, ${s.daysDistilled} distilled, ${s.retired} retired · ${s.peopleLinked} people link(s), ${s.peopleCreated} new · ` +
				`${Math.round((Date.now() - started) / 1000)}s`,
		)
		for (const e of s.errors) console.error(`  error: ${e}`)
		return s.errors.length ? 1 : 0
	} catch (err) {
		if (err instanceof SlackApiError && AUTH_ERRORS[err.code]) {
			console.error(`slack: ${err.code}: ${AUTH_ERRORS[err.code]}`)
			return 2
		}
		throw err
	}
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		console.error(
			err instanceof Error ? (err.stack ?? err.message) : String(err),
		)
		process.exit(1)
	},
)
