import { describe, expect, it } from "vitest"
import {
	matchExistingTaskPage,
	TOPIC_LEXICAL_THRESHOLD,
	topicSimilarity,
	TASK_MATCH_THRESHOLD,
	taskSimilarity,
	taskSlug,
	carriedTaskState,
} from "./tasks.js"

describe("taskSimilarity", () => {
	it("ignores stop words so rephrasing still matches", () => {
		// The observed failure: the same commitment came back with and without
		// "the", which forked a second task page every run.
		expect(
			taskSimilarity(
				"Migrate the auth service to OIDC",
				"Migrate auth service to OIDC",
			),
		).toBe(1)
	})

	it("separates genuinely different tasks", () => {
		expect(
			taskSimilarity(
				"Migrate auth service to OIDC",
				"Write the incident postmortem",
			),
		).toBeLessThan(TASK_MATCH_THRESHOLD)
	})

	it("is zero for empty input", () => {
		expect(taskSimilarity("", "anything")).toBe(0)
	})
})

describe("matchExistingTaskPage", () => {
	const prior = [
		{
			slug: "tasks/marcus-migrate-the-auth-service-to-oidc",
			title: "Migrate the auth service to OIDC",
			taskCard: { owner: "Marcus", status: "open" as const },
		},
		{
			slug: "tasks/priya-scope-analytics-migration",
			title: "Scope the analytics migration",
			taskCard: { owner: "Priya", status: "open" as const },
		},
	]

	it("matches a rephrased task from the same owner", () => {
		expect(
			matchExistingTaskPage(
				{ task: "Migrate auth service to OIDC", owner: "Marcus" },
				prior,
			),
		).toBe("tasks/marcus-migrate-the-auth-service-to-oidc")
	})

	it("does not match across owners", () => {
		// Two people can owe similar work; merging would silently reassign one.
		expect(
			matchExistingTaskPage(
				{ task: "Migrate auth service to OIDC", owner: "Priya" },
				prior,
			),
		).toBeNull()
	})

	it("returns null for an unrelated task", () => {
		expect(
			matchExistingTaskPage(
				{ task: "Book the boiler service", owner: "Marcus" },
				prior,
			),
		).toBeNull()
	})

	it("treats a missing owner as unassigned rather than matching anyone", () => {
		expect(
			matchExistingTaskPage({ task: "Migrate auth service to OIDC" }, prior),
		).toBeNull()
	})
})

describe("carriedTaskState", () => {
	it("defaults a page with no prior card to open", () => {
		expect(carriedTaskState(null)).toMatchObject({
			status: "open",
			reopened: false,
		})
		expect(carriedTaskState(undefined).status).toBe("open")
	})

	it("keeps a hand-set status — the note cannot know someone finished it", () => {
		expect(carriedTaskState({ owner: "l", status: "done" }).status).toBe("done")
		expect(carriedTaskState({ owner: "l", status: "in-progress" }).status).toBe(
			"in-progress",
		)
		expect(carriedTaskState({ owner: "l", status: "blocked" }).status).toBe(
			"blocked",
		)
	})

	it("reopens a dropped task, because seeing it again means it is back", () => {
		expect(carriedTaskState({ owner: "l", status: "dropped" })).toMatchObject({
			status: "open",
			reopened: true,
		})
	})

	it("carries the completion date forward with a preserved done status", () => {
		expect(
			carriedTaskState({
				owner: "l",
				status: "done",
				completedAt: "2026-09-15T10:00:00.000Z",
			}).completedAt,
		).toBe("2026-09-15T10:00:00.000Z")
	})

	it("drops a completion date when the task is reopened by the extractor", () => {
		expect(
			carriedTaskState({
				owner: "l",
				status: "dropped",
				completedAt: "2026-09-15T10:00:00.000Z",
			}).completedAt,
		).toBeUndefined()
	})

	it("does not invent a completion date for an open task", () => {
		expect(
			carriedTaskState({ owner: "l", status: "open" }).completedAt,
		).toBeUndefined()
	})
})

describe("taskSlug", () => {
	it("namespaces by owner and truncates", () => {
		expect(
			taskSlug({ task: "Migrate the auth service to OIDC", owner: "Marcus" }),
		).toBe("tasks/marcus-migrate-the-auth-service-to-oidc")
	})

	it("falls back to unassigned", () => {
		expect(taskSlug({ task: "Do a thing" })).toBe("tasks/unassigned-do-a-thing")
	})
})

describe("topicSimilarity", () => {
	it("is order-insensitive", () => {
		expect(topicSimilarity("Q4 roadmap", "roadmap Q4")).toBe(1)
	})

	it("collapses singular and plural", () => {
		expect(topicSimilarity("grocery", "groceries")).toBe(1)
		expect(topicSimilarity("topic", "topics")).toBe(1)
	})

	it("scores unrelated labels below the reuse floor", () => {
		expect(topicSimilarity("pricing page", "boiler")).toBeLessThan(
			TOPIC_LEXICAL_THRESHOLD,
		)
	})

	it("cannot see synonyms — this is why the semantic pass exists", () => {
		// The observed duplicates were topics/groceries vs topics/shopping-list
		// and topics/boiler vs topics/house-maintenance. They share no words, so
		// no lexical measure catches them; resolveTopicHub falls through to
		// vector search for exactly this case.
		expect(topicSimilarity("groceries", "shopping list")).toBe(0)
		expect(topicSimilarity("boiler", "house maintenance")).toBe(0)
	})
})
