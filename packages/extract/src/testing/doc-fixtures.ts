// Minimal but valid documents for extraction tests: text PDFs, scanned
// (image-only) PDFs, DOCX and a 1px PNG. Moved here from the Nextcloud
// connector's fake server with the extraction code they exercise.

import { strToU8, zipSync, zlibSync } from "fflate"

/** Builds a minimal but valid PDF. `null` pages have no text layer. */
export function makePdf(pages: Array<string | null>): Uint8Array {
	const objs: string[] = []
	const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")
	objs.push("<< /Type /Catalog /Pages 2 0 R >>")
	objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
	const fontObj = 3 + pages.length * 2
	pages.forEach((text, i) => {
		const stream =
			text === null
				? ""
				: `BT /F1 18 Tf 72 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`
		objs.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
		)
		objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
	})
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	let out = "%PDF-1.4\n"
	const offsets: number[] = []
	objs.forEach((o, i) => {
		offsets.push(out.length)
		out += `${i + 1} 0 obj\n${o}\nendobj\n`
	})
	const xref = out.length
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
	for (const off of offsets)
		out += `${String(off).padStart(10, "0")} 00000 n \n`
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return strToU8(out)
}

export function makeDocx(paragraphs: string[]): Uint8Array {
	const body = paragraphs
		.map(
			(p) =>
				`<w:p><w:r><w:t>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`,
		)
		.join("")
	return zipSync({
		"[Content_Types].xml": strToU8("<Types/>"),
		"word/document.xml": strToU8(
			`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
		),
	})
}

export const PNG_1PX = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
)

/** A PDF whose single page is only an image — what a scanner produces.
 *  `rgb` is 8-bit RGB pixel data, width × height × 3 bytes. */
export function makeScannedPdf(
	rgb: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const data = zlibSync(rgb)
	const w = 612
	const h = Math.round((612 * height) / width)
	const content = `q ${w} 0 0 ${h} 0 ${792 - h} cm /Im1 Do Q`
	const head = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	]
	const parts: Uint8Array[] = []
	const offsets: number[] = []
	let size = 0
	const push = (chunk: string | Uint8Array) => {
		const bytes = typeof chunk === "string" ? strToU8(chunk) : chunk
		parts.push(bytes)
		size += bytes.byteLength
	}
	push("%PDF-1.4\n")
	head.forEach((o, i) => {
		offsets.push(size)
		push(`${i + 1} 0 obj\n${o}\nendobj\n`)
	})
	offsets.push(size)
	push(
		`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.byteLength} >>\nstream\n`,
	)
	push(data)
	push("\nendstream\nendobj\n")
	const xref = size
	let tail = `xref\n0 6\n0000000000 65535 f \n`
	for (const off of offsets)
		tail += `${String(off).padStart(10, "0")} 00000 n \n`
	tail += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	push(tail)
	const out = new Uint8Array(size)
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.byteLength
	}
	return out
}
