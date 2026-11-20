import { strToU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { categorySelected, NextcloudNotes } from "./notes.js"
import { BASE, FakeNextcloud, USER } from "./testing/fake-nextcloud.js"
import {
	NextcloudHttpError,
	NextcloudWebDav,
	parseMultistatus,
} from "./webdav.js"

function setup() {
	const nc = new FakeNextcloud()
	const dav = new NextcloudWebDav(BASE, USER, "app-pass", nc.fetch)
	return { nc, dav }
}

describe("parseMultistatus", () => {
	it("returns every response even when there is only one", () => {
		const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href></d:response></d:multistatus>`
		expect(parseMultistatus(xml)).toHaveLength(1)
	})

	it("tolerates an empty multistatus", () => {
		expect(parseMultistatus(`<d:multistatus xmlns:d="DAV:"/>`)).toEqual([])
	})
})

describe("NextcloudWebDav", () => {
	it("walks folders recursively, one level per request", async () => {
		const { nc, dav } = setup()
		nc.addFile("Company/a.md", {
			bytes: strToU8("a"),
			mimeType: "text/markdown",
		})
		nc.addFile("Company/Deep/Deeper/b.pdf", {
			bytes: strToU8("b"),
			mimeType: "application/pdf",
		})
		nc.addFile("Elsewhere/c.md", {
			bytes: strToU8("c"),
			mimeType: "text/markdown",
		})
		const files = await dav.listFolder("Company")
		expect(files.map((f) => f.path).sort()).toEqual([
			"Company/Deep/Deeper/b.pdf",
			"Company/a.md",
		])
		expect(
			nc.requests
				.filter((r) => r.method === "PROPFIND")
				.every((r) => !r.url.includes("infinity")),
		).toBe(true)
	})

	it("reads fileid, unquoted etag, size and type, ignoring 404 propstats", async () => {
		const { nc, dav } = setup()
		nc.addFile("Company/Q3 plan.pdf", {
			fileId: "4242",
			etag: "abc123",
			bytes: strToU8("hello"),
			mimeType: "application/pdf",
		})
		const [f] = await dav.listFolder("Company")
		expect(f).toMatchObject({
			fileId: "4242",
			etag: "abc123",
			path: "Company/Q3 plan.pdf",
			name: "Q3 plan.pdf",
			size: 5,
			mimeType: "application/pdf",
		})
	})

	it("handles names that need URL encoding", async () => {
		const { nc, dav } = setup()
		nc.addFile("Team Docs/Café & plans #2.md", {
			bytes: strToU8("x"),
			mimeType: "text/markdown",
		})
		const [f] = await dav.listFolder("Team Docs")
		expect(f.path).toBe("Team Docs/Café & plans #2.md")
		expect(await dav.download(f, 100)).toEqual(strToU8("x"))
	})

	it("throws on a failing folder rather than returning a partial list", async () => {
		const { nc, dav } = setup()
		nc.addFile("Company/Sub/a.md", {
			bytes: strToU8("a"),
			mimeType: "text/markdown",
		})
		nc.failPaths.add("Company/Sub")
		await expect(dav.listFolder("Company")).rejects.toBeInstanceOf(
			NextcloudHttpError,
		)
	})

	it("throws for a folder that does not exist", async () => {
		const { dav } = setup()
		await expect(dav.listFolder("Nope")).rejects.toMatchObject({ status: 404 })
	})

	it("resolves tag names case-insensitively and finds tagged files anywhere", async () => {
		const { nc, dav } = setup()
		nc.addFile("x/y/standup.mp3", {
			bytes: strToU8("a"),
			mimeType: "audio/mpeg",
			tags: ["meetings"],
		})
		nc.addFile("x/other.md", { bytes: strToU8("b"), mimeType: "text/markdown" })
		const tags = await dav.systemTags()
		expect(tags.get("meetings")).toBe("7")
		const files = await dav.filesWithTag("7")
		expect(files.map((f) => f.path)).toEqual(["x/y/standup.mp3"])
		const report = nc.requests.find((r) => r.method === "REPORT")
		expect(report?.body).toContain("<oc:systemtag>7</oc:systemtag>")
	})

	it("refuses a download over the size limit", async () => {
		const { nc, dav } = setup()
		nc.addFile("big.bin", {
			bytes: new Uint8Array(2000),
			mimeType: "application/pdf",
		})
		const [f] = await dav.listFolder("")
		await expect(dav.download(f, 1000)).rejects.toThrow("over 1000")
	})

	it("builds a browser link from the file id", () => {
		const { dav } = setup()
		expect(dav.fileUrl({ fileId: "9" } as never)).toBe(`${BASE}/f/9`)
	})

	it("sends basic auth with the app password", async () => {
		const { nc, dav } = setup()
		await dav.ping()
		expect(nc.requests[0].method).toBe("PROPFIND")
	})
})

describe("NextcloudNotes", () => {
	it("lists notes with content", async () => {
		const nc = new FakeNextcloud()
		nc.notes = [
			{
				id: 1,
				etag: "n1",
				title: "Standup",
				category: "Work",
				content: "hi",
				modified: 100,
			},
		]
		const notes = await new NextcloudNotes(BASE, USER, "p", nc.fetch).list()
		expect(notes).toEqual([
			{
				id: 1,
				etag: "n1",
				title: "Standup",
				category: "Work",
				content: "hi",
				modified: 100,
			},
		])
	})

	it("returns pruned notes as bare ids", async () => {
		const nc = new FakeNextcloud()
		nc.notes = [
			{
				id: 1,
				etag: "a",
				title: "old",
				category: "",
				content: "x",
				modified: 10,
			},
			{
				id: 2,
				etag: "b",
				title: "new",
				category: "",
				content: "y",
				modified: 99,
			},
		]
		const notes = await new NextcloudNotes(BASE, USER, "p", nc.fetch).list(50)
		expect(notes[0].content).toBeUndefined()
		expect(notes[1].content).toBe("y")
		expect(nc.requests[0].url).toContain("pruneBefore=50")
	})

	it("explains an HTML answer instead of a JSON parse error", async () => {
		const nc = new FakeNextcloud()
		nc.notesInstalled = false
		await expect(
			new NextcloudNotes(BASE, USER, "p", nc.fetch).list(),
		).rejects.toThrow("is the Notes app installed?")
	})
})

describe("categorySelected", () => {
	it("matches a category and its subcategories, case-insensitively", () => {
		expect(categorySelected("Work", ["work"])).toBe(true)
		expect(categorySelected("Work/1:1s", ["Work"])).toBe(true)
		expect(categorySelected("Workshop", ["Work"])).toBe(false)
		expect(categorySelected("", ["Work"])).toBe(false)
	})

	it("selects everything with *", () => {
		expect(categorySelected("", ["*"])).toBe(true)
	})
})
