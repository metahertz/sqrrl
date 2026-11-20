"use client"

// The SQRRL console: a sidebar app over one scope of the wiki.
//
// Views (Overview, Ask, Graph, the per-type lists, Settings) share one
// loaded copy of the scope and one write path, run(): every edit goes to
// the API, then the scope is re-read, because an edit (a merge, a link, a
// reassignment) changes pages other than the one being edited. The page
// drawer opens over any view. The view is kept in the URL hash, so a
// refresh or a shared link lands in the same place.

import {
	SqrrlClient,
	type SqrrlIdentitySuggestion,
	type SqrrlStatus,
} from "@sqrrl/client"
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { resolveApiBaseUrl } from "../api-base.js"
import { clearApiKey, loadApiKey, saveApiKey } from "./api-key-store.js"
import { ActivitySummaryCard, ActivityView } from "./activity-view.js"
import { AskPanel } from "./ask-panel.js"
import { BRAND, SqrrlMark, TAGLINE } from "./brand.js"
import { CommandPalette, type PaletteAction } from "./command-palette.js"
import { type CreatableType, CreateDialog } from "./create-dialog.js"
import { useDecisionQueue } from "./decision-queue.js"
import {
	EDGE_KINDS,
	edgeLabel,
	errorText,
	type RunFn,
} from "./drawer-context.js"
import { GraphView } from "./graph-view.js"
import {
	IconBook,
	IconCalendar,
	IconGraph,
	IconHash,
	IconHome,
	IconKey,
	IconMoon,
	IconNote,
	IconRefresh,
	IconSearch,
	IconActivity,
	IconSettings,
	IconSparkle,
	IconSun,
	IconTask,
	IconUsers,
} from "./icons.js"
import { PageDrawer } from "./page-drawer.js"
import { SettingsView } from "./settings-view.js"
import { IdentityQuestionsCard } from "./identity-panel.js"
import { type Suggestion, SuggestionCard } from "./suggestion-panel.js"
import { pageType, type PageType, type WikiPage } from "./shared.js"
import type { TaskStatus } from "./task-status.js"
import { ListView, OverviewView, type View } from "./views.js"
import { ofType, overdue, type TaskFilter } from "./views-data.js"
import { fetchAllPages } from "./wiki-data.js"
import { slugFromHash, wikiHash } from "./wiki-index.js"
import { WikiView } from "./wiki-view.js"
import "./console.css"

const apiBase = resolveApiBaseUrl()
const VIEWS: View[] = [
	"overview",
	"ask",
	"wiki",
	"graph",
	"task",
	"meeting",
	"person",
	"topic",
	"note",
	"activity",
	"settings",
]
const LIST_VIEWS: Array<{
	view: PageType & View
	label: string
	icon: typeof IconTask
}> = [
	{ view: "task", label: "Tasks", icon: IconTask },
	{ view: "meeting", label: "Meetings", icon: IconCalendar },
	{ view: "person", label: "People", icon: IconUsers },
	{ view: "topic", label: "Topics", icon: IconHash },
	{ view: "note", label: "Notes", icon: IconNote },
]
type Theme = "system" | "light" | "dark"

function readHash(): View {
	if (typeof window === "undefined") return "overview"
	const h = window.location.hash.replace(/^#/, "")
	if (h === "wiki" || h.startsWith("wiki/")) return "wiki"
	return VIEWS.includes(h as View) ? (h as View) : "overview"
}

function storedTheme(): Theme {
	try {
		const t = window.localStorage.getItem("mdbrain-theme")
		return t === "light" || t === "dark" ? t : "system"
	} catch {
		return "system"
	}
}

export default function ConsolePage() {
	const [apiKey, setApiKey] = useState("")
	const [keyDraft, setKeyDraft] = useState("")
	const [remember, setRemember] = useState(true)
	const [scope, setScope] = useState("workspace")
	const [scopeRef, setScopeRef] = useState("default")
	const [pages, setPages] = useState<WikiPage[]>([])
	const [suggestions, setSuggestions] = useState<Suggestion[]>([])
	const [identityQuestions, setIdentityQuestions] = useState<
		SqrrlIdentitySuggestion[]
	>([])
	const [loaded, setLoaded] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [truncated, setTruncated] = useState(false)
	const [view, setView] = useState<View>("overview")
	const [taskFilter, setTaskFilter] = useState<TaskFilter>("open")
	const [openSlug, setOpenSlug] = useState<string | null>(null)
	const [drawerTab, setDrawerTab] = useState<
		"overview" | "edit" | "history" | "manage"
	>("overview")
	const [wikiSlug, setWikiSlug] = useState<string | undefined>()
	const [createType, setCreateType] = useState<CreatableType | null>(null)
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [askQuestion, setAskQuestion] = useState<string | undefined>()
	const [linkDraft, setLinkDraft] = useState<{
		source: WikiPage
		target: WikiPage
		kind: string
	} | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
		null,
	)
	const [ready, setReady] = useState<Record<string, unknown> | null>(null)
	const [readyError, setReadyError] = useState<string | null>(null)
	const [isMaster, setIsMaster] = useState<boolean | null>(null)
	const [status, setStatus] = useState<SqrrlStatus | null>(null)
	const [statusError, setStatusError] = useState<string | null>(null)
	const [statusLoading, setStatusLoading] = useState(false)
	const [theme, setTheme] = useState<Theme>("system")
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const keyInput = useRef<HTMLInputElement>(null)
	// The API address depends on the host the page was loaded from, which
	// the prerender cannot know; shown only once mounted.
	const [apiShown, setApiShown] = useState("this server")
	useEffect(() => setApiShown(apiBase), [])
	useEffect(() => {
		if (!apiKey) keyInput.current?.focus()
	}, [apiKey])

	// Browser-only state is read after mount: the page is prerendered, and
	// seeding it in useState would make the first render disagree with it.
	useEffect(() => {
		const stored = loadApiKey()
		if (stored) {
			setApiKey(stored)
			setKeyDraft(stored)
		}
		setView(readHash())
		setWikiSlug(slugFromHash(window.location.hash))
		setTheme(storedTheme())
		const onHash = () => {
			setView(readHash())
			setWikiSlug(slugFromHash(window.location.hash))
		}
		window.addEventListener("hashchange", onHash)
		return () => window.removeEventListener("hashchange", onHash)
	}, [])

	/** Wiki pages are history entries, so the browser's back button walks
	 *  back through what was read; other views replace the entry. */
	const openWiki = useCallback((slug?: string) => {
		setView("wiki")
		setWikiSlug(slug)
		if (window.location.hash !== wikiHash(slug))
			window.location.hash = wikiHash(slug)
	}, [])

	const navigate = useCallback((v: View, filter?: TaskFilter) => {
		if (filter) setTaskFilter(filter)
		setView(v)
		if (window.location.hash !== `#${v}`)
			window.history.replaceState(null, "", `#${v}`)
	}, [])

	const applyTheme = (t: Theme) => {
		setTheme(t)
		try {
			if (t === "system") window.localStorage.removeItem("mdbrain-theme")
			else window.localStorage.setItem("mdbrain-theme", t)
		} catch {
			// Private mode: the choice lasts for this tab only.
		}
	}

	const client = useMemo(
		() =>
			new SqrrlClient({
				baseUrl: apiBase,
				apiKey: apiKey.trim() || undefined,
			}),
		[apiKey],
	)

	const say = useCallback((text: string, error = false) => {
		setToast({ text, error })
		if (toastTimer.current) clearTimeout(toastTimer.current)
		toastTimer.current = setTimeout(() => setToast(null), error ? 7000 : 3200)
	}, [])

	useEffect(() => {
		let cancelled = false
		fetch(`${apiBase}/ready`)
			.then((r) => r.json())
			.then((d) => !cancelled && setReady(d as Record<string, unknown>))
			.catch(
				(err: unknown) =>
					!cancelled &&
					setReadyError(err instanceof Error ? err.message : String(err)),
			)
		return () => {
			cancelled = true
		}
	}, [])

	useEffect(() => {
		let cancelled = false
		if (!apiKey.trim()) {
			setIsMaster(null)
			return
		}
		client
			.whoami()
			.then((me) => !cancelled && setIsMaster(me.isMasterKey))
			.catch(() => !cancelled && setIsMaster(false))
		return () => {
			cancelled = true
		}
	}, [client, apiKey])

	/** The suggestion lists. Best effort: an older API without task review
	 *  or identity questions just shows none. */
	const loadLists = useCallback(async () => {
		const [pending, questions] = await Promise.all([
			client
				.taskSuggestions({ scope, scopeRef })
				.catch(() => ({ suggestions: [] })),
			client
				.identitySuggestions({ scope, scopeRef })
				.catch(() => ({ suggestions: [] })),
		])
		setSuggestions(pending.suggestions as unknown as Suggestion[])
		setIdentityQuestions(questions.suggestions)
	}, [client, scope, scopeRef])

	const load = useCallback(async () => {
		if (!apiKey.trim()) return
		try {
			const { pages: all, truncated: cut } = await fetchAllPages(
				client,
				scope,
				scopeRef,
			)
			setPages(all)
			setTruncated(cut)
			await loadLists()
			setLoadError(null)
			setLoaded(true)
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err))
		}
	}, [client, scope, scopeRef, apiKey, loadLists])

	/** Refetches named pages and swaps them into the list: no full reload.
	 *  A page that is gone (404, deleted, merged away) drops out; one that
	 *  could not be fetched for another reason keeps its old copy. */
	const refreshPages = useCallback(
		async (slugs: string[]) => {
			const results = await Promise.all(
				[...new Set(slugs)].map((slug) =>
					client
						.wikiGet({ slug, scope, scopeRef })
						.then((page) => ({ slug, page: page as WikiPage, gone: false }))
						.catch((err: { status?: number }) => ({
							slug,
							page: null,
							gone: err?.status === 404,
						})),
				),
			)
			setPages((prev) => {
				let next = prev
				for (const r of results) {
					const gone =
						r.gone ||
						(r.page &&
							(r.page.state === "superseded" ||
								(r.page as { deleted?: boolean }).deleted === true))
					if (gone) next = next.filter((p) => p.slug !== r.slug)
					else if (r.page) {
						const page = r.page
						const i = next.findIndex((p) => p.slug === page.slug)
						next =
							i >= 0
								? next.map((p, j) => (j === i ? page : p))
								: [page, ...next]
					}
				}
				return next
			})
		},
		[client, scope, scopeRef],
	)

	useEffect(() => {
		void load()
	}, [load])

	// Background work (Activity view and the Overview line). Polled while the
	// tab is visible; an older API without /v1/wiki/status just shows nothing.
	const loadStatus = useCallback(async () => {
		if (!apiKey.trim()) return
		setStatusLoading(true)
		try {
			setStatus(await client.backgroundStatus({ scope, scopeRef }))
			setStatusError(null)
		} catch (err) {
			setStatusError(err instanceof Error ? err.message : String(err))
		} finally {
			setStatusLoading(false)
		}
	}, [client, scope, scopeRef, apiKey])

	useEffect(() => {
		setStatus(null)
		void loadStatus()
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void loadStatus()
		}, 60_000)
		return () => clearInterval(timer)
	}, [loadStatus])

	const run: RunFn = useCallback(
		async (label, fn, refresh) => {
			setBusy(label)
			try {
				await fn()
				if (refresh?.all) await load()
				else
					await Promise.all([
						refresh?.pages?.length ? refreshPages(refresh.pages) : undefined,
						refresh?.lists ? loadLists() : undefined,
					])
				say(label)
				return true
			} catch (err) {
				say(errorText(err), true)
				return false
			} finally {
				setBusy(null)
			}
		},
		[load, loadLists, refreshPages, say],
	)

	const queue = useDecisionQueue({
		client,
		scope,
		scopeRef,
		say,
		errorText,
		onSettled: async (slugs) => {
			await Promise.all([refreshPages(slugs), loadLists()])
		},
	})
	const visibleSuggestions = useMemo(
		() => suggestions.filter((s) => !queue.isHidden(s.id)),
		[suggestions, queue.isHidden],
	)
	const visibleQuestions = useMemo(
		() => identityQuestions.filter((q) => !queue.isHidden(q.id)),
		[identityQuestions, queue.isHidden],
	)

	/** taskCard is replaced whole by the API, so the stored card is re-sent
	 *  with the new status, guarded by the revision it was read at. */
	const setTaskStatus = useCallback(
		(page: WikiPage, status: TaskStatus) => {
			const card = page.taskCard
			if (!card) return
			void run(
				status === "done" ? `Done: ${page.title}` : `Reopened: ${page.title}`,
				() =>
					client.wikiSetTaskStatus({
						slug: page.slug,
						scope,
						scopeRef,
						status,
						taskCard: {
							owner: card.owner ?? "unassigned",
							...(card.dueDate ? { dueDate: card.dueDate } : {}),
							...(card.sourceRef ? { sourceRef: card.sourceRef } : {}),
						},
						...(typeof page.revision === "number"
							? { expectedRevision: page.revision }
							: {}),
					}),
				{ pages: [page.slug] },
			)
		},
		[client, run, scope, scopeRef],
	)

	// Keyboard: ⌘K / Ctrl+K or "/" palette; "n" new page and "g" graph when
	// not typing in a field.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const typing = (e.target as HTMLElement)?.closest?.(
				"input, textarea, select, [contenteditable]",
			)
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault()
				setPaletteOpen((o) => !o)
			} else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
				if (e.key === "n" && apiKey) {
					e.preventDefault()
					setCreateType("note")
				} else if (e.key === "g") navigate("graph")
				else if (e.key === "/") {
					e.preventDefault()
					setPaletteOpen(true)
				}
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [navigate, apiKey])

	const openPage = useCallback((p: WikiPage) => {
		setDrawerTab("overview")
		setOpenSlug(p.slug)
	}, [])
	const openBySlug = useCallback((slug: string) => {
		setDrawerTab("overview")
		setOpenSlug(slug)
	}, [])
	const opened = openSlug ? pages.find((p) => p.slug === openSlug) : undefined
	const suggested = useMemo(
		() => new Map(visibleSuggestions.map((s) => [s.taskSlug, s.proposed])),
		[visibleSuggestions],
	)

	const counts = useMemo(() => {
		const c = new Map<PageType, number>()
		for (const p of pages) c.set(pageType(p), (c.get(pageType(p)) ?? 0) + 1)
		return c
	}, [pages])
	const lateCount = useMemo(() => overdue(pages).length, [pages])

	const connect = () => {
		const key = keyDraft.trim()
		if (!key) return
		if (remember) saveApiKey(key)
		else clearApiKey()
		setLoaded(false)
		setApiKey(key)
	}

	const signOut = () => {
		clearApiKey()
		setApiKey("")
		setKeyDraft("")
		setPages([])
		setLoaded(false)
	}

	const paletteActions: PaletteAction[] = [
		{ id: "overview", label: "Overview", run: () => navigate("overview") },
		{ id: "ask", label: "Ask the brain", run: () => navigate("ask") },
		{ id: "wiki", label: "Wiki", run: () => openWiki() },
		{ id: "graph", label: "Graph", hint: "g", run: () => navigate("graph") },
		...LIST_VIEWS.map((l) => ({
			id: l.view,
			label: l.label,
			run: () => navigate(l.view),
		})),
		{
			id: "overdue",
			label: "Overdue tasks",
			run: () => navigate("task", "overdue"),
		},
		{
			id: "new",
			label: "New page",
			hint: "n",
			run: () => setCreateType("note"),
		},
		{ id: "activity", label: "Activity", run: () => navigate("activity") },
		{ id: "settings", label: "Settings", run: () => navigate("settings") },
	]

	const navItem = (
		v: View,
		label: string,
		Icon: typeof IconHome,
		count?: number,
		tone?: string,
	) => (
		<button
			key={v}
			type="button"
			className="mdb-nav-item"
			aria-current={view === v ? "page" : undefined}
			onClick={() => navigate(v)}
		>
			<Icon />
			{label}
			{count !== undefined ? (
				<span className="mdb-count" style={tone ? { color: tone } : undefined}>
					{count}
				</span>
			) : null}
		</button>
	)

	const healthy = ready?.ok === true && !readyError

	let content: ReactNode
	if (!apiKey) {
		content = (
			<div className="mdb-page" style={{ maxWidth: 460, paddingTop: "12vh" }}>
				<div className="mdb-card mdb-card-pad" style={{ padding: 28 }}>
					<div className="mdb-brand" style={{ padding: "0 0 4px" }}>
						<SqrrlMark size={32} /> Connect to {BRAND}
					</div>
					<p className="mdb-brand-tagline">{TAGLINE}</p>
					<p className="mdb-muted" style={{ marginTop: 0 }}>
						Paste an API key. It is sent to {apiShown} as a header and, if you
						choose, remembered in a cookie on this browser.
					</p>
					<label className="mdb-field">
						<span>API key</span>
						<input
							className="mdb-input"
							type="password"
							ref={keyInput}
							value={keyDraft}
							onChange={(e) => setKeyDraft(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && connect()}
						/>
					</label>
					<label
						style={{
							display: "flex",
							gap: 8,
							alignItems: "center",
							fontSize: 13,
							marginBottom: 16,
						}}
					>
						<input
							type="checkbox"
							checked={remember}
							onChange={(e) => setRemember(e.target.checked)}
						/>
						Remember on this browser for 14 days
					</label>
					<button
						type="button"
						className="mdb-btn mdb-btn-primary"
						style={{ width: "100%" }}
						disabled={!keyDraft.trim()}
						onClick={connect}
					>
						Connect
					</button>
				</div>
			</div>
		)
	} else if (loadError && !loaded) {
		content = (
			<div className="mdb-page">
				<div
					className="mdb-card mdb-card-pad"
					style={{ borderColor: "var(--danger)" }}
				>
					<strong>
						Could not load {scope}:{scopeRef}.
					</strong>
					<p className="mdb-muted">{loadError}</p>
					<div style={{ display: "flex", gap: 8 }}>
						<button
							type="button"
							className="mdb-btn"
							onClick={() => void load()}
						>
							Retry
						</button>
						<button
							type="button"
							className="mdb-btn mdb-btn-ghost"
							onClick={signOut}
						>
							Use a different key
						</button>
					</div>
				</div>
			</div>
		)
	} else if (!loaded) {
		content = (
			<div className="mdb-empty" style={{ paddingTop: "20vh" }}>
				Loading {scope}:{scopeRef}…
			</div>
		)
	} else if (view === "graph") {
		content = (
			<GraphView
				pages={pages}
				selectedSlug={openSlug}
				theme={theme}
				onOpen={openPage}
				onLink={(source, target) =>
					setLinkDraft({ source, target, kind: "relates_to" })
				}
			/>
		)
	} else if (view === "wiki") {
		content = (
			<WikiView
				pages={pages}
				slug={wikiSlug}
				apiBase={apiBase}
				scope={scope}
				scopeRef={scopeRef}
				busy={busy !== null}
				onNavigate={openWiki}
				onOpenDrawer={(p, tab) => {
					setDrawerTab(tab)
					setOpenSlug(p.slug)
				}}
				onShowInGraph={(p) => {
					navigate("graph")
					setDrawerTab("overview")
					setOpenSlug(p.slug)
				}}
				onSetStatus={setTaskStatus}
				suggested={suggested}
				onOpenSuggestion={(p) => {
					setDrawerTab("overview")
					setOpenSlug(p.slug)
				}}
			/>
		)
	} else if (view === "ask") {
		content = (
			<div className="mdb-page" style={{ maxWidth: 860 }}>
				<div className="mdb-page-head">
					<div>
						<h1>Ask the brain</h1>
						<p>
							Answers come only from your pages and source text, with citations.
						</p>
					</div>
				</div>
				<div className="mdb-card mdb-card-pad">
					<AskPanel
						client={client}
						apiBase={apiBase}
						scope={scope}
						scopeRef={scopeRef}
						initialQuestion={askQuestion}
						onOpenSlug={(slug) => openWiki(slug)}
					/>
				</div>
			</div>
		)
	} else if (view === "activity") {
		content = (
			<ActivityView
				status={status}
				error={statusError}
				loading={statusLoading}
				onRefresh={() => void loadStatus()}
				onOpenSuggested={() => navigate("task", "suggested")}
			/>
		)
	} else if (view === "settings") {
		content = (
			<SettingsView
				client={client}
				apiBase={apiBase}
				isMaster={isMaster}
				ready={ready}
				readyError={readyError}
				theme={theme}
				onTheme={applyTheme}
				scope={scope}
				scopeRef={scopeRef}
				pages={pages}
				onIdentitySaved={() => void load()}
			/>
		)
	} else if (view === "overview") {
		content = (
			<OverviewView
				pages={pages}
				selectedSlug={openSlug}
				onOpen={openPage}
				busy={busy !== null}
				onSetStatus={setTaskStatus}
				onNavigate={navigate}
				onCreate={() => setCreateType("note")}
				suggested={suggested}
				activityCard={
					status ? (
						<ActivitySummaryCard
							status={status}
							onOpen={() => navigate("activity")}
						/>
					) : undefined
				}
				identityCard={
					<IdentityQuestionsCard
						questions={visibleQuestions}
						client={client}
						scope={scope}
						scopeRef={scopeRef}
						run={run}
						decide={queue.decide}
						busy={busy !== null}
						openSlug={openBySlug}
					/>
				}
				suggestionsCard={
					visibleSuggestions.length ? (
						<div className="mdb-card" style={{ marginBottom: 16 }}>
							<div className="mdb-card-head">
								Suggested to close
								<span className="mdb-sub">{visibleSuggestions.length}</span>
								<span className="mdb-spacer" />
								{visibleSuggestions.length > 3 ? (
									<button
										type="button"
										className="mdb-btn mdb-btn-sm"
										onClick={() => navigate("task", "suggested")}
									>
										See all
									</button>
								) : null}
							</div>
							<div className="mdb-suggestions-list">
								{visibleSuggestions.slice(0, 3).map((s) => (
									<SuggestionCard
										key={s.id}
										s={s}
										compact
										client={client}
										scope={scope}
										scopeRef={scopeRef}
										run={run}
										decide={queue.decide}
										busy={busy !== null}
										openSlug={openBySlug}
									/>
								))}
							</div>
						</div>
					) : undefined
				}
			/>
		)
	} else {
		const type = view as PageType
		content = (
			<ListView
				key={type}
				type={type}
				pages={pages}
				selectedSlug={openSlug}
				onOpen={openPage}
				busy={busy !== null}
				onSetStatus={setTaskStatus}
				taskFilter={taskFilter}
				onTaskFilter={setTaskFilter}
				suggested={suggested}
				onCreate={() =>
					setCreateType(
						type === "meeting" || type === "other"
							? "note"
							: (type as CreatableType),
					)
				}
			/>
		)
	}

	return (
		<div className="mdb" data-theme={theme === "system" ? undefined : theme}>
			<nav className="mdb-side" aria-label="Console">
				<div className="mdb-brand" title={TAGLINE}>
					<SqrrlMark />
					<span className="mdb-brand-name">{BRAND}</span>
				</div>
				{navItem("overview", "Overview", IconHome)}
				{navItem("ask", "Ask", IconSparkle)}
				{navItem("wiki", "Wiki", IconBook)}
				{navItem("graph", "Graph", IconGraph)}
				<div className="mdb-nav-label">Library</div>
				{LIST_VIEWS.map((l) =>
					navItem(
						l.view,
						l.label,
						l.icon,
						l.view === "task"
							? ofType(pages, "task").length
							: (counts.get(l.view) ?? 0),
						l.view === "task" && lateCount ? "var(--danger)" : undefined,
					),
				)}
				<div className="mdb-nav-label">System</div>
				{navItem("activity", "Activity", IconActivity)}
				{navItem("settings", "Settings", IconSettings)}
				<div className="mdb-side-foot">
					<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<span
							className="mdb-dot"
							style={{
								background: healthy
									? "var(--ok)"
									: readyError
										? "var(--danger)"
										: "var(--warn)",
							}}
						/>
						{healthy
							? "API ready"
							: readyError
								? "API unreachable"
								: "checking API…"}
					</span>
					{lateCount ? (
						<span style={{ color: "var(--danger)" }}>
							{lateCount} overdue tasks
						</span>
					) : null}
					{truncated ? (
						<span style={{ color: "var(--warn)" }}>
							Only part of the scope loaded.
						</span>
					) : null}
				</div>
			</nav>

			<header className="mdb-top">
				<select
					className="mdb-select"
					aria-label="Scope kind"
					value={scope}
					onChange={(e) => setScope(e.target.value)}
					style={{ width: 118 }}
				>
					<option value="workspace">workspace</option>
					<option value="user">user</option>
				</select>
				<input
					className="mdb-input"
					aria-label="Scope name"
					style={{ width: 120 }}
					defaultValue={scopeRef}
					onBlur={(e) =>
						e.target.value.trim() && setScopeRef(e.target.value.trim())
					}
					onKeyDown={(e) =>
						e.key === "Enter" && (e.target as HTMLInputElement).blur()
					}
				/>
				<button
					type="button"
					className="mdb-search"
					style={{ border: 0, padding: 0, background: "none", cursor: "text" }}
					onClick={() => setPaletteOpen(true)}
				>
					<IconSearch />
					<span
						className="mdb-input"
						style={{
							display: "flex",
							alignItems: "center",
							color: "var(--faint)",
							width: "100%",
							paddingLeft: 32,
						}}
					>
						Search or jump to…
					</span>
					<span className="mdb-kbd">⌘K</span>
				</button>
				<span className="mdb-spacer" />
				{busy ? (
					<span className="mdb-muted" style={{ fontSize: 12.5 }}>
						{busy}…
					</span>
				) : null}
				<button
					type="button"
					className="mdb-btn mdb-btn-ghost mdb-btn-icon"
					title="Reload"
					disabled={!apiKey}
					onClick={() => void run("Reloaded", async () => {}, { all: true })}
				>
					<IconRefresh />
				</button>
				<button
					type="button"
					className="mdb-btn mdb-btn-ghost mdb-btn-icon"
					title="Toggle light/dark"
					onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
				>
					{theme === "dark" ? <IconSun /> : <IconMoon />}
				</button>
				{apiKey ? (
					<button
						type="button"
						className="mdb-btn mdb-btn-sm"
						title="Forget this key on this browser"
						onClick={signOut}
					>
						<IconKey size={14} /> {isMaster ? "master" : "scoped"} · sign out
					</button>
				) : null}
			</header>

			<main className="mdb-main">{content}</main>

			{opened ? (
				<PageDrawer
					page={opened}
					pages={pages}
					client={client}
					scope={scope}
					scopeRef={scopeRef}
					apiBase={apiBase}
					run={run}
					busy={busy !== null}
					openSlug={openBySlug}
					suggestions={visibleSuggestions}
					decide={queue.decide}
					initialTab={drawerTab}
					onReadInWiki={(slug) => {
						setOpenSlug(null)
						openWiki(slug)
					}}
					onClose={() => setOpenSlug(null)}
				/>
			) : null}

			{createType ? (
				<CreateDialog
					initialType={createType}
					pages={pages}
					client={client}
					scope={scope}
					scopeRef={scopeRef}
					run={run}
					busy={busy !== null}
					onClose={() => setCreateType(null)}
					onCreated={(slug) => {
						setCreateType(null)
						setOpenSlug(slug)
					}}
				/>
			) : null}

			{linkDraft ? (
				<>
					<div
						className="mdb-scrim"
						onClick={() => setLinkDraft(null)}
						aria-hidden="true"
					/>
					<div
						className="mdb-dialog"
						role="dialog"
						aria-label="New link"
						style={{ width: "min(440px, calc(100vw - 32px))" }}
					>
						<div className="mdb-dialog-head">New link</div>
						<div className="mdb-dialog-body">
							<p style={{ marginTop: 0 }}>
								<strong>{linkDraft.source.title}</strong>
								<span className="mdb-muted"> → </span>
								<strong>{linkDraft.target.title}</strong>
							</p>
							<label className="mdb-field">
								<span>Kind of link</span>
								<select
									className="mdb-select"
									value={linkDraft.kind}
									onChange={(e) =>
										setLinkDraft({ ...linkDraft, kind: e.target.value })
									}
								>
									{EDGE_KINDS.map((k) => (
										<option key={k} value={k}>
											{edgeLabel(k)}
										</option>
									))}
								</select>
							</label>
						</div>
						<div className="mdb-dialog-foot">
							<button
								type="button"
								className="mdb-btn"
								onClick={() => setLinkDraft(null)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="mdb-btn mdb-btn-primary"
								disabled={busy !== null}
								onClick={async () => {
									const { source, target, kind } = linkDraft
									const ok = await run(
										`Linked ${source.title} → ${target.title}`,
										() =>
											client.wikiEditRelationships({
												slug: source.slug,
												scope,
												scopeRef,
												add: [
													{
														targetPageSlug: target.slug,
														targetTitle: target.title,
														kind,
													},
												],
											}),
										{ pages: [source.slug, target.slug] },
									)
									if (ok) setLinkDraft(null)
								}}
							>
								Add link
							</button>
						</div>
					</div>
				</>
			) : null}

			{paletteOpen ? (
				<CommandPalette
					pages={pages}
					actions={paletteActions}
					onOpen={openPage}
					onAsk={(q) => {
						setAskQuestion(q)
						navigate("ask")
					}}
					onClose={() => setPaletteOpen(false)}
				/>
			) : null}

			{toast ? (
				<div
					className={`mdb-toast ${toast.error ? "mdb-toast-error" : ""}`}
					role="status"
				>
					{toast.text}
				</div>
			) : null}
		</div>
	)
}
