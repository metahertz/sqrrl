// Text out of markup: HTML, and the XML inside Office Open XML and
// OpenDocument zips. Plain string work — no parser or converter needed.

import { strFromU8, unzipSync } from "fflate"

export type OfficeFormat = "docx" | "pptx" | "xlsx" | "odt" | "odp" | "ods"

export const OFFICE_MIME: Record<string, OfficeFormat> = {
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"pptx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
}

export const OFFICE_EXT: Record<string, OfficeFormat> = {
	docx: "docx",
	pptx: "pptx",
	xlsx: "xlsx",
	odt: "odt",
	odp: "odp",
	ods: "ods",
}

export function ext(name: string): string {
	const m = /\.([a-z0-9]+)$/i.exec(name)
	return m ? m[1].toLowerCase() : ""
}

export function baseMime(mimeType: string): string {
	return mimeType.toLowerCase().split(";")[0].trim()
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
}

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n =
				code[1] === "x" || code[1] === "X"
					? Number.parseInt(code.slice(2), 16)
					: Number.parseInt(code.slice(1), 10)
			return Number.isFinite(n) ? String.fromCodePoint(n) : m
		}
		return ENTITIES[code.toLowerCase()] ?? m
	})
}

/** Collapses the whitespace markup stripping leaves behind. */
export function tidy(s: string): string {
	return s
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
			.replace(/<\/(p|div|h\d|li|tr)>|<br\s*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
}

/** Strips markup after mapping block-level tags to line breaks. */
function xmlToText(xml: string, breaks: RegExp, tabs: RegExp): string {
	return decodeEntities(
		xml
			.replace(breaks, "\n")
			.replace(tabs, "\t")
			.replace(/<[^>]+>/g, ""),
	)
}

function numericOrder(a: string, b: string): number {
	const na = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0)
	const nb = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0)
	return na - nb
}

export function officeText(bytes: Uint8Array, format: OfficeFormat): string {
	const files = unzipSync(bytes, {
		filter: (f) =>
			f.name === "word/document.xml" ||
			/^ppt\/slides\/slide\d+\.xml$/.test(f.name) ||
			f.name === "xl/sharedStrings.xml" ||
			/^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) ||
			f.name === "content.xml",
	})
	const read = (name: string) => (files[name] ? strFromU8(files[name]) : "")

	if (format === "docx") {
		return xmlToText(
			read("word/document.xml"),
			/<\/w:p>|<w:br\s*\/>|<w:cr\s*\/>/g,
			/<w:tab\s*\/>/g,
		)
	}
	if (format === "pptx") {
		return Object.keys(files)
			.filter((n) => n.startsWith("ppt/slides/"))
			.sort(numericOrder)
			.map(
				(n, i) =>
					`## Slide ${i + 1}\n${xmlToText(read(n), /<\/a:p>|<a:br\s*\/>/g, /<a:tab\s*\/>/g)}`,
			)
			.join("\n\n")
	}
	if (format === "xlsx") {
		// Cells reference shared strings by index; inline strings and numbers
		// are carried in the cell itself. Rows become tab-separated lines.
		const shared = [
			...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g),
		].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")))
		return Object.keys(files)
			.filter((n) => n.startsWith("xl/worksheets/"))
			.sort(numericOrder)
			.map((n, i) => {
				const rows = [...read(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(
					(row) =>
						[...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
							.map((cell) => {
								const attrs = cell[1] ?? ""
								const inner = cell[2] ?? ""
								const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ""
								if (/\bt="s"/.test(attrs)) return shared[Number(v)] ?? ""
								if (/\bt="inlineStr"/.test(attrs)) {
									return decodeEntities(inner.replace(/<[^>]+>/g, ""))
								}
								return decodeEntities(v)
							})
							.join("\t"),
				)
				return `## Sheet ${i + 1}\n${rows.join("\n")}`
			})
			.join("\n\n")
	}
	// OpenDocument: one content.xml for text, slides and sheets alike.
	return xmlToText(
		read("content.xml").replace(/<\/draw:page>/g, "\n\n---\n\n"),
		/<\/text:p>|<\/text:h>|<text:line-break\s*\/>|<\/table:table-row>/g,
		/<text:tab\s*\/>|<\/table:table-cell>/g,
	)
}
