// The wiki as a graph, independent of the renderer, so it can be tested.
//
// Nodes are pages; edges are relationships (a backlink is the same edge
// seen from the other end, so only relationships are drawn). Walking for a
// neighbourhood uses both directions: a task points at its note, and from
// the note's side the task is only reachable backwards.

import { pageType, type PageType, TYPE_META, type WikiPage } from "./shared.js"

export type GraphNode = {
	key: string
	label: string
	type: PageType
	color: string
	size: number
	degree: number
}

export type GraphEdge = {
	key: string
	source: string
	target: string
	kind: string
	weight: number
}

export function buildGraphModel(pages: WikiPage[]): {
	nodes: GraphNode[]
	edges: GraphEdge[]
} {
	const known = new Set(pages.map((p) => p.slug))
	const degree = new Map<string, number>()
	const edges: GraphEdge[] = []
	const seen = new Set<string>()
	for (const p of pages) {
		for (const r of p.relationships ?? []) {
			if (!known.has(r.targetPageSlug) || r.targetPageSlug === p.slug) continue
			const key = `${p.slug}->${r.targetPageSlug}`
			if (seen.has(key)) continue
			seen.add(key)
			edges.push({
				key,
				source: p.slug,
				target: r.targetPageSlug,
				kind: r.kind,
				weight: r.weight ?? 0.5,
			})
			degree.set(p.slug, (degree.get(p.slug) ?? 0) + 1)
			degree.set(r.targetPageSlug, (degree.get(r.targetPageSlug) ?? 0) + 1)
		}
	}
	const nodes = pages.map((p) => {
		const type = pageType(p)
		const d = degree.get(p.slug) ?? 0
		return {
			key: p.slug,
			label: p.title.length > 48 ? `${p.title.slice(0, 46)}…` : p.title,
			type,
			color: TYPE_META[type].color,
			// Hubs read as hubs: area grows with degree, capped so a topic
			// with two hundred notes does not swallow the view.
			size: Math.min(4 + Math.sqrt(d) * 2.2, 22),
			degree: d,
		}
	})
	return { nodes, edges }
}

/** Slugs within `hops` of `centre`, walking edges in both directions. */
export function neighbourhood(
	edges: GraphEdge[],
	centre: string,
	hops: number,
): Set<string> {
	const adj = new Map<string, string[]>()
	const add = (a: string, b: string) => {
		const list = adj.get(a)
		if (list) list.push(b)
		else adj.set(a, [b])
	}
	for (const e of edges) {
		add(e.source, e.target)
		add(e.target, e.source)
	}
	const seen = new Set([centre])
	let frontier = [centre]
	for (let h = 0; h < hops; h++) {
		const next: string[] = []
		for (const n of frontier)
			for (const m of adj.get(n) ?? [])
				if (!seen.has(m)) {
					seen.add(m)
					next.push(m)
				}
		frontier = next
	}
	return seen
}

/** A stable starting position per slug, so a first layout is repeatable and
 *  new pages appear in the same place on every machine. */
export function seedPosition(slug: string): { x: number; y: number } {
	let h = 2166136261
	for (let i = 0; i < slug.length; i++) {
		h ^= slug.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	const a = ((h >>> 0) % 3600) / 3600
	const r = 0.3 + (((h >>> 12) % 1000) / 1000) * 0.7
	return {
		x: Math.cos(a * Math.PI * 2) * r * 100,
		y: Math.sin(a * Math.PI * 2) * r * 100,
	}
}
