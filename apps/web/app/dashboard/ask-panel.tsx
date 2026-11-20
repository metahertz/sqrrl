"use client"

import type { SqrrlClient } from "@sqrrl/client"
import { useCallback, useEffect, useState } from "react"
import {
	type AnswerCitation,
	rawFootnotes,
	splitAnswer,
} from "./answer-text.js"
import { buttonStyle, fieldStyle, palette } from "./shared.js"
import { wikiPageUrl } from "./wiki-links.js"

type AnswerResponse = {
	answer: string
	found: boolean
	citations: AnswerCitation[]
	pages: Array<{ slug: string; title: string; source: string; cited: boolean }>
	raw: Array<{ id: string; cited: boolean }>
	rerank?: string
	degraded?: string[]
	droppedCitations?: string[]
}

/** Ask the brain a question (POST /v1/wiki/answer). Page citations open the
 *  page in the browsable wiki; raw citations are numbered footnotes showing
 *  the quoted source text, since raw items have no page of their own. */
export function AskPanel({
	client,
	apiBase,
	scope,
	scopeRef,
	initialQuestion,
	onOpenSlug,
}: {
	client: SqrrlClient
	apiBase: string
	scope: string
	scopeRef: string
	/** Asked as soon as it is set (from the command palette). */
	initialQuestion?: string
	/** Opens a cited page in the console; without it citations open /wiki. */
	onOpenSlug?: (slug: string) => void
}) {
	const [question, setQuestion] = useState("")
	const [asking, setAsking] = useState(false)
	const [result, setResult] = useState<AnswerResponse | null>(null)
	const [error, setError] = useState<string | null>(null)

	const ask = useCallback(
		async (override?: string) => {
			const q = (override ?? question).trim()
			if (!q || asking) return
			setAsking(true)
			setError(null)
			setResult(null)
			try {
				setResult(
					(await client.wikiAnswer({
						query: q,
						scope,
						scopeRef,
					})) as AnswerResponse,
				)
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			} finally {
				setAsking(false)
			}
		},
		[client, question, scope, scopeRef, asking],
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: asks once per new palette question, not on every ask() identity change
	useEffect(() => {
		if (!initialQuestion) return
		setQuestion(initialQuestion)
		void ask(initialQuestion)
	}, [initialQuestion])

	const openCitation = (slug: string) => (e: React.MouseEvent) => {
		if (!onOpenSlug || e.metaKey || e.ctrlKey || e.button !== 0) return
		e.preventDefault()
		onOpenSlug(slug)
	}

	const pageLink = (slug: string) => wikiPageUrl(apiBase, slug, scope, scopeRef)
	const footnotes = result ? rawFootnotes(result.citations) : []
	const uncited = result?.pages.filter((p) => !p.cited) ?? []

	return (
		<div>
			<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
				<input
					aria-label="question"
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void ask()
					}}
					placeholder="Ask the brain a question…"
					style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
				/>
				<button
					type="button"
					onClick={() => ask()}
					disabled={asking || !question.trim()}
					style={buttonStyle("primary")}
				>
					{asking ? "Thinking…" : "Ask"}
				</button>
			</div>

			{error ? (
				<p style={{ color: palette.error, fontSize: 13, margin: "10px 0 0" }}>
					{error}
				</p>
			) : null}

			{result ? (
				<div style={{ marginTop: 12 }}>
					<p
						style={{
							margin: 0,
							fontSize: 14,
							lineHeight: 1.6,
							whiteSpace: "pre-wrap",
							color: result.found ? palette.ink : palette.muted,
						}}
					>
						{splitAnswer(result.answer, result.citations).map((s) =>
							s.type === "text" ? (
								<span key={s.at}>{s.text}</span>
							) : s.type === "page" ? (
								<a
									key={s.at}
									href={pageLink(s.slug)}
									onClick={openCitation(s.slug)}
									target="_blank"
									rel="noopener noreferrer"
									title={s.slug}
									style={{
										color: palette.accentDark,
										fontSize: 12,
										background: palette.panelAlt,
										borderRadius: 4,
										padding: "1px 5px",
										margin: "0 2px",
										textDecoration: "none",
										whiteSpace: "nowrap",
									}}
								>
									{s.title}
								</a>
							) : (
								<a
									key={s.at}
									href={`#raw-${s.id}`}
									title="Quoted source text, below"
									style={{
										color: palette.accentDark,
										fontSize: 11,
										verticalAlign: "super",
										textDecoration: "none",
										margin: "0 1px",
									}}
								>
									[{s.n}]
								</a>
							),
						)}
					</p>

					{footnotes.length ? (
						<ol
							style={{
								margin: "12px 0 0",
								paddingLeft: 22,
								fontSize: 12.5,
								color: palette.label,
							}}
						>
							{footnotes.map((c) => (
								<li key={c.id} id={`raw-${c.id}`} style={{ marginBottom: 6 }}>
									<span style={{ color: palette.muted }}>
										{c.source}
										{c.title ? ` · ${c.title}` : ""}
										{c.occurredAt ? ` · ${c.occurredAt.slice(0, 10)}` : ""}
									</span>
									<blockquote
										style={{
											margin: "2px 0 0",
											paddingLeft: 8,
											borderLeft: `2px solid ${palette.border}`,
											whiteSpace: "pre-wrap",
										}}
									>
										{c.quote}
									</blockquote>
								</li>
							))}
						</ol>
					) : null}

					<p style={{ margin: "10px 0 0", fontSize: 12, color: palette.muted }}>
						{result.found
							? `${result.citations.length} cited`
							: "Nothing stored answers this."}
						{" · searched "}
						{result.pages.length} pages and {result.raw.length} raw items
						{result.rerank === "on" ? ", reranked" : ""}
						{result.degraded?.length
							? ` · ${result.degraded.join(", ")} search unavailable`
							: ""}
						{result.droppedCitations?.length
							? ` · ${result.droppedCitations.length} unsupported citation(s) removed`
							: ""}
					</p>
					{result.found && uncited.length ? (
						<p
							style={{ margin: "4px 0 0", fontSize: 12, color: palette.muted }}
						>
							Also consulted:{" "}
							{uncited.map((p, i) => (
								<span key={p.slug}>
									{i ? ", " : ""}
									<a
										href={pageLink(p.slug)}
										onClick={openCitation(p.slug)}
										target="_blank"
										rel="noopener noreferrer"
										style={{ color: palette.muted }}
									>
										{p.title}
									</a>
								</span>
							))}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	)
}
