"use client"

import type { ReactNode } from "react"
import {
	type AnswerExtras,
	citationTarget,
	meetingCount,
	verificationSummary,
	windowLabel,
} from "./answer-details.js"
import { palette } from "./shared.js"

type LinkProps = {
	pageLink: (slug: string) => string
	openCitation: (slug: string) => (e: React.MouseEvent) => void
}

const chip: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	fontSize: 12,
	padding: "2px 8px",
	borderRadius: 999,
	background: "var(--panel-2)",
	color: palette.label,
	border: `1px solid ${palette.border}`,
}

function PageLink({
	slug,
	title,
	pageLink,
	openCitation,
	color = palette.accentDark,
}: LinkProps & { slug: string; title: string; color?: string }) {
	return (
		<a
			href={pageLink(slug)}
			onClick={openCitation(slug)}
			target="_blank"
			rel="noopener noreferrer"
			title={slug}
			style={{ color, textDecoration: "none" }}
		>
			{title}
		</a>
	)
}

/** Above the answer: the period asked about, who the names were taken to
 *  be, and the complete meeting counts from the calendar. */
export function AnswerContext({
	extras,
	...links
}: LinkProps & { extras: AnswerExtras }) {
	const items: ReactNode[] = []
	if (extras.window)
		items.push(
			<span key="window" style={chip} title="Time words in the question">
				🕑 {windowLabel(extras.window)}
			</span>,
		)
	for (const p of extras.people ?? []) {
		if ("slug" in p)
			items.push(
				<span key={`p-${p.text}`} style={chip} title="Who the question names">
					“{p.text}” → <PageLink slug={p.slug} title={p.title} {...links} />
				</span>,
			)
		else if (p.candidates.length)
			items.push(
				<span
					key={`p-${p.text}`}
					style={{ ...chip, borderColor: palette.warning }}
					title="This name fits more than one person"
				>
					“{p.text}” could be{" "}
					{p.candidates.map((c, i) => (
						<span key={c.slug}>
							{i ? " or " : ""}
							<PageLink slug={c.slug} title={c.title} {...links} />
						</span>
					))}
				</span>,
			)
	}
	const meetings = extras.meetings ?? []
	if (!items.length && !meetings.length) return null
	return (
		<div style={{ marginTop: 12 }}>
			{items.length ? (
				<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{items}</div>
			) : null}
			{meetings.length ? (
				<div
					style={{
						marginTop: items.length ? 8 : 0,
						padding: "8px 10px",
						borderRadius: 8,
						background: palette.panelAlt,
						fontSize: 12.5,
						color: palette.label,
					}}
				>
					<div
						style={{ fontSize: 11.5, color: palette.muted, marginBottom: 4 }}
					>
						From your calendar · complete list
						{extras.window ? `, ${extras.window.phrase}` : ""}
					</div>
					<div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
						{meetings.map((m) => (
							<span key={m.slug}>
								<PageLink
									slug={m.slug}
									title={m.title}
									color={palette.ink}
									{...links}
								/>{" "}
								<strong style={{ color: palette.ink }}>
									{meetingCount(m)}
								</strong>
							</span>
						))}
					</div>
				</div>
			) : null}
		</div>
	)
}

const toneColor = {
	ok: palette.success,
	changed: palette.warning,
	unchecked: palette.muted,
}

/** Below the answer: what the citation check found, and what it took out. */
export function AnswerVerification({
	extras,
	rawTitle,
	...links
}: LinkProps & {
	extras: AnswerExtras
	/** A raw item's title and source, for naming a removed citation. */
	rawTitle?: (id: string) => string | undefined
}) {
	const v = extras.verification
	const unknown = extras.droppedCitations ?? []
	if (!v && !unknown.length) return null
	const summary = v ? verificationSummary(v) : undefined
	const changed = v && "claims" in v ? v : undefined
	const hasDetail = Boolean(
		changed?.claimsRemoved.length ||
			changed?.citationsDropped.length ||
			unknown.length,
	)
	const head = (
		<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
			<span
				aria-hidden
				style={{
					width: 7,
					height: 7,
					borderRadius: 999,
					background: summary ? toneColor[summary.tone] : palette.warning,
				}}
			/>
			{summary?.text ?? "Citations not checked"}
			{unknown.length
				? ` · ${unknown.length} citation${unknown.length === 1 ? "" : "s"} to evidence it was never given removed`
				: ""}
		</span>
	)
	const style = { margin: "8px 0 0", fontSize: 12, color: palette.label }
	if (!hasDetail) return <p style={style}>{head}</p>
	return (
		<details style={style}>
			<summary style={{ cursor: "pointer" }}>{head}</summary>
			<div style={{ margin: "6px 0 0 13px", lineHeight: 1.5 }}>
				{changed?.claimsRemoved.length ? (
					<>
						<div style={{ color: palette.muted }}>
							Removed, because nothing it cited says so:
						</div>
						<ul style={{ margin: "2px 0 6px", paddingLeft: 18 }}>
							{changed.claimsRemoved.map((c) => (
								<li key={c} style={{ textDecoration: "line-through" }}>
									{c}
								</li>
							))}
						</ul>
					</>
				) : null}
				{changed?.citationsDropped.length ? (
					<>
						<div style={{ color: palette.muted }}>
							Citations removed from a sentence they did not support:
						</div>
						<ul style={{ margin: "2px 0 6px", paddingLeft: 18 }}>
							{changed.citationsDropped.map((d) => {
								const t = citationTarget(d.citation)
								return (
									<li key={`${d.claim}|${d.citation}`}>
										{t.kind === "page" ? (
											<PageLink slug={t.slug} title={t.slug} {...links} />
										) : (
											<span title={t.id}>
												{rawTitle?.(t.id) ?? "a source item"}
											</span>
										)}
										<span style={{ color: palette.muted }}>
											{" "}
											from “{d.claim}”
										</span>
									</li>
								)
							})}
						</ul>
					</>
				) : null}
				{unknown.length ? (
					<div style={{ color: palette.muted }}>
						Labels the model cited that were not in its evidence:{" "}
						{unknown.join(", ")}
					</div>
				) : null}
			</div>
		</details>
	)
}
