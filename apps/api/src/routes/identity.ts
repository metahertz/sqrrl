// People identity: "same person?" suggestions and the one-off cleanup.
//
//   GET  /v1/wiki/identity/suggestions?scope=&scopeRef=&status=   (read)
//   POST /v1/wiki/identity/suggestions/:id/accept {scope, scopeRef, chosen}
//   POST /v1/wiki/identity/suggestions/:id/dismiss {scope, scopeRef}  (write)
//   POST /v1/wiki/identity/cleanup {scope, scopeRef, apply?}   (administer)
//   GET  /v1/wiki/identity/self?scope=&scopeRef=                (read)
//   POST /v1/wiki/identity/self {scope, scopeRef, personSlug, names, emails}
//        who "me" is; saving also merges hubs that are the owner and
//        settles questions about them (write)
//   POST /v1/wiki/identity/link {scope, scopeRef, slug, title?, edgeKind?,
//        people: [{name?, email?, create?, weight?}], maxNewPeople?}
//        links a page to the people in it through the shared resolver,
//        for connectors outside the API (Slack) (write)
//
// The cleanup without apply returns the plan (a dry run); with apply: true
// it carries out the certain parts and records the rest as suggestions.
// See packages/source-layer/src/people-cleanup.ts.

import {
	acceptIdentitySuggestion,
	applyPeopleCleanup,
	countIdentitySuggestions,
	dismissIdentitySuggestion,
	getSelfIdentity,
	IdentityDecisionError,
	LinkPeopleError,
	linkPeopleToPage,
	type IdentitySuggestionStatus,
	listIdentitySuggestions,
	loadCleanupInput,
	planPeopleCleanup,
	readLinkPeople,
	readSelfInput,
	SelfIdentityError,
	saveSelfIdentity,
} from "@sqrrl/source-layer"
import { Hono } from "hono"
import { type ApiEnvironment, getApiPrincipal } from "../api-context.js"
import { jsonError } from "../lib/errors.js"
import { getWikiStoreHandle } from "../wiki-store-runtime.js"
import { readScope } from "./raw.js"

const STATUSES: IdentitySuggestionStatus[] = [
	"pending",
	"accepted",
	"dismissed",
]

async function body(c: { req: { json(): Promise<unknown> } }) {
	return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<
		string,
		unknown
	>
}

const ERROR_STATUS = {
	NOT_FOUND: 404,
	NOT_PENDING: 409,
	BAD_CHOICE: 400,
	GONE: 409,
} as const

export function createIdentityRouter(): Hono<ApiEnvironment> {
	const r = new Hono<ApiEnvironment>()

	r.get("/suggestions", async (c) => {
		const scope = readScope({
			scope: c.req.query("scope"),
			scopeRef: c.req.query("scopeRef"),
		})
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const status = (c.req.query("status") ??
			"pending") as IdentitySuggestionStatus
		if (!STATUSES.includes(status))
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`status must be one of ${STATUSES.join("|")}`,
			)
		const handle = await getWikiStoreHandle()
		const [suggestions, counts] = await Promise.all([
			listIdentitySuggestions(handle, {
				...scope,
				status,
				limit: Number(c.req.query("limit") ?? "100") || 100,
			}),
			countIdentitySuggestions(handle, scope),
		])
		return c.json({ ...scope, status, suggestions, counts })
	})

	const decide = (action: "accept" | "dismiss") =>
		r.post(`/suggestions/:id/${action}`, async (c) => {
			const b = await body(c)
			const scope = readScope(b)
			if ("error" in scope)
				return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
			const chosen = typeof b.chosen === "string" ? b.chosen.trim() : ""
			if (action === "accept" && !chosen)
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"chosen (a person slug) is required",
				)
			const handle = await getWikiStoreHandle()
			const editor = { subjectId: getApiPrincipal(c).subjectId }
			try {
				if (action === "accept") {
					const s = await acceptIdentitySuggestion(handle, {
						...scope,
						id: c.req.param("id"),
						chosen,
						editor,
					})
					return c.json({ suggestion: s })
				}
				await dismissIdentitySuggestion(handle, {
					...scope,
					id: c.req.param("id"),
					editor,
				})
				return c.json({ dismissed: true })
			} catch (err) {
				if (err instanceof IdentityDecisionError)
					return jsonError(
						c,
						ERROR_STATUS[err.code],
						`IDENTITY_${err.code}`,
						err.message,
					)
				throw err
			}
		})
	decide("accept")
	decide("dismiss")

	r.get("/self", async (c) => {
		const scope = readScope({
			scope: c.req.query("scope"),
			scopeRef: c.req.query("scopeRef"),
		})
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const handle = await getWikiStoreHandle()
		return c.json({ ...scope, self: await getSelfIdentity(handle, scope) })
	})

	r.post("/self", async (c) => {
		const b = await body(c)
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		try {
			const input = readSelfInput(b)
			const handle = await getWikiStoreHandle()
			const out = await saveSelfIdentity(handle, {
				...scope,
				...input,
				editor: { subjectId: getApiPrincipal(c).subjectId },
			})
			return c.json({ ...scope, ...out })
		} catch (err) {
			if (err instanceof SelfIdentityError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			throw err
		}
	})

	r.post("/link", async (c) => {
		const b = await body(c)
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const slug = typeof b.slug === "string" ? b.slug.trim() : ""
		if (!slug) return jsonError(c, 400, "VALIDATION_ERROR", "slug is required")
		const edgeKind = typeof b.edgeKind === "string" ? b.edgeKind : undefined
		if (edgeKind && !/^[a-z_]{1,40}$/.test(edgeKind))
			return jsonError(c, 400, "VALIDATION_ERROR", "edgeKind is not valid")
		const max = Number(b.maxNewPeople)
		try {
			const people = readLinkPeople(b.people)
			const handle = await getWikiStoreHandle()
			const out = await linkPeopleToPage(handle, {
				...scope,
				slug,
				...(typeof b.title === "string" ? { title: b.title } : {}),
				...(edgeKind ? { edgeKind } : {}),
				...(Number.isInteger(max) && max >= 0 ? { maxNewPeople: max } : {}),
				people,
			})
			return c.json({ ...scope, slug, ...out })
		} catch (err) {
			if (err instanceof LinkPeopleError)
				return jsonError(c, 400, "VALIDATION_ERROR", err.message)
			throw err
		}
	})

	r.post("/cleanup", async (c) => {
		const b = await body(c)
		const scope = readScope(b)
		if ("error" in scope)
			return jsonError(c, 400, "VALIDATION_ERROR", scope.error)
		const handle = await getWikiStoreHandle()
		const input = await loadCleanupInput(handle, scope.scope, scope.scopeRef)
		const plan = planPeopleCleanup(input.hubs, input.links)
		if (b.apply !== true) return c.json({ ...scope, applied: false, plan })
		const result = await applyPeopleCleanup(handle, plan, {
			...scope,
			editor: { subjectId: getApiPrincipal(c).subjectId },
		})
		return c.json({ ...scope, applied: true, stats: plan.stats, result })
	})

	return r
}
