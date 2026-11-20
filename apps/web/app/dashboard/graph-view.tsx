"use client"

// The whole scope as an interactive graph: sigma.js (WebGL) over a
// graphology graph, laid out by ForceAtlas2 in a worker.
//
// The old explorer drew at most 90 nodes in a fixed SVG with no zoom; this
// draws every page and stays smooth into the thousands. Positions survive
// reloads, so an edit does not reshuffle the map under you: only new pages
// get placed, next to a neighbour, and settle there with every known page
// pinned. The layout is computed before the map is shown (in short slices,
// so the page stays responsive), never animated on load: a live ForceAtlas2
// run shook the whole map for seconds, and restarted from scratch whenever
// the pages reloaded mid-run. Only "Re-run layout" animates. Interaction is direct: hover lights up a neighbourhood, drag moves
// a node, click opens the page, and link mode draws an edge between two
// clicked nodes.

import type Graph from "graphology"
import type forceAtlas2 from "graphology-layout-forceatlas2"
import type FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker.js"
import type Sigma from "sigma"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildGraphModel, neighbourhood, seedPosition } from "./graph-model.js"
import { IconFocus, IconLink, IconPlus, IconRefresh, IconX } from "./icons.js"
import { PagePicker } from "./page-picker.js"
import { type PageType, TYPE_META, type WikiPage } from "./shared.js"

type GraphClass = typeof Graph
type Fa2 = typeof forceAtlas2
type Fa2LayoutClass = typeof FA2LayoutSupervisor

/** These packages are CommonJS; a dynamic import hands back their export
 *  as `default`, sometimes nested once more depending on the bundler. */
function defaultExport<T>(mod: unknown): T {
	const m = mod as { default?: { default?: unknown } }
	return (m.default?.default ?? m.default ?? mod) as T
}

const TYPES: PageType[] = [
	"note",
	"meeting",
	"task",
	"person",
	"topic",
	"other",
]

type Theme = {
	edge: string
	label: string
	panel: string
	ink: string
	accent: string
	faded: string
}

function readTheme(el: HTMLElement): Theme {
	const css = getComputedStyle(el)
	const v = (name: string, fallback: string) =>
		css.getPropertyValue(name).trim() || fallback
	return {
		edge: v("--graph-edge", "#c9d1dc"),
		label: v("--graph-label", "#1f2937"),
		panel: v("--panel", "#ffffff"),
		ink: v("--ink", "#111827"),
		accent: v("--accent", "#d97706"),
		faded: v("--border", "#e3e7ee"),
	}
}

/** Positions outlive the component, so leaving the Graph tab and coming
 *  back shows the same map without laying it out again. */
const savedPositions = new Map<string, { x: number; y: number }>()

/** Iterations to settle a first view, and to place new pages. */
const FIRST_ITERATIONS = 300
const FIRST_ITERATIONS_LARGE = 150
const PLACE_ITERATIONS = 60
const SLICE = 25

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export function GraphView({
	pages,
	selectedSlug,
	theme,
	onOpen,
	onLink,
}: {
	pages: WikiPage[]
	selectedSlug: string | null
	/** Changes when the console theme changes, to re-read the colors. */
	theme: string
	onOpen: (page: WikiPage) => void
	/** Link mode finished: draw an edge from source to target. */
	onLink: (source: WikiPage, target: WikiPage) => void
}) {
	const container = useRef<HTMLDivElement>(null)
	const sigmaRef = useRef<Sigma | null>(null)
	const graphRef = useRef<Graph | null>(null)
	const layoutRef = useRef<{
		stop(): void
		kill(): void
		start(): void
		isRunning(): boolean
	} | null>(null)
	const positions = useRef(savedPositions)
	const hovered = useRef<string | null>(null)
	const hoverSet = useRef<Set<string>>(new Set())
	const focusSet = useRef<Set<string> | null>(null)
	const hiddenTypes = useRef<Set<PageType>>(new Set())
	const hideIsolatedRef = useRef(true)
	const selectedRef = useRef<string | null>(selectedSlug)
	const linkSourceRef = useRef<string | null>(null)

	const [hidden, setHidden] = useState<Set<PageType>>(new Set())
	const [hideIsolated, setHideIsolated] = useState(true)
	const [depth, setDepth] = useState(0)
	const [linkMode, setLinkMode] = useState(false)
	const [linkSource, setLinkSource] = useState<string | null>(null)
	const [layoutRunning, setLayoutRunning] = useState(false)
	const [settling, setSettling] = useState(false)

	const model = useMemo(() => buildGraphModel(pages), [pages])
	const bySlug = useMemo(() => new Map(pages.map((p) => [p.slug, p])), [pages])
	const counts = useMemo(() => {
		const c = new Map<PageType, number>()
		for (const n of model.nodes) c.set(n.type, (c.get(n.type) ?? 0) + 1)
		return c
	}, [model])
	const isolated = useMemo(
		() => model.nodes.filter((n) => n.degree === 0).length,
		[model],
	)

	// Callbacks the sigma handlers see; refs keep them current without
	// re-creating the renderer on every render.
	const openRef = useRef(onOpen)
	const linkRef = useRef(onLink)
	const linkModeRef = useRef(linkMode)
	openRef.current = onOpen
	linkRef.current = onLink
	linkModeRef.current = linkMode

	const refresh = useCallback(() => sigmaRef.current?.refresh(), [])

	const runLayout = useCallback((ms: number) => {
		const layout = layoutRef.current
		if (!layout) return
		layout.start()
		setLayoutRunning(true)
		setTimeout(() => {
			if (!layout.isRunning()) return
			layout.stop()
			setLayoutRunning(false)
			const g = graphRef.current
			if (g)
				g.forEachNode((n, a) => positions.current.set(n, { x: a.x, y: a.y }))
		}, ms)
	}, [])

	// Build (or rebuild) the graph and renderer when the data or theme changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: theme is read through CSS variables, so a change must rebuild to pick up the new colors
	useEffect(() => {
		let cancelled = false
		const el = container.current
		if (!el) return
		;(async () => {
			const [graphMod, sigmaMod, fa2Mod, workerMod] = await Promise.all([
				import("graphology"),
				import("sigma"),
				import("graphology-layout-forceatlas2"),
				import("graphology-layout-forceatlas2/worker.js"),
			])
			const GraphCtor = defaultExport<GraphClass>(graphMod)
			const SigmaCtor = defaultExport<typeof Sigma>(sigmaMod)
			const fa2 = defaultExport<Fa2>(fa2Mod)
			const FA2Layout = defaultExport<Fa2LayoutClass>(workerMod)
			if (cancelled) return
			const colors = readTheme(el)
			const graph: Graph = new GraphCtor({ multi: false, type: "directed" })
			const fresh: string[] = []
			for (const n of model.nodes) {
				const known = positions.current.get(n.key)
				if (!known) fresh.push(n.key)
				const pos = known ?? seedPosition(n.key)
				graph.addNode(n.key, {
					...pos,
					size: n.size,
					color: n.color,
					label: n.label,
					ptype: n.type,
					degree: n.degree,
				})
			}
			for (const e of model.edges) {
				if (!graph.hasEdge(e.source, e.target))
					graph.addEdgeWithKey(e.key, e.source, e.target, {
						size: 0.6 + e.weight,
						kind: e.kind,
					})
			}
			// New pages start beside a neighbour rather than at a random seed
			// far from everything they connect to.
			if (positions.current.size > 0) {
				for (const key of fresh) {
					const nb = graph.neighbors(key).find((m) => positions.current.has(m))
					const at = nb ? positions.current.get(nb) : undefined
					if (at)
						graph.mergeNodeAttributes(key, {
							x: at.x + (Math.random() - 0.5) * 6,
							y: at.y + (Math.random() - 0.5) * 6,
						})
				}
			}

			const settings = {
				...fa2.inferSettings(graph),
				barnesHutOptimize: graph.order > 250,
				slowDown: 4,
				gravity: 1.2,
			}
			// Settle off screen: the whole map on a first view, otherwise only
			// the new pages, with every known one pinned where it was.
			if (fresh.length > 0) {
				const first = positions.current.size === 0
				const pinned = first ? [] : graph.filterNodes((n) => !fresh.includes(n))
				for (const n of pinned) graph.setNodeAttribute(n, "fixed", true)
				const total = first
					? graph.order > 1000
						? FIRST_ITERATIONS_LARGE
						: FIRST_ITERATIONS
					: PLACE_ITERATIONS
				if (first) setSettling(true)
				for (let done = 0; done < total; done += SLICE) {
					fa2.assign(graph, {
						iterations: Math.min(SLICE, total - done),
						settings,
					})
					await nextFrame()
					if (cancelled) return
				}
				for (const n of pinned) graph.removeNodeAttribute(n, "fixed")
				graph.forEachNode((n, a) =>
					positions.current.set(n, { x: a.x, y: a.y }),
				)
				setSettling(false)
			}
			if (cancelled) return

			const renderer: Sigma = new SigmaCtor(graph, el, {
				renderLabels: true,
				labelColor: { color: colors.label },
				labelSize: 12,
				labelWeight: "500",
				labelFont: "ui-sans-serif, system-ui, sans-serif",
				labelDensity: 0.45,
				labelGridCellSize: 140,
				// Only hubs are labelled at the fitted zoom; zooming in grows
				// rendered sizes past the threshold, so more labels appear.
				labelRenderedSizeThreshold: 11,
				defaultEdgeColor: colors.edge,
				defaultEdgeType: "line",
				zIndex: true,
				minCameraRatio: 0.03,
				maxCameraRatio: 4,
				defaultDrawNodeHover: (ctx, data, settings) => {
					const label = typeof data.label === "string" ? data.label : ""
					if (!label) return
					const size = settings.labelSize + 1
					ctx.font = `600 ${size}px ${settings.labelFont}`
					const w = ctx.measureText(label).width
					const x = data.x + data.size + 6
					const y = data.y
					ctx.fillStyle = colors.panel
					ctx.strokeStyle = colors.faded
					ctx.lineWidth = 1
					ctx.beginPath()
					ctx.roundRect(x - 6, y - size / 2 - 6, w + 12, size + 12, 7)
					ctx.fill()
					ctx.stroke()
					ctx.fillStyle = colors.ink
					ctx.fillText(label, x, y + size / 3)
					ctx.beginPath()
					ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2)
					ctx.strokeStyle = colors.accent
					ctx.lineWidth = 2
					ctx.stroke()
				},
				nodeReducer: (node, data) => {
					const res = { ...data }
					const type = data.ptype as PageType
					const isSelected =
						node === selectedRef.current || node === linkSourceRef.current
					if (
						hiddenTypes.current.has(type) ||
						(hideIsolatedRef.current && data.degree === 0 && !isSelected) ||
						(focusSet.current && !focusSet.current.has(node))
					) {
						res.hidden = true
						return res
					}
					if (hovered.current && !hoverSet.current.has(node)) {
						res.color = colors.faded
						res.label = ""
						res.zIndex = 0
					} else if (hovered.current) {
						res.zIndex = 2
						res.forceLabel = true
					}
					if (isSelected) {
						res.highlighted = true
						res.forceLabel = true
						res.zIndex = 3
						res.size = (data.size as number) * 1.25
					}
					return res
				},
				edgeReducer: (edge, data) => {
					const res = { ...data }
					const [s, t] = graph.extremities(edge)
					if (
						focusSet.current &&
						!(focusSet.current.has(s) && focusSet.current.has(t))
					) {
						res.hidden = true
						return res
					}
					const h = hovered.current ?? selectedRef.current
					if (h) {
						if (s === h || t === h) {
							res.color = colors.accent
							res.size = Math.max((data.size as number) * 1.6, 1.4)
							res.zIndex = 2
						} else if (hovered.current) {
							res.hidden = true
						}
					}
					return res
				},
			})

			// Hover: light up the node and its direct neighbours.
			renderer.on("enterNode", ({ node }) => {
				hovered.current = node
				hoverSet.current = new Set([node, ...graph.neighbors(node)])
				el.style.cursor = "pointer"
				renderer.refresh({ skipIndexation: true })
			})
			renderer.on("leaveNode", () => {
				hovered.current = null
				hoverSet.current = new Set()
				el.style.cursor = ""
				renderer.refresh({ skipIndexation: true })
			})

			// Drag: move a node; the camera stays put while dragging.
			let dragged: string | null = null
			let moved = false
			renderer.on("downNode", ({ node }) => {
				dragged = node
				moved = false
				if (layoutRef.current?.isRunning()) {
					layoutRef.current.stop()
					setLayoutRunning(false)
				}
			})
			const captor = renderer.getMouseCaptor()
			captor.on("mousemovebody", (e) => {
				if (!dragged) return
				moved = true
				const pos = renderer.viewportToGraph(e)
				graph.mergeNodeAttributes(dragged, { x: pos.x, y: pos.y })
				positions.current.set(dragged, pos)
				e.preventSigmaDefault()
				e.original.preventDefault()
				e.original.stopPropagation()
			})
			captor.on("mouseup", () => {
				dragged = null
			})

			renderer.on("clickNode", ({ node }) => {
				if (moved) return
				const page = bySlug.get(node)
				if (!page) return
				if (linkModeRef.current) {
					const source = linkSourceRef.current
					if (!source) {
						linkSourceRef.current = node
						setLinkSource(node)
						renderer.refresh({ skipIndexation: true })
						return
					}
					const from = bySlug.get(source)
					linkSourceRef.current = null
					setLinkSource(null)
					setLinkMode(false)
					if (from && source !== node) linkRef.current(from, page)
					return
				}
				openRef.current(page)
			})

			const layout = new FA2Layout(graph, { settings })

			sigmaRef.current?.kill()
			layoutRef.current?.kill()
			graphRef.current = graph
			sigmaRef.current = renderer
			layoutRef.current = layout
		})()
		return () => {
			cancelled = true
			setSettling(false)
		}
	}, [model, bySlug, theme])

	useEffect(
		() => () => {
			layoutRef.current?.kill()
			sigmaRef.current?.kill()
		},
		[],
	)

	// Filters, focus and selection feed the reducers.
	useEffect(() => {
		hiddenTypes.current = hidden
		hideIsolatedRef.current = hideIsolated
		selectedRef.current = selectedSlug
		focusSet.current =
			depth > 0 && selectedSlug
				? neighbourhood(model.edges, selectedSlug, depth)
				: null
		refresh()
	}, [hidden, hideIsolated, selectedSlug, depth, model, refresh])

	const flyTo = useCallback((slug: string) => {
		const renderer = sigmaRef.current
		if (!renderer || !renderer.getGraph().hasNode(slug)) return
		const d = renderer.getNodeDisplayData(slug)
		if (d)
			renderer
				.getCamera()
				.animate({ x: d.x, y: d.y, ratio: 0.3 }, { duration: 600 })
	}, [])

	// Opening a page elsewhere (list, palette) brings the camera to it.
	useEffect(() => {
		if (selectedSlug) {
			const t = setTimeout(() => flyTo(selectedSlug), 50)
			return () => clearTimeout(t)
		}
	}, [selectedSlug, flyTo])

	const camera = (fn: "zoomIn" | "zoomOut" | "reset") => {
		const c = sigmaRef.current?.getCamera()
		if (!c) return
		if (fn === "zoomIn") c.animatedZoom({ duration: 250 })
		else if (fn === "zoomOut") c.animatedUnzoom({ duration: 250 })
		else c.animatedReset({ duration: 400 })
	}

	return (
		<div className="mdb-graph">
			<div
				ref={container}
				className="mdb-graph-canvas"
				data-testid="graph-canvas"
			/>

			{settling ? (
				<div className="mdb-graph-hint" role="status">
					Laying out the map…
				</div>
			) : null}

			{linkMode ? (
				<div className="mdb-graph-hint">
					{linkSource
						? `Now click the page to link “${bySlug.get(linkSource)?.title ?? linkSource}” to`
						: "Click the page the link starts from"}
				</div>
			) : null}

			<div
				className="mdb-graph-overlay"
				style={{ left: 14, top: 14, width: 236 }}
			>
				<div className="mdb-graph-panel">
					<PagePicker
						pages={pages}
						placeholder="Find in graph…"
						onPick={(p) => {
							openRef.current(p)
							flyTo(p.slug)
						}}
					/>
				</div>
				<div className="mdb-graph-panel">
					{TYPES.filter((t) => counts.get(t)).map((t) => (
						<button
							key={t}
							type="button"
							className="mdb-legend-item"
							aria-pressed={!hidden.has(t)}
							onClick={() =>
								setHidden((prev) => {
									const next = new Set(prev)
									if (next.has(t)) next.delete(t)
									else next.add(t)
									return next
								})
							}
						>
							<span
								className="mdb-dot"
								style={{ background: TYPE_META[t].color }}
							/>
							{TYPE_META[t].plural}
							<span className="mdb-count">{counts.get(t)}</span>
						</button>
					))}
					<label className="mdb-legend-item" style={{ marginTop: 4 }}>
						<input
							type="checkbox"
							checked={hideIsolated}
							onChange={(e) => setHideIsolated(e.target.checked)}
						/>
						Hide unlinked
						<span className="mdb-count">{isolated}</span>
					</label>
				</div>
				<div
					className="mdb-graph-panel"
					style={{ display: "flex", flexDirection: "column", gap: 6 }}
				>
					<span
						className="mdb-muted"
						style={{
							fontSize: 11.5,
							fontWeight: 600,
							letterSpacing: "0.05em",
							textTransform: "uppercase",
						}}
					>
						Focus around selection
					</span>
					<div className="mdb-chips">
						{[0, 1, 2].map((d) => (
							<button
								key={d}
								type="button"
								className="mdb-chip"
								aria-pressed={depth === d}
								disabled={d > 0 && !selectedSlug}
								onClick={() => setDepth(d)}
							>
								{d === 0 ? "All" : `${d} hop${d > 1 ? "s" : ""}`}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="mdb-graph-overlay" style={{ right: 14, top: 14 }}>
				<div
					className="mdb-graph-panel"
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 4,
						padding: 6,
					}}
				>
					<button
						type="button"
						className="mdb-btn mdb-btn-ghost mdb-btn-icon"
						title="Zoom in"
						onClick={() => camera("zoomIn")}
					>
						<IconPlus />
					</button>
					<button
						type="button"
						className="mdb-btn mdb-btn-ghost mdb-btn-icon"
						title="Zoom out"
						onClick={() => camera("zoomOut")}
					>
						<span style={{ fontSize: 18, lineHeight: 1 }}>−</span>
					</button>
					<button
						type="button"
						className="mdb-btn mdb-btn-ghost mdb-btn-icon"
						title="Fit to screen"
						onClick={() => camera("reset")}
					>
						<IconFocus />
					</button>
					<button
						type="button"
						className="mdb-btn mdb-btn-ghost mdb-btn-icon"
						title={layoutRunning ? "Laying out…" : "Re-run layout"}
						disabled={layoutRunning}
						onClick={() => runLayout(2500)}
					>
						<IconRefresh />
					</button>
					<button
						type="button"
						className={`mdb-btn mdb-btn-icon ${linkMode ? "mdb-btn-primary" : "mdb-btn-ghost"}`}
						title={
							linkMode
								? "Cancel linking"
								: "Link two pages: click the source, then the target"
						}
						onClick={() => {
							setLinkMode((m) => !m)
							linkSourceRef.current = null
							setLinkSource(null)
							refresh()
						}}
					>
						{linkMode ? <IconX /> : <IconLink />}
					</button>
				</div>
			</div>
		</div>
	)
}
