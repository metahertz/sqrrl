# @sqrrl/wiki-engine

MongoDB-native wiki engine for SQRRL — wiki pages, OKF interchange, page rendering, maintenance, contradictions, governance, and connectors.

## Install

```bash
npm install @sqrrl/wiki-engine
```

## When to use this package

- You need direct access to the wiki engine (schema, CRUD, search, governance).
- You are building a custom integration on top of SQRRL's wiki layer.
- You need OKF import/export or connector orchestration.

## Example

```ts
import { ensureWikiSchema, createWikiPage, searchWikiPages } from "@sqrrl/wiki-engine"

// Ensure wiki_pages collection + indexes exist
await ensureWikiSchema(db, "sqrrl_")

// Create a wiki page
const page = await createWikiPage(handle, {
  kind: "concept",
  title: "Payment Processing",
  slug: "concepts/payments",
  summary: "How Stripe charges flow through the system.",
  body: "# Payment Processing\n\n...",
  frontmatter: { type: "concept" },
  scope: "workspace",
  scopeRef: "team-1",
  trustTier: "standard",
})

// Search with hybrid vector + text
const results = await searchWikiPages(handle, {
  query: "stripe charge refund",
  scope: "workspace",
  scopeRef: "team-1",
  recipe: "hybrid",
})
```

## Features

- **Wiki pages** — schema-validated `wiki_pages` collection with claims, evidence, questions, relationships
- **Hybrid search** — Atlas Vector Search + Atlas Search via `$rankFusion` (auto-embed via Voyage AI)
- **OKF interchange** — import/export Open Knowledge Format bundles
- **Governance** — scope filtering, trust-tier propagation, permissions, supersession audit
- **Contradiction detection** — cross-page, runs before dedup
- **Maintenance** — git-diff + Dreamer 5-phase consolidation
- **Connectors** — Obsidian, GitHub, Confluence, Notion, Slack, CRM

If you need an HTTP client, use [`@sqrrl/client`](../client/README.md). If you need the bridge facade, use [`@sqrrl/memory-bridge`](../memory-bridge/README.md).
