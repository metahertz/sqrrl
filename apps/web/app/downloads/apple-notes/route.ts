// Serves the Mac agent (Apple Notes and Calendar.app) as a single .tar.gz.
//
// Built from the files in public/apple-notes on request rather than committed
// as a binary: the scripts stay reviewable in the repo, git stays free of
// blobs, and the download can never drift from the source it is made of.
//
// The archive is written by hand because a tar writer is about forty lines of
// fixed-width headers and adding a dependency to ship a few text files is a bad
// trade. gzip comes from node:zlib.

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

export const dynamic = "force-dynamic"

const SOURCE_DIR = join(process.cwd(), "public", "apple-notes")
const FILES = [
	{ name: "README.md", mode: 0o644 },
	{ name: "sqrrl-notes-export.js", mode: 0o755 },
	{ name: "sqrrl-notes-sync.sh", mode: 0o755 },
	{ name: "sqrrl-notes-schedule.sh", mode: 0o755 },
	{ name: "sqrrl-schedule.sh", mode: 0o755 },
	{ name: "sqrrl-calendar-sync.sh", mode: 0o755 },
	{ name: "sqrrl-calendar-export.swift", mode: 0o644 },
	{ name: "sqrrl-mail-sync.sh", mode: 0o755 },
	{ name: "sqrrl-mail-export.js", mode: 0o755 },
]
const BLOCK = 512

function octal(value: number, width: number): string {
	// ustar numeric fields are octal, NUL-terminated, zero-padded.
	return `${value.toString(8).padStart(width - 1, "0")}\0`
}

/** One 512-byte ustar header. */
function header(
	name: string,
	size: number,
	mode: number,
	mtime: number,
): Buffer {
	const buf = Buffer.alloc(BLOCK)
	buf.write(name, 0, 100, "utf8")
	buf.write(octal(mode, 8), 100, 8, "ascii")
	buf.write(octal(0, 8), 108, 8, "ascii") // uid
	buf.write(octal(0, 8), 116, 8, "ascii") // gid
	buf.write(octal(size, 12), 124, 12, "ascii")
	buf.write(octal(mtime, 12), 136, 12, "ascii")
	buf.write("        ", 148, 8, "ascii") // checksum field, spaces while summing
	buf.write("0", 156, 1, "ascii") // typeflag: regular file
	buf.write("ustar\0", 257, 6, "ascii")
	buf.write("00", 263, 2, "ascii")
	buf.write("sqrrl", 265, 32, "utf8") // uname
	buf.write("sqrrl", 297, 32, "utf8") // gname

	let sum = 0
	for (const byte of buf) sum += byte
	// Six octal digits, NUL, then a space — the format tar actually expects.
	buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
	return buf
}

function pad(size: number): Buffer {
	const remainder = size % BLOCK
	return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder)
}

export async function GET() {
	const mtime = Math.floor(Date.now() / 1000)
	const parts: Buffer[] = []
	try {
		for (const file of FILES) {
			const body = await readFile(join(SOURCE_DIR, file.name))
			parts.push(
				header(`sqrrl-apple-notes/${file.name}`, body.length, file.mode, mtime),
				body,
				pad(body.length),
			)
		}
	} catch (err) {
		return new Response(
			`could not read the exporter sources: ${err instanceof Error ? err.message : String(err)}`,
			{ status: 500 },
		)
	}
	// Two empty blocks terminate a tar archive.
	parts.push(Buffer.alloc(BLOCK * 2))

	const gz = gzipSync(Buffer.concat(parts))
	return new Response(new Uint8Array(gz), {
		headers: {
			"content-type": "application/gzip",
			"content-disposition": 'attachment; filename="sqrrl-apple-notes.tar.gz"',
			"content-length": String(gz.length),
			// Lets a reader confirm the download matches what the server built.
			etag: `"${createHash("sha256").update(gz).digest("hex").slice(0, 32)}"`,
			"cache-control": "no-store",
		},
	})
}
