import { ObjectId, type Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	decideSuggestion,
	getReviewState,
	recordSuggestion,
	type SuggestionEvidence,
} from "./store.js"

/** Just enough of two collections: equality filters, $set/$push/$inc/
 *  $addToSet/$setOnInsert, upsert. */
function fakeDb() {
	const colls = new Map<string, Document[]>()
	const matches = (d: Document, f: Document) =>
		Object.entries(f).every(([k, v]) =>
			v instanceof ObjectId ? String(d[k]) === String(v) : d[k] === v,
		)
	const apply = (d: Document, u: Document, inserting: boolean) => {
		Object.assign(d, u.$set ?? {})
		if (inserting) Object.assign(d, u.$setOnInsert ?? {})
		for (const [k, v] of Object.entries(
			(u.$push ?? {}) as Record<string, { $each: unknown[] }>,
		))
			d[k] = [...(d[k] ?? []), ...v.$each]
		for (const [k, v] of Object.entries(
			(u.$addToSet ?? {}) as Record<string, { $each: unknown[] }>,
		))
			d[k] = [...new Set([...(d[k] ?? []), ...v.$each])]
	}
	const db = {
		collection(name: string) {
			const docs = colls.get(name) ?? []
			colls.set(name, docs)
			return {
				async findOne(f: Document) {
					return docs.find((d) => matches(d, f)) ?? null
				},
				async insertOne(doc: Document) {
					const _id = new ObjectId()
					docs.push({ ...doc, _id })
					return { insertedId: _id }
				},
				async updateOne(f: Document, u: Document, o?: { upsert?: boolean }) {
					let d = docs.find((x) => matches(x, f))
					const inserting = !d
					if (!d) {
						if (!o?.upsert) return
						d = { ...f, _id: new ObjectId() }
						docs.push(d)
					}
					apply(d, u, inserting)
				},
			}
		},
	}
	return { handle: { db, prefix: "t_" } as never, colls }
}

const S = {
	scope: "workspace",
	scopeRef: "default",
	taskSlug: "tasks/me-send-deck",
	taskTitle: "Send the deck",
}
const ev = (key: string): SuggestionEvidence => ({
	key,
	kind: "raw",
	title: key,
	quote: "sent",
})

describe("recordSuggestion", () => {
	it("keeps one pending suggestion per task, merging evidence and keeping the stronger verdict", async () => {
		const { handle } = fakeDb()
		const a = await recordSuggestion(handle, {
			...S,
			proposed: "done",
			confidence: 0.75,
			rationale: "a",
			evidence: [ev("raw:1")],
		})
		const b = await recordSuggestion(handle, {
			...S,
			proposed: "done",
			confidence: 0.9,
			rationale: "b",
			evidence: [ev("raw:1"), ev("raw:2")],
		})
		expect(b?.id).toBe(a?.id)
		expect(b).toMatchObject({
			confidence: 0.9,
			rationale: "b",
			status: "pending",
		})
		expect(b?.evidence.map((e) => e.key)).toEqual(["raw:1", "raw:2"])
		// Nothing new and not stronger: unchanged.
		const c = await recordSuggestion(handle, {
			...S,
			proposed: "dropped",
			confidence: 0.8,
			rationale: "c",
			evidence: [ev("raw:2")],
		})
		expect(c).toMatchObject({ proposed: "done", confidence: 0.9 })
	})

	it("never brings back evidence the user dismissed", async () => {
		const { handle } = fakeDb()
		const s = await recordSuggestion(handle, {
			...S,
			proposed: "done",
			confidence: 0.8,
			rationale: "",
			evidence: [ev("raw:1")],
		})
		if (!s) throw new Error("no suggestion")
		await decideSuggestion(handle, s, { status: "dismissed", by: "me" })
		const state = await getReviewState(handle, S)
		expect(state?.dismissed).toEqual(["raw:1"])
		expect(state?.dismissedAt).toBeInstanceOf(Date)
		expect(
			await recordSuggestion(handle, {
				...S,
				proposed: "done",
				confidence: 0.99,
				rationale: "",
				evidence: [ev("raw:1")],
				dismissed: state?.dismissed,
			}),
		).toBeUndefined()
		// New evidence still can.
		const again = await recordSuggestion(handle, {
			...S,
			proposed: "done",
			confidence: 0.8,
			rationale: "",
			evidence: [ev("raw:1"), ev("raw:3")],
			dismissed: state?.dismissed,
		})
		expect(again?.evidence.map((e) => e.key)).toEqual(["raw:3"])
		expect(again?.id).not.toBe(s.id)
	})
})
