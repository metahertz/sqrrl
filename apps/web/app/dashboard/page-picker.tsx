"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { pageType, TYPE_META, type WikiPage } from "./shared.js"

/** Ranks pages for a typed query: title prefix, then word prefix, then
 *  anywhere in title or slug. Exported for tests and the command palette. */
export function rankPages(
	pages: WikiPage[],
	query: string,
	limit = 20,
): WikiPage[] {
	const q = query.trim().toLowerCase()
	if (!q) return pages.slice(0, limit)
	const scored: Array<{ p: WikiPage; s: number }> = []
	for (const p of pages) {
		const title = p.title.toLowerCase()
		let s = -1
		if (title.startsWith(q)) s = 0
		else if (title.split(/[\s/_-]+/).some((w) => w.startsWith(q))) s = 1
		else if (title.includes(q)) s = 2
		else if (p.slug.toLowerCase().includes(q)) s = 3
		else if ((p.aliases ?? []).some((a) => a.toLowerCase().includes(q))) s = 4
		if (s >= 0) scored.push({ p, s })
	}
	scored.sort((a, b) => a.s - b.s || a.p.title.length - b.p.title.length)
	return scored.slice(0, limit).map((x) => x.p)
}

/** Type-to-find a page. Arrow keys move, Enter picks, Escape closes. */
export function PagePicker({
	pages,
	onPick,
	placeholder = "Find a page…",
	autoFocus,
}: {
	pages: WikiPage[]
	onPick: (page: WikiPage) => void
	placeholder?: string
	autoFocus?: boolean
}) {
	const [query, setQuery] = useState("")
	const [open, setOpen] = useState(false)
	const [active, setActive] = useState(0)
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (autoFocus) input.current?.focus()
	}, [autoFocus])
	const results = useMemo(() => rankPages(pages, query, 12), [pages, query])

	const pick = (p: WikiPage) => {
		onPick(p)
		setQuery("")
		setOpen(false)
		setActive(0)
	}

	return (
		<div className="mdb-combobox">
			<input
				ref={input}
				className="mdb-input"
				style={{ width: "100%" }}
				value={query}
				placeholder={placeholder}
				role="combobox"
				aria-expanded={open}
				aria-autocomplete="list"
				onFocus={() => setOpen(true)}
				onBlur={() => setTimeout(() => setOpen(false), 120)}
				onChange={(e) => {
					setQuery(e.target.value)
					setActive(0)
					setOpen(true)
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault()
						setActive((a) => Math.min(a + 1, results.length - 1))
					} else if (e.key === "ArrowUp") {
						e.preventDefault()
						setActive((a) => Math.max(a - 1, 0))
					} else if (e.key === "Enter" && results[active]) {
						e.preventDefault()
						pick(results[active])
					} else if (e.key === "Escape") {
						setOpen(false)
						input.current?.blur()
					}
				}}
			/>
			{open && results.length > 0 ? (
				<div className="mdb-combobox-list" role="listbox">
					{results.map((p, i) => {
						const t = TYPE_META[pageType(p)]
						return (
							<div
								key={p.slug}
								role="option"
								tabIndex={-1}
								aria-selected={i === active}
								onMouseEnter={() => setActive(i)}
								onMouseDown={(e) => {
									e.preventDefault()
									pick(p)
								}}
							>
								<span className="mdb-dot" style={{ background: t.color }} />
								<span
									style={{
										flex: 1,
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
								>
									{p.title}
								</span>
								<span className="mdb-muted" style={{ fontSize: 11.5 }}>
									{t.label}
								</span>
							</div>
						)
					})}
				</div>
			) : null}
		</div>
	)
}
