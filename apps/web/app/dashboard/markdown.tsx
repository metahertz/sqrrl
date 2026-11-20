// Minimal Markdown for page bodies, rendered as React elements.
//
// Never HTML strings: bodies are distilled from notes, files and invites,
// so they are untrusted, and React escapes everything it is given. Covers
// what the distillers and people write: headings, paragraphs, lists,
// quotes, fenced code, **bold**, *italic*, `code`, [links](https://...),
// bare URLs, and [[slug]] wiki links, which open in the console instead of
// leaving it. Links only to http(s) and mailto; anything else stays text.

import type { ReactNode } from "react"

export type WikiLinkHandler = (slug: string) => void

type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "para"; text: string }
	| { type: "list"; ordered: boolean; items: string[] }
	| { type: "quote"; text: string }
	| { type: "code"; text: string }

export function parseBlocks(md: string): Block[] {
	const lines = md.replace(/\r\n/g, "\n").split("\n")
	const blocks: Block[] = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		if (!line.trim()) {
			i++
			continue
		}
		if (line.trimStart().startsWith("```")) {
			const body: string[] = []
			i++
			while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
				body.push(lines[i])
				i++
			}
			i++
			blocks.push({ type: "code", text: body.join("\n") })
			continue
		}
		const heading = line.match(/^(#{1,6})\s+(.*)$/)
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1].length,
				text: heading[2].trim(),
			})
			i++
			continue
		}
		const listItem = /^\s*([-*+]|\d+[.)])\s+(.*)$/
		if (listItem.test(line)) {
			const ordered = /^\s*\d/.test(line)
			const items: string[] = []
			while (i < lines.length && listItem.test(lines[i])) {
				items.push((lines[i].match(listItem) as RegExpMatchArray)[2])
				i++
			}
			blocks.push({ type: "list", ordered, items })
			continue
		}
		if (line.startsWith(">")) {
			const body: string[] = []
			while (i < lines.length && lines[i].startsWith(">")) {
				body.push(lines[i].replace(/^>\s?/, ""))
				i++
			}
			blocks.push({ type: "quote", text: body.join(" ") })
			continue
		}
		const body: string[] = []
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^(#{1,6}\s|```|>)/.test(lines[i]) &&
			!listItem.test(lines[i])
		) {
			body.push(lines[i].trim())
			i++
		}
		blocks.push({ type: "para", text: body.join(" ") })
	}
	return blocks
}

const INLINE =
	/\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

function safeHref(url: string): string | undefined {
	return /^(https?:|mailto:)/i.test(url) ? url : undefined
}

export function renderInline(
	text: string,
	onWikiLink?: WikiLinkHandler,
): ReactNode[] {
	const out: ReactNode[] = []
	let last = 0
	for (const m of text.matchAll(INLINE)) {
		const at = m.index ?? 0
		if (at > last) out.push(text.slice(last, at))
		const key = `${at}`
		if (m[1] !== undefined) {
			const slug = m[1].split("|")[0].trim()
			const label = m[1].includes("|") ? m[1].split("|")[1].trim() : slug
			out.push(
				onWikiLink ? (
					<button
						key={key}
						type="button"
						className="mdb-link"
						onClick={() => onWikiLink(slug)}
					>
						{label}
					</button>
				) : (
					label
				),
			)
		} else if (m[2] !== undefined) {
			const href = safeHref(m[3])
			out.push(
				href ? (
					<a key={key} href={href} target="_blank" rel="noopener noreferrer">
						{m[2]}
					</a>
				) : (
					m[0]
				),
			)
		} else if (m[4] !== undefined) out.push(<code key={key}>{m[4]}</code>)
		else if (m[5] !== undefined || m[6] !== undefined)
			out.push(
				<strong key={key}>{renderInline(m[5] ?? m[6], onWikiLink)}</strong>,
			)
		else if (m[7] !== undefined || m[8] !== undefined)
			out.push(<em key={key}>{m[7] ?? m[8]}</em>)
		else if (m[9] !== undefined)
			out.push(
				<a key={key} href={m[9]} target="_blank" rel="noopener noreferrer">
					{m[9]}
				</a>,
			)
		last = at + m[0].length
	}
	if (last < text.length) out.push(text.slice(last))
	return out
}

export function Markdown({
	text,
	onWikiLink,
}: {
	text: string
	onWikiLink?: WikiLinkHandler
}) {
	const blocks = parseBlocks(text)
	return (
		<div className="mdb-prose">
			{blocks.map((b, i) => {
				const key = `${b.type}-${i}`
				switch (b.type) {
					case "heading": {
						const level = Math.min(b.level + 1, 4)
						const content = renderInline(b.text, onWikiLink)
						if (level === 2) return <h2 key={key}>{content}</h2>
						if (level === 3) return <h3 key={key}>{content}</h3>
						return <h4 key={key}>{content}</h4>
					}
					case "list":
						return b.ordered ? (
							<ol key={key}>
								{b.items.map((item, j) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: list items come from one immutable body and never reorder
									<li key={`${key}-${j}-${item.slice(0, 12)}`}>
										{renderInline(item, onWikiLink)}
									</li>
								))}
							</ol>
						) : (
							<ul key={key}>
								{b.items.map((item, j) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: list items come from one immutable body and never reorder
									<li key={`${key}-${j}-${item.slice(0, 12)}`}>
										{renderInline(item, onWikiLink)}
									</li>
								))}
							</ul>
						)
					case "quote":
						return (
							<blockquote key={key}>
								{renderInline(b.text, onWikiLink)}
							</blockquote>
						)
					case "code":
						return (
							<pre key={key}>
								<code>{b.text}</code>
							</pre>
						)
					default:
						return <p key={key}>{renderInline(b.text, onWikiLink)}</p>
				}
			})}
		</div>
	)
}
