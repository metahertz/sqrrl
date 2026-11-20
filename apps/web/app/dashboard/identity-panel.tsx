"use client"

// "Same person?": names the brain could not place on its own. A page that
// says "Taylor" when two Taylors are known links to the first-name hub until
// you pick one; two pages that are probably one person wait for you to merge
// them. Picking moves that one link (or merges); "Neither" dismisses, and the
// question is not asked again.
// Data: GET /v1/wiki/identity/suggestions (apps/api/src/routes/identity.ts).

import type { SqrrlClient, SqrrlIdentitySuggestion } from "@sqrrl/client"
import { useState } from "react"
import type { QueuedDecision } from "./decision-queue.js"
import type { RunFn } from "./drawer-context.js"
import { IconUsers } from "./icons.js"

type Common = {
	client: SqrrlClient
	scope: string
	scopeRef: string
	run: RunFn
	/** Queues the answer; the question disappears at once. */
	decide: (d: QueuedDecision) => void
	busy: boolean
	openSlug: (slug: string) => void
}

const EDGE_WORDS: Record<string, string> = {
	owned_by: "owner",
	attended_by: "attendee",
	organized_by: "organizer",
	participant: "participant",
}

export function IdentityQuestion({
	q,
	...ctx
}: Common & { q: SqrrlIdentitySuggestion }) {
	const decide = (chosen?: string) => {
		const who = q.candidates.find((c) => c.slug === chosen)?.title
		ctx.decide({
			kind: "identity-suggestion",
			id: q.id,
			action: chosen ? "accept" : "dismiss",
			...(chosen ? { chosen } : {}),
			label: chosen
				? q.kind === "merge"
					? `Merged ${q.subjectTitle} into ${who ?? chosen}`
					: `${q.subjectTitle} is ${who ?? chosen}`
				: "Question dismissed",
			// A link moves on one page; a merge moves links on many, but the
			// pages that matter here are the two people and the linking page.
			affects: chosen
				? [chosen, q.subjectSlug, ...(q.fromSlug ? [q.fromSlug] : [])]
				: [],
		})
	}
	return (
		<div className="mdb-suggestion mdb-identity">
			<div className="mdb-suggestion-head">
				<IconUsers size={15} />
				{q.kind === "link" ? (
					<span>
						Which <strong>{q.subjectTitle}</strong>
						{q.edgeKind && EDGE_WORDS[q.edgeKind]
							? ` (${EDGE_WORDS[q.edgeKind]})`
							: ""}{" "}
						in{" "}
						<button
							type="button"
							className="mdb-link"
							onClick={() => q.fromSlug && ctx.openSlug(q.fromSlug)}
							title={q.fromSlug}
						>
							{q.fromTitle ?? q.fromSlug}
						</button>
						?
					</span>
				) : (
					<span>
						Is{" "}
						<button
							type="button"
							className="mdb-link"
							onClick={() => ctx.openSlug(q.subjectSlug)}
							title={q.subjectSlug}
						>
							{q.subjectTitle}
						</button>{" "}
						the same person as…
					</span>
				)}
			</div>
			<div className="mdb-identity-choices">
				{q.candidates.map((c) => (
					<button
						key={c.slug}
						type="button"
						className="mdb-btn mdb-btn-sm"
						title={`${q.kind === "merge" ? "Merge into" : "Link to"} ${c.slug}`}
						onClick={() => decide(c.slug)}
					>
						{c.reason || c.title}
					</button>
				))}
				<button
					type="button"
					className="mdb-btn mdb-btn-sm mdb-btn-ghost"
					onClick={() => decide()}
				>
					{q.kind === "merge" ? "No, different people" : "Neither"}
				</button>
			</div>
		</div>
	)
}

/** The Overview card: the first few questions, the rest on demand. */
export function IdentityQuestionsCard({
	questions,
	...ctx
}: Common & { questions: SqrrlIdentitySuggestion[] }) {
	const [all, setAll] = useState(false)
	if (!questions.length) return null
	const shown = all ? questions : questions.slice(0, 3)
	return (
		<div className="mdb-card" style={{ marginBottom: 16 }}>
			<div className="mdb-card-head">
				Same person?
				<span className="mdb-sub">{questions.length}</span>
				<span className="mdb-spacer" />
				{questions.length > 3 ? (
					<button
						type="button"
						className="mdb-btn mdb-btn-sm"
						onClick={() => setAll(!all)}
					>
						{all ? "Show fewer" : "See all"}
					</button>
				) : null}
			</div>
			<div className="mdb-suggestions-list">
				{shown.map((q) => (
					<IdentityQuestion key={q.id} q={q} {...ctx} />
				))}
			</div>
		</div>
	)
}
