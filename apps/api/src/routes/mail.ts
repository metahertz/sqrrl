// POST /v1/raw/mail: mail exported from Mail.app into Layer 1 and the wiki
// (roadmap, Phase 6.3).
//
// The Mac sends messages as Mail.app has them; the parsing that needs
// judgement (bulk filtering, quote stripping, threading) is in
// @sqrrl/source-layer mail-parse.ts. Messages are upserted like any raw
// item (same content is a no-op), and every thread that gained or changed a
// message is distilled into its page. No window retirement: archiving moves
// mail out of the Inbox without deleting it. Write capability, scoped like
// /v1/raw/items.

import { Hono } from "hono"
import {
	distillEmailThreads,
	type EmailDistillSummary,
	type MailRecord,
	type MailSkipReason,
	mailToRawItem,
	RAW_ITEMS_MAX_BATCH,
	type RawItemInput,
	RawItemValidationError,
	type RunInTransaction,
	upsertRawItems,
} from "@sqrrl/source-layer"
import { type ApiEnvironment, getApiPrincipal } from "../api-context.js"
import { jsonError } from "../lib/errors.js"
import {
	createLlmGenerate,
	createTaskExtractor,
	LlmNotConfiguredError,
} from "../lib/llm-generate.js"
import { withWikiTransaction } from "../wiki-store-runtime.js"
import { rawHandle, readScope } from "./raw.js"

export function createMailRouter(): Hono<ApiEnvironment> {
	const mail = new Hono<ApiEnvironment>()

	mail.post("/", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scope = readScope(body)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		if (!Array.isArray(body.messages))
			return jsonError(c, 400, "VALIDATION_ERROR", "messages must be an array")
		const messages = body.messages as MailRecord[]
		if (messages.length > RAW_ITEMS_MAX_BATCH)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`at most ${RAW_ITEMS_MAX_BATCH} messages per call`,
			)
		if (
			messages.some(
				(m) => !m || (m.mailbox !== "inbox" && m.mailbox !== "sent"),
			)
		)
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				'each message needs mailbox "inbox" or "sent"',
			)
		const selfAddresses = Array.isArray(body.selfAddresses)
			? (body.selfAddresses as unknown[]).filter(
					(a): a is string => typeof a === "string",
				)
			: []

		const skipped: Record<MailSkipReason, number> = {
			bulk: 0,
			calendar: 0,
			"no-id": 0,
			empty: 0,
		}
		const items = new Map<string, { item: RawItemInput; root: string }>()
		for (const record of messages) {
			const out = mailToRawItem(record, selfAddresses)
			if ("skip" in out) skipped[out.skip]++
			// A message in both Inbox and Sent arrives twice; it is one item.
			else if (!items.has(out.item.sourceId)) items.set(out.item.sourceId, out)
		}

		try {
			const handle = await rawHandle()
			const inTx: RunInTransaction = (fn) =>
				withWikiTransaction((_h, session) => fn(session))
			const list = [...items.values()]
			const receipts = list.length
				? await upsertRawItems(
						handle,
						list.map((x) => x.item),
						{ ...scope, writer: getApiPrincipal(c).subjectId },
						inTx,
					)
				: []
			const counts = { created: 0, updated: 0, unchanged: 0 }
			for (const r of receipts) counts[r.status]++
			// redistill: every thread sent, e.g. after a run whose LLM calls
			// failed, since its stored messages now read as unchanged.
			const changedRoots = receipts
				.map((r, i) =>
					r.status === "unchanged" && body.redistill !== true
						? undefined
						: list[i].root,
				)
				.filter((r): r is string => Boolean(r))

			let threads: EmailDistillSummary | "llm-not-configured" | undefined
			if (changedRoots.length) {
				try {
					threads = await distillEmailThreads(
						handle,
						changedRoots,
						{
							llmGenerate: createLlmGenerate(),
							createExtractor: createTaskExtractor,
						},
						scope,
					)
				} catch (err) {
					if (!(err instanceof LlmNotConfiguredError)) throw err
					// Stored and searchable; distilled once an LLM is configured
					// and the messages are re-sent with a change.
					threads = "llm-not-configured"
				}
			}
			return c.json({
				...scope,
				received: messages.length,
				...counts,
				skipped,
				...(threads ? { threads } : {}),
			})
		} catch (err) {
			if (err instanceof RawItemValidationError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RAW_MAIL_FAILED", message)
		}
	})

	return mail
}
