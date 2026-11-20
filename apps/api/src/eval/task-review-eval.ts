// Task-review judge evaluation against the live LLM (opt-in, not a unit
// test): runs every case in task-review-cases.ts through the same prompt,
// model call and grounding check as production, then reports precision
// (of suggestions made, how many were right) and recall. Exits non-zero
// below the gate, which must pass before the nightly sweep is enabled.
//
//   bun run eval:task-review   (needs the LLM env, as the API does)

import {
	buildJudgePrompt,
	type JudgeEvidence,
	parseJudgeReply,
	TASK_JUDGE_PROMPT,
} from "@sqrrl/source-layer"
import { createTaskJudge } from "../lib/llm-generate.js"
import { CASES, type Expect } from "./task-review-cases.js"

const GATE = Number(process.env.TASK_REVIEW_EVAL_MIN_PRECISION ?? "0.85")
const MIN_CONFIDENCE = Number(
	process.env.SQRRL_TASK_REVIEW_MIN_CONFIDENCE ?? "0.7",
)
const TODAY = "2026-11-18"

const judge = createTaskJudge()
let tp = 0
let fp = 0
let fn = 0
let errors = 0
for (const c of CASES) {
	const evidence: JudgeEvidence[] = c.evidence.map((e, i) => ({
		key: e.slug ? `page:${e.slug}` : `raw:case-${i}`,
		kind: e.kind ?? "raw",
		...e,
	}))
	let got: Expect = "none"
	try {
		const reply = await judge(
			TASK_JUDGE_PROMPT,
			buildJudgePrompt(c.task, evidence, TODAY),
		)
		got = parseJudgeReply(reply, evidence, MIN_CONFIDENCE)?.proposed ?? "none"
	} catch (err) {
		errors++
		console.log(`ERR   ${c.name}: ${err instanceof Error ? err.message : err}`)
		continue
	}
	const ok = got === c.expect
	if (got !== "none") ok ? tp++ : fp++
	if (c.expect !== "none" && !ok) fn++
	console.log(
		`${ok ? "ok  " : "MISS"}  ${c.name.padEnd(28)} expected ${c.expect.padEnd(7)} got ${got}`,
	)
}
const precision = tp + fp ? tp / (tp + fp) : 1
const recall = tp + fn ? tp / (tp + fn) : 1
console.log(
	`\n${CASES.length} cases, ${errors} errors: precision ${precision.toFixed(2)} (gate ${GATE}), recall ${recall.toFixed(2)}`,
)
process.exit(precision >= GATE && errors === 0 ? 0 : 1)
