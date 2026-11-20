#!/usr/bin/env node
// sqrrl-nextcloud-sync — one sync pass, then exit. Scheduling is the job of
// a systemd timer (or cron), so a crashed run never leaves a wedged daemon.
//
// Exit codes: 0 all good · 1 some items failed or discovery was incomplete ·
// 2 configuration or authentication error.

// Old MDBRAIN_* settings still work (packages/lib/src/legacy-env.ts).
import "@sqrrl/lib/legacy-env"
import { SqrrlClient } from "@sqrrl/client"
import { HttpAiClient } from "@sqrrl/extract"
import { ConfigError, loadConfigFromEnv } from "./config.js"
import { NextcloudConnector } from "./connector.js"
import { loadState } from "./state.js"
import { probeTools } from "@sqrrl/extract"

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
	if (!apiUrl || !apiKey) {
		console.error("config: SQRRL_API_URL and SQRRL_API_KEY are required")
		return 2
	}
	// 10s is the client default; /v1/add and page reads are slower than that on a
	// loaded server. Maintenance passes its own, much longer, budget per call.
	const client = new SqrrlClient({
		baseUrl: apiUrl,
		apiKey,
		defaultDeadlineMs: 120_000,
	})
	const ai = new HttpAiClient({
		baseUrl: config.aiBaseUrl,
		apiKey: config.aiApiKey,
		visionModel: config.visionModel,
		transcriptionModel: config.transcriptionModel,
		transcriptionBaseUrl: config.transcriptionBaseUrl,
		transcriptionApiKey: config.transcriptionApiKey,
		timeoutMs: config.aiTimeoutMs,
		visionExtraBody: config.visionExtraBody,
		verifyRetries: config.verifyRetries,
	})
	const state = await loadState(config.stateFile)
	const tools = await probeTools(config.ffmpegPath)
	const connector = new NextcloudConnector(config, client, ai, state, {
		tools,
	})

	const auth = await connector.authenticate()
	if (!auth.authenticated) {
		console.error(`nextcloud: ${auth.error}`)
		return 2
	}
	console.log(
		`${config.baseUrl} as ${config.user} → ${config.scope}:${config.scopeRef}` +
			`  folders=[${config.folders.join(", ")}] tags=[${config.tags.join(", ")}]` +
			` notes=[${config.noteCategories.join(", ")}]`,
	)
	console.log(
		`  tools: ffmpeg=${tools.ffmpeg ? "yes" : "NO"} pdf-render=${tools.canvas ? (tools.pdfFonts ? "yes" : "yes (no standard fonts)") : "NO"} heic=${tools.heic ? "yes" : "NO"} verify=${config.verifyImages ? (tools.stamps ? "on" : "NO FONT") : "off"}` +
			`  models: vision=${config.visionModel || "NONE"} transcription=${config.transcriptionModel || "NONE"}`,
	)
	if (!config.visionModel) {
		console.log(
			"  images and scanned pages are parked until NEXTCLOUD_VISION_MODEL is set",
		)
	}
	if (!config.transcriptionModel) {
		console.log(
			"  recordings are parked until NEXTCLOUD_TRANSCRIPTION_MODEL is set",
		)
	}

	if (dryRun) {
		const found = await connector.discover()
		for (const s of found.sources) {
			console.log(
				`  would sync  ${s.id}  ${String(s.metadata?.location ?? "")}`,
			)
		}
		console.log(`\n${found.sources.length} item(s) would be synced`)
		return 0
	}

	const started = Date.now()
	const report = await connector.run()
	for (const s of report.skipped)
		console.log(`  skipped  ${s.title}: ${s.reason}`)
	for (const w of report.waiting)
		console.log(`  parked   ${w.title}: ${w.reason}`)
	for (const f of report.failed) {
		console.log(
			`  FAILED   ${f.title}: ${f.reason}${f.retryable ? " (will retry)" : ""}`,
		)
	}
	for (const e of report.discoveryErrors) console.log(`  DISCOVERY ${e}`)
	if (report.discoveryErrors.length > 0) {
		console.log("  stale marking was skipped for the incomplete source(s)")
	}
	const secs = Math.round((Date.now() - started) / 1000)
	console.log(
		`\n${report.discovered} discovered, ${report.changed} changed, ${report.synced} synced, ` +
			`${report.skipped.length} skipped, ${report.waiting.length} parked, ${report.failed.length} failed, ` +
			`${report.markedStale} marked stale, ${report.restored} restored in ${secs}s`,
	)
	return report.failed.length > 0 || report.discoveryErrors.length > 0 ? 1 : 0
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(
			err instanceof Error ? (err.stack ?? err.message) : String(err),
		)
		process.exit(1)
	},
)
