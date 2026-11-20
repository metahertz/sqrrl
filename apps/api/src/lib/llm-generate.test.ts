import { describe, expect, it, vi } from "vitest"
import {
	createAnswerCompletion,
	LlmNotConfiguredError,
} from "./llm-generate.js"

const ENV = {
	SQRRL_ENRICHMENT_BASE_URL: "http://llm.test/v1",
	SQRRL_ENRICHMENT_API_KEY: "k",
	SQRRL_ENRICHMENT_MODEL: "m",
}

function fakeFetch(content: string) {
	return vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
			}),
	)
}

function sentBody(fetchFn: ReturnType<typeof fakeFetch>) {
	const init = fetchFn.mock.calls[0]?.[1]
	return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe("createAnswerCompletion", () => {
	it("asks at temperature 0, keeping the configured extra body", async () => {
		const fetchFn = fakeFetch('{"found":true,"answer":"x [P1]"}')
		const complete = createAnswerCompletion(
			{
				...ENV,
				SQRRL_ENRICHMENT_EXTRA_BODY:
					'{"chat_template_kwargs":{"enable_thinking":false}}',
			},
			fetchFn,
		)
		expect(await complete("sys", "user")).toEqual({
			found: true,
			answer: "x [P1]",
		})
		expect(sentBody(fetchFn)).toMatchObject({
			temperature: 0,
			chat_template_kwargs: { enable_thinking: false },
		})
	})

	it("leaves a configured temperature alone", async () => {
		const fetchFn = fakeFetch("{}")
		await createAnswerCompletion(
			{ ...ENV, SQRRL_ENRICHMENT_EXTRA_BODY: '{"temperature":0.3}' },
			fetchFn,
		)("s", "u")
		expect(sentBody(fetchFn).temperature).toBe(0.3)
	})

	it("returns bare text when the model sends no JSON", async () => {
		const complete = createAnswerCompletion(ENV, fakeFetch("Kai [P1]."))
		expect(await complete("s", "u")).toBe("Kai [P1].")
	})

	it("still rejects a malformed extra body", () => {
		expect(() =>
			createAnswerCompletion(
				{ ...ENV, SQRRL_ENRICHMENT_EXTRA_BODY: "[1]" },
				fakeFetch("{}"),
			),
		).toThrow(LlmNotConfiguredError)
	})
})
