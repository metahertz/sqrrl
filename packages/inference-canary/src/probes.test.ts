import { describe, expect, it } from "vitest"
import {
	type Endpoint,
	isPlaceholderCode,
	judgeVision,
	parseSizes,
	secretPhrase,
	summarize,
	textProbe,
	visionProbe,
} from "./probes.js"

describe("judgeVision", () => {
	it("flags an answer that repeats the previous request's code", () => {
		expect(
			judgeVision(
				"Verification: 4B2XP9\nShape: circle; Color: red",
				"DFTCWR",
				"circle",
				"red",
				new Set(["4TR3TK", "4B2XP9"]),
			),
		).toMatchObject({ verdict: "cross-request" })
	})

	it("does not count a placeholder code twice as a leak", () => {
		for (const placeholder of ["123456", "ABCDEF", "AAAAAA", "654321"]) {
			expect(
				judgeVision(
					`Verification: ${placeholder}\nShape: circle; Color: red`,
					"DFTCWR",
					"circle",
					"red",
					new Set([placeholder]),
				).verdict,
			).toBe("stamp-misread")
		}
		expect(isPlaceholderCode("8V1M3D")).toBe(false)
	})

	it("still calls a fresh misread harmless", () => {
		expect(
			judgeVision(
				"Verification: QQQQQQ\nShape: circle; Color: red",
				"DFTCWR",
				"circle",
				"red",
				new Set(["4B2XP9"]),
			),
		).toMatchObject({ verdict: "stamp-misread" })
	})

	it("passes an answer with the right code, shape and color", () => {
		expect(
			judgeVision(
				"Verification: HJKL34\nShape: circle; Color: red",
				"HJKL34",
				"circle",
				"red",
			).verdict,
		).toBe("ok")
	})

	it("accepts synonyms", () => {
		expect(
			judgeVision(
				"Verification: HJKL34\nA purple (magenta) round disc",
				"HJKL34",
				"circle",
				"purple",
			).verdict,
		).toBe("ok")
		expect(
			judgeVision(
				"Verification: HJKL34\nShape: rectangle; Color: gold",
				"HJKL34",
				"square",
				"yellow",
			).verdict,
		).toBe("ok")
	})

	it("calls wrong content with a wrong or missing code cross-request", () => {
		expect(
			judgeVision(
				"Verification: ZZZZZZ\nShape: square; Color: green",
				"HJKL34",
				"circle",
				"red",
			).verdict,
		).toBe("cross-request")
		expect(
			judgeVision(
				"A solid magenta circle on white.",
				"HJKL34",
				"triangle",
				"blue",
			).verdict,
		).toBe("cross-request")
	})

	it("calls right content with a misread code a stamp misread, not contamination", () => {
		expect(
			judgeVision(
				"Verification: R3MMC\nShape: circle; Color: red",
				"KR3MMC",
				"circle",
				"red",
			).verdict,
		).toBe("stamp-misread")
	})

	it("calls a right code with the wrong content a partial image, which counts as contamination", () => {
		const r = judgeVision(
			"Verification: HJKL34\nShape: square; Color: green",
			"HJKL34",
			"circle",
			"red",
		)
		expect(r.verdict).toBe("partial-image")
		expect(
			summarize([
				{ kind: "vision", model: "m", variant: "", backend: "a", ms: 1, ...r },
			]).contaminated,
		).toBe(true)
	})

	it("does not count a misread stamp as contamination", () => {
		const r = judgeVision(
			"Verification: R3MMC\nShape: circle; Color: red",
			"KR3MMC",
			"circle",
			"red",
		)
		expect(
			summarize([
				{ kind: "vision", model: "m", variant: "", backend: "a", ms: 1, ...r },
			]).contaminated,
		).toBe(false)
	})
})

/** An endpoint that echoes each request's own code, optionally swapping the
 *  answers of two concurrent requests to simulate a leaking node. */
function echoEndpoint(opts: { swap?: boolean } = {}): Endpoint {
	const pending: Array<{ code: string; resolve: (r: Response) => void }> = []
	return {
		baseUrl: "http://node/v1",
		apiKey: "k",
		fetchFn: async (_url, init) => {
			const body = JSON.parse(String(init?.body))
			const code = /Code: (\S+)/.exec(body.messages[1].content)?.[1] ?? ""
			const respond = (content: string) =>
				Response.json(
					{ choices: [{ message: { content } }], timings: { cache_n: 0 } },
					{ headers: { "x-litellm-model-id": "inference9" } },
				)
			if (!opts.swap) return respond(code)
			return new Promise<Response>((resolve) => {
				pending.push({ code, resolve })
				if (pending.length === 2) {
					const [a, b] = pending.splice(0, 2)
					a.resolve(respond(b.code))
					b.resolve(respond(a.code))
				}
			})
		},
	}
}

describe("textProbe", () => {
	it("passes a node that answers each request with its own code", async () => {
		const results = await textProbe(echoEndpoint(), "ornith-35b", 4)
		expect(results.map((r) => r.verdict)).toEqual(["ok", "ok", "ok", "ok"])
		expect(results[0]).toMatchObject({ backend: "inference9", cacheN: 0 })
	})

	it("catches a node that hands one request's answer to another", async () => {
		const results = await textProbe(
			echoEndpoint({ swap: true }),
			"ornith-35b",
			2,
		)
		expect(results.map((r) => r.verdict)).toEqual([
			"cross-request",
			"cross-request",
		])
		expect(summarize(results).contaminated).toBe(true)
	})

	it("reports errors without calling them contamination", async () => {
		const ep: Endpoint = {
			baseUrl: "http://node/v1",
			apiKey: "k",
			fetchFn: async () => new Response("down", { status: 502 }),
		}
		const results = await textProbe(ep, "m", 2)
		expect(results.every((r) => r.verdict === "error")).toBe(true)
		expect(summarize(results).contaminated).toBe(false)
	})

	it("makes distinct secrets", () => {
		expect(
			new Set(Array.from({ length: 50 }, secretPhrase)).size,
		).toBeGreaterThan(45)
	})
})

describe("visionProbe", () => {
	it("sends a stamped image and flags an answer from another image", async () => {
		let sent: Record<string, unknown> | undefined
		const ep: Endpoint = {
			baseUrl: "http://node/v1",
			apiKey: "k",
			fetchFn: async (_url, init) => {
				sent = JSON.parse(String(init?.body))
				return Response.json(
					{
						choices: [{ message: { content: "Shape: hexagon; Color: black" } }],
					},
					{ headers: { "x-litellm-model-id": "inference2" } },
				)
			},
		}
		const r = await visionProbe(ep, "qwen3.5-122b", {
			width: 320,
			height: 160,
		})
		expect(r).toMatchObject({
			kind: "vision",
			backend: "inference2",
			verdict: "cross-request",
		})
		if (!sent) throw new Error("no request was sent")
		const content = (
			sent.messages as Array<{
				content: Array<{
					type: string
					text?: string
					image_url?: { url: string }
				}>
			}>
		)[0].content
		expect(content[0].text).toContain("Verification")
		expect(content[0].text).not.toMatch(/Image [0-9a-f]/)
		expect(content[1].image_url?.url.startsWith("data:image/png;base64,")).toBe(
			true,
		)
	})

	it("sends the default size as 1024x512 (512 image tokens)", async () => {
		let url = ""
		const ep: Endpoint = {
			baseUrl: "http://node/v1",
			apiKey: "k",
			fetchFn: async (_u, init) => {
				url = JSON.parse(String(init?.body)).messages[0].content[1].image_url
					.url
				return Response.json({ choices: [{ message: { content: "x" } }] })
			},
		}
		const r = await visionProbe(ep, "m")
		expect(r.variant).toMatch(/^png 1024x512 ~512tok /)
		const png = Buffer.from(url.split(",")[1], "base64")
		expect(png.readUInt32BE(16) * png.readUInt32BE(20)).toBe(1024 * 512)
	})

	it("records codes so a later probe can spot a repeat", async () => {
		const answers = ["Verification: 4B2XP9\nShape: x"]
		const ep: Endpoint = {
			baseUrl: "http://node/v1",
			apiKey: "k",
			fetchFn: async () =>
				Response.json({
					choices: [{ message: { content: answers[0] } }],
				}),
		}
		const history = new Map<string, Set<string>>()
		const first = await visionProbe(ep, "m", undefined, history)
		expect(first.verdict).not.toBe("error")
		expect(history.get("unknown")?.has("4B2XP9")).toBe(true)
		const second = await visionProbe(ep, "m", undefined, history)
		expect(second.verdict).toBe("cross-request")
		expect(second.detail).toContain("from the previous request")
	})

	it("ignores a repeat from a different backend", async () => {
		let n = 0
		const ep: Endpoint = {
			baseUrl: "http://node/v1",
			apiKey: "k",
			fetchFn: async () =>
				Response.json(
					{ choices: [{ message: { content: "Verification: 7X9K2M\nx" } }] },
					{ headers: { "x-litellm-model-id": `node${n++}` } },
				),
		}
		const history = new Map<string, Set<string>>()
		await visionProbe(ep, "m", undefined, history)
		const second = await visionProbe(ep, "m", undefined, history)
		// Judged on content alone ("x" is wrong), not as a repeat.
		expect(second.detail).not.toContain("previous request")
	})

	it("sends a JPEG variant as JPEG", async () => {
		let url = ""
		const ep: Endpoint = {
			baseUrl: "http://node/v1",
			apiKey: "k",
			fetchFn: async (_u, init) => {
				url = JSON.parse(String(init?.body)).messages[0].content[1].image_url
					.url
				return Response.json({ choices: [{ message: { content: "x" } }] })
			},
		}
		const r = await visionProbe(ep, "m", {
			width: 1536,
			height: 672,
			format: "jpeg",
		})
		expect(url.startsWith("data:image/jpeg;base64,")).toBe(true)
		expect(r.variant).toMatch(/^jpeg 1536x768 ~1152tok /)
	})
})

describe("parseSizes", () => {
	it("reads sizes with optional format", () => {
		expect(parseSizes("1024x416, 1536x672:JPEG")).toEqual([
			{ width: 1024, height: 416, format: "png" },
			{ width: 1536, height: 672, format: "jpeg" },
		])
	})

	it("rejects anything else", () => {
		expect(() => parseSizes("1024")).toThrow(/bad size/)
		expect(() => parseSizes("1024x416:webp")).toThrow(/bad size/)
	})
})

describe("summarize", () => {
	it("tallies verdicts per model and backend", () => {
		const s = summarize([
			{
				kind: "text",
				model: "m",
				variant: "",
				backend: "a",
				verdict: "ok",
				detail: "",
				ms: 1,
			},
			{
				kind: "text",
				model: "m",
				variant: "",
				backend: "a",
				verdict: "cross-request",
				detail: "",
				ms: 1,
			},
			{
				kind: "text",
				model: "m",
				variant: "",
				backend: "b",
				verdict: "ok",
				detail: "",
				ms: 1,
			},
		])
		expect(s.byBackend["m @ a"]).toMatchObject({ ok: 1, "cross-request": 1 })
		expect(s.byBackend["m @ b"].ok).toBe(1)
		expect(s.contaminated).toBe(true)
	})
})
