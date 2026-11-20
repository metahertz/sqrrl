"use client"

// Settings → You: who the owner of this brain is. With it, your names and
// addresses in notes, mail and meetings resolve to your own person page
// instead of a guess (or a "Same person?" question), and answers call you
// "you". Saving also merges people pages that carry one of your addresses,
// or one of your names as the whole title, into yours.
// Data: GET/POST /v1/wiki/identity/self (apps/api/src/routes/identity.ts).

import type { SqrrlClient, SqrrlSelfIdentity } from "@sqrrl/client"
import { useEffect, useMemo, useState } from "react"
import { PagePicker } from "./page-picker.js"
import type { WikiPage } from "./shared.js"

const split = (text: string) =>
	text
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean)

/** Names to suggest for a person page: its title and the first name. */
export function suggestedNames(title: string): string[] {
	const t = title.trim()
	if (!t || t.includes("@")) return []
	const first = t.split(/\s+/)[0]
	return first && first !== t ? [first, t] : [t]
}

export function SelfIdentityPanel({
	client,
	scope,
	scopeRef,
	pages,
	onSaved,
}: {
	client: SqrrlClient
	scope: string
	scopeRef: string
	pages: WikiPage[]
	onSaved: () => void
}) {
	const [saved, setSaved] = useState<SqrrlSelfIdentity | null>(null)
	const [loaded, setLoaded] = useState(false)
	const [personSlug, setPersonSlug] = useState("")
	const [names, setNames] = useState("")
	const [emails, setEmails] = useState("")
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<{
		tone: "ok" | "danger"
		text: string
	} | null>(null)

	const people = useMemo(
		() => pages.filter((p) => p.slug.startsWith("people/")),
		[pages],
	)
	const person = people.find((p) => p.slug === personSlug)

	useEffect(() => {
		let live = true
		client
			.selfIdentity({ scope, scopeRef })
			.then(({ self }) => {
				if (!live) return
				setSaved(self)
				if (self) {
					setPersonSlug(self.personSlug)
					setNames(self.names.join(", "))
					setEmails(self.emails.join(", "))
				}
			})
			.catch(() => {})
			.finally(() => live && setLoaded(true))
		return () => {
			live = false
		}
	}, [client, scope, scopeRef])

	const pick = (p: WikiPage) => {
		setPersonSlug(p.slug)
		// Fill in what the page already knows; keep anything typed.
		setNames((n) =>
			[...new Set([...split(n), ...suggestedNames(p.title)])].join(", "),
		)
		setEmails((e) =>
			[...new Set([...split(e), ...(p.personCard?.emails ?? [])])].join(", "),
		)
		setMessage(null)
	}

	const save = async () => {
		setBusy(true)
		setMessage(null)
		try {
			const out = await client.setSelfIdentity({
				scope,
				scopeRef,
				personSlug,
				names: split(names),
				emails: split(emails),
			})
			setSaved(out.self)
			const { merged, questionsSettled } = out.applied
			setMessage({
				tone: "ok",
				text: `Saved. ${merged.length ? `Merged ${merged.length} ${merged.length === 1 ? "page" : "pages"} into yours` : "No other pages were yours"}${questionsSettled ? `; settled ${questionsSettled} “Same person?” ${questionsSettled === 1 ? "question" : "questions"}` : ""}.`,
			})
			onSaved()
		} catch (err) {
			setMessage({
				tone: "danger",
				text: err instanceof Error ? err.message : String(err),
			})
		} finally {
			setBusy(false)
		}
	}

	const dirty =
		!saved ||
		saved.personSlug !== personSlug ||
		saved.names.join(", ") !== split(names).join(", ") ||
		saved.emails.join(", ") !== split(emails).join(", ")

	return (
		<div className="mdb-card" style={{ marginBottom: 14 }}>
			<div className="mdb-card-head">
				You
				<span className="mdb-sub">who “me” is in this brain</span>
			</div>
			<div className="mdb-card-pad mdb-self">
				<p className="mdb-muted" style={{ marginTop: 0 }}>
					Your names and addresses in notes, mail and meetings resolve to your
					own page instead of a guess, and answers call you “you”. Saving also
					merges people pages that carry one of your addresses, or one of your
					names as their whole title, into yours.
				</p>
				<div className="mdb-self-field">
					<span>Your person page</span>
					{person ? (
						<span className="mdb-self-person">
							<strong>{person.title}</strong>
							<span className="mdb-slug">{person.slug}</span>
							<button
								type="button"
								className="mdb-btn mdb-btn-sm mdb-btn-ghost"
								onClick={() => setPersonSlug("")}
							>
								Change
							</button>
						</span>
					) : (
						<PagePicker
							pages={people}
							onPick={pick}
							placeholder={
								personSlug
									? `${personSlug} (not loaded)`
									: "Find your person page…"
							}
						/>
					)}
				</div>
				<label className="mdb-self-field">
					<span>Names you go by</span>
					<input
						className="mdb-input"
						value={names}
						placeholder="Matt, Matt Hollis"
						onChange={(e) => setNames(e.target.value)}
					/>
					<small className="mdb-muted">
						Comma-separated. A first name on its own (“Matt”) is you unless
						someone else by that name is on the same page.
					</small>
				</label>
				<label className="mdb-self-field">
					<span>Your email addresses</span>
					<input
						className="mdb-input"
						value={emails}
						placeholder="you@work.example, you@home.example"
						onChange={(e) => setEmails(e.target.value)}
					/>
				</label>
				<div className="mdb-self-actions">
					<button
						type="button"
						className="mdb-btn mdb-btn-primary"
						disabled={
							busy || !loaded || !personSlug || !split(names).length || !dirty
						}
						onClick={() => void save()}
					>
						{busy ? "Saving…" : "Save"}
					</button>
					{message ? (
						<span style={{ color: `var(--${message.tone})` }}>
							{message.text}
						</span>
					) : saved?.updatedAt ? (
						<span className="mdb-muted">
							Saved {new Date(saved.updatedAt).toLocaleString()}
						</span>
					) : null}
				</div>
			</div>
		</div>
	)
}
