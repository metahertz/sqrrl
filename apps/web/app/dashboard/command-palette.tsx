"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { rankPages } from "./page-picker.js"
import { pageType, TYPE_META, type WikiPage } from "./shared.js"

export type PaletteAction = {
	id: string
	label: string
	hint?: string
	run: () => void
}

/** ⌘K / Ctrl+K: jump to any page or view, or ask the brain. */
export function CommandPalette({
	pages,
	actions,
	onOpen,
	onAsk,
	onClose,
}: {
	pages: WikiPage[]
	actions: PaletteAction[]
	onOpen: (p: WikiPage) => void
	onAsk: (question: string) => void
	onClose: () => void
}) {
	const [query, setQuery] = useState("")
	const [active, setActive] = useState(0)
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => input.current?.focus(), [])

	const items = useMemo(() => {
		const q = query.trim().toLowerCase()
		const acts = actions.filter((a) => !q || a.label.toLowerCase().includes(q))
		const found = q ? rankPages(pages, q, 10) : []
		const out: Array<{
			key: string
			group: string
			label: string
			hint?: string
			color?: string
			run: () => void
		}> = []
		for (const p of found) {
			const t = TYPE_META[pageType(p)]
			out.push({
				key: p.slug,
				group: "Pages",
				label: p.title,
				hint: t.label,
				color: t.color,
				run: () => onOpen(p),
			})
		}
		if (q.length > 2)
			out.push({
				key: "ask",
				group: "Ask",
				label: `Ask the brain: “${query.trim()}”`,
				run: () => onAsk(query.trim()),
			})
		for (const a of acts)
			out.push({
				key: a.id,
				group: "Go to",
				label: a.label,
				hint: a.hint,
				run: a.run,
			})
		return out
	}, [query, pages, actions, onOpen, onAsk])

	const choose = (i: number) => {
		const item = items[i]
		if (!item) return
		item.run()
		onClose()
	}

	let lastGroup = ""
	return (
		<>
			<div className="mdb-scrim" onClick={onClose} aria-hidden="true" />
			<div
				className="mdb-dialog"
				role="dialog"
				aria-label="Command palette"
				style={{ top: "14vh" }}
			>
				<input
					className="mdb-palette-input"
					ref={input}
					placeholder="Search pages, jump to a view, or ask a question…"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value)
						setActive(0)
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") {
							e.preventDefault()
							setActive((a) => Math.min(a + 1, items.length - 1))
						} else if (e.key === "ArrowUp") {
							e.preventDefault()
							setActive((a) => Math.max(a - 1, 0))
						} else if (e.key === "Enter") {
							e.preventDefault()
							choose(active)
						} else if (e.key === "Escape") onClose()
					}}
				/>
				<div className="mdb-palette-list" role="listbox">
					{items.map((item, i) => {
						const header = item.group !== lastGroup ? item.group : null
						lastGroup = item.group
						return (
							<div key={item.key}>
								{header ? (
									<div className="mdb-palette-group">{header}</div>
								) : null}
								<div
									className="mdb-palette-item"
									role="option"
									aria-selected={i === active}
									tabIndex={-1}
									onMouseEnter={() => setActive(i)}
									onClick={() => choose(i)}
									onKeyDown={(e) => e.key === "Enter" && choose(i)}
								>
									{item.color ? (
										<span
											className="mdb-dot"
											style={{ background: item.color }}
										/>
									) : null}
									<span
										style={{
											flex: 1,
											minWidth: 0,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{item.label}
									</span>
									{item.hint ? (
										<span className="mdb-muted" style={{ fontSize: 12 }}>
											{item.hint}
										</span>
									) : null}
								</div>
							</div>
						)
					})}
					{items.length === 0 ? (
						<div className="mdb-empty">No matches.</div>
					) : null}
				</div>
			</div>
		</>
	)
}
