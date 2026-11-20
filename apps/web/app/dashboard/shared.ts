// Shared vocabulary for the dashboard views: one palette, one page shape, one
// set of control styles, so the summary, graph, maintenance and advanced
// panels cannot drift apart visually or structurally.

export type Style = Record<string, string | number>

export const palette = {
	// Theme tokens from console.css: every inline style that reads palette
	// follows light/dark and the console's theme toggle.
	page: "var(--bg)",
	ink: "var(--ink)",
	muted: "var(--muted)",
	/** Darker than `muted`, for text that labels a value rather than merely
	 *  annotating it — a caption under a headline number has to be read, not
	 *  just noticed. */
	label: "var(--label)",
	border: "var(--border)",
	panel: "var(--panel)",
	panelAlt: "var(--panel-2)",
	accent: "var(--accent)",
	accentDark: "var(--accent-strong)",
	code: "var(--code)",
	error: "var(--danger)",
	warning: "var(--warn)",
	success: "var(--ok)",
}

/** One colour per wiki page kind, so the shape of a scope reads at a glance. */
export const kindColor: Record<string, string> = {
	concept: "#6366f1",
	entity: "#a855f7",
	source: "#10b981",
	synthesis: "#f59e0b",
	report: "#ef4444",
	procedure: "#0ea5e9",
}

/** Meetings are source pages, but read as their own thing. */
export const MEETING_COLOR = "#f97316"

/** What a page is, in the console's words rather than the engine's kinds. */
export type PageType =
	| "task"
	| "meeting"
	| "person"
	| "topic"
	| "note"
	| "other"

export function pageType(p: Pick<WikiPage, "slug" | "kind">): PageType {
	if (p.kind === "procedure" || p.slug.startsWith("tasks/")) return "task"
	if (p.slug.startsWith("meetings/")) return "meeting"
	// Teams and automated senders: entity pages, but not people.
	if (p.slug.startsWith("orgs/")) return "other"
	if (p.kind === "entity" || p.slug.startsWith("people/")) return "person"
	if (p.kind === "concept" || p.slug.startsWith("topics/")) return "topic"
	if (p.kind === "source") return "note"
	return "other"
}

export const TYPE_META: Record<
	PageType,
	{ label: string; plural: string; color: string }
> = {
	note: { label: "Note", plural: "Notes", color: kindColor.source },
	meeting: { label: "Meeting", plural: "Meetings", color: MEETING_COLOR },
	task: { label: "Task", plural: "Tasks", color: kindColor.procedure },
	person: { label: "Person", plural: "People", color: kindColor.entity },
	topic: { label: "Topic", plural: "Topics", color: kindColor.concept },
	other: { label: "Page", plural: "Other", color: "#94a3b8" },
}

export type WikiRelationship = {
	targetPageSlug: string
	targetTitle?: string
	kind: string
	weight?: number
}

export type WikiTaskCard = {
	owner?: string
	status?: string
	dueDate?: string
	completedAt?: string | null
	sourceRef?: string
}

export type WikiPage = {
	slug: string
	aliases?: string[]
	frontmatter?: Record<string, unknown>
	personCard?: { emails?: string[] } | null
	title: string
	kind: string
	summary?: string
	body?: string
	revision?: number
	state?: string
	claims?: Array<{ text: string; confidence?: number }>
	relationships?: WikiRelationship[]
	backlinks?: Array<{ sourcePageSlug: string; sourceTitle?: string }>
	/** Server-set; the listing sorts on it, so it is the only stable
	 *  "recently touched" ordering available client-side. */
	updatedAt?: string
	taskCard?: WikiTaskCard | null
}

export const fieldStyle: Style = {
	padding: "6px 9px",
	borderRadius: 6,
	border: `1px solid ${palette.border}`,
	background: palette.panel,
	color: palette.ink,
	fontSize: 13,
}

export function buttonStyle(
	kind: "primary" | "ghost" | "danger" = "ghost",
): Style {
	const base: Style = {
		padding: "6px 12px",
		borderRadius: 6,
		cursor: "pointer",
		fontSize: 13,
	}
	if (kind === "primary") {
		return {
			...base,
			border: `1px solid ${palette.accent}`,
			background: palette.accent,
			color: "var(--accent-ink)",
		}
	}
	if (kind === "danger") {
		return {
			...base,
			border: `1px solid ${palette.error}`,
			background: palette.panel,
			color: palette.error,
		}
	}
	return {
		...base,
		border: `1px solid ${palette.border}`,
		background: palette.panel,
		color: palette.ink,
	}
}

export const panelStyle: Style = {
	border: `1px solid ${palette.border}`,
	borderRadius: 10,
	background: palette.panel,
	padding: 16,
}
