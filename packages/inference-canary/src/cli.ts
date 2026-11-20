#!/usr/bin/env node
// sqrrl-inference-canary — probe shared inference nodes for
// cross-request contamination, print a per-backend table, append a JSON
// line to a report file, and exit 1 if any answer belonged to another
// request (3 when every probe errored, 2 on bad configuration).
//
//   CANARY_BASE_URL        OpenAI-compatible endpoint (default SQRRL_LLM_BASE_URL)
//   CANARY_API_KEY         (default SQRRL_LLM_API_KEY)
//   CANARY_VISION_MODELS   comma-separated
//   CANARY_TEXT_MODELS     comma-separated
//   CANARY_ROUNDS          vision probes per model and size (default 4)
//   CANARY_CONCURRENCY     simultaneous text requests per round (default 6)
//   CANARY_REPORT_FILE     JSONL file to append to (optional)
//   CANARY_SIZES           vision image sizes, WxH[:jpeg] of the drawn
//                          shape; a 96 px stamp band is added below
//                          (default 1024x416, sent as 1024x512 = 512
//                          image tokens). Add a size over one llama.cpp
//                          micro-batch, e.g. 2048x928, to guard the
//                          --ubatch-size fix on the vision nodes.
//   CANARY_EXTRA_BODY      JSON merged into requests

// Old MDBRAIN_* settings still work (packages/lib/src/legacy-env.ts).
import "@sqrrl/lib/legacy-env"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { ensureStampFont } from "@sqrrl/connector-nextcloud"
import {
	DEFAULT_VISION_SIZE,
	type Endpoint,
	type ProbeResult,
	parseSizes,
	summarize,
	textProbe,
	type VisionSize,
	visionProbe,
} from "./probes.js"

const list = (raw?: string) =>
	(raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)

async function main(): Promise<number> {
	const env = process.env
	const baseUrl = (env.CANARY_BASE_URL || env.SQRRL_LLM_BASE_URL || "").replace(
		/\/+$/,
		"",
	)
	const apiKey = env.CANARY_API_KEY || env.SQRRL_LLM_API_KEY || ""
	const visionModels = list(env.CANARY_VISION_MODELS)
	const textModels = list(env.CANARY_TEXT_MODELS)
	if (!baseUrl || (visionModels.length === 0 && textModels.length === 0)) {
		console.error(
			"config: set CANARY_BASE_URL and CANARY_VISION_MODELS and/or CANARY_TEXT_MODELS",
		)
		return 2
	}
	if (visionModels.length > 0 && !(await ensureStampFont())) {
		console.error("config: no font available for verification stamps")
		return 2
	}
	let extraBody: Record<string, unknown> = {}
	if (env.CANARY_EXTRA_BODY) {
		try {
			extraBody = JSON.parse(env.CANARY_EXTRA_BODY)
		} catch {
			console.error("config: CANARY_EXTRA_BODY must be JSON")
			return 2
		}
	}
	const rounds = Number(env.CANARY_ROUNDS || 4)
	let sizes: VisionSize[]
	try {
		sizes = env.CANARY_SIZES
			? parseSizes(env.CANARY_SIZES)
			: [DEFAULT_VISION_SIZE]
	} catch (err) {
		console.error(`config: CANARY_SIZES: ${(err as Error).message}`)
		return 2
	}
	const concurrency = Number(env.CANARY_CONCURRENCY || 6)
	const ep: Endpoint = { baseUrl, apiKey, extraBody }

	const results: ProbeResult[] = []
	const show = (r: ProbeResult) =>
		console.log(
			`  ${r.verdict === "ok" ? "ok  " : r.verdict.toUpperCase().padEnd(4)}  ${r.kind.padEnd(6)} ${r.model} @ ${r.backend}  ${r.variant}  ${r.ms}ms${r.cacheN !== undefined ? ` cache_n=${r.cacheN}` : ""}${r.verdict === "ok" ? "" : `  ${r.detail}`}`,
		)
	const history = new Map<string, Set<string>>()
	for (const model of visionModels) {
		for (let i = 0; i < rounds; i++) {
			for (const size of sizes) {
				const r = await visionProbe(ep, model, size, history)
				results.push(r)
				show(r)
			}
		}
	}
	for (const model of textModels) {
		for (let i = 0; i < Math.max(1, Math.round(rounds / 2)); i++) {
			for (const r of await textProbe(ep, model, concurrency)) {
				results.push(r)
				show(r)
			}
		}
	}

	const summary = summarize(results)
	console.log("\nby backend:")
	for (const [key, v] of Object.entries(summary.byBackend)) {
		console.log(
			`  ${key.padEnd(40)} ok=${v.ok} stamp-misread=${v["stamp-misread"]} partial-image=${v["partial-image"]} cross-request=${v["cross-request"]} error=${v.error}`,
		)
	}
	if (env.CANARY_REPORT_FILE) {
		await mkdir(dirname(env.CANARY_REPORT_FILE), { recursive: true })
		await appendFile(
			env.CANARY_REPORT_FILE,
			`${JSON.stringify({ at: summary.at, byBackend: summary.byBackend, contaminated: summary.contaminated, failures: results.filter((r) => r.verdict !== "ok") })}\n`,
		)
	}
	if (summary.contaminated) {
		console.log(
			"\nCONTAMINATION: at least one answer was built from another request's input",
		)
		return 1
	}
	if (results.every((r) => r.verdict === "error")) return 3
	console.log("\nno cross-request answers seen")
	return 0
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : err)
		process.exit(3)
	},
)
