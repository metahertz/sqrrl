# @sqrrl/client

TypeScript HTTP client for the SQRRL API. Use this package when you want to call the supported public API from an app, job, or integration.

## Install

```bash
npm install @sqrrl/client
```

## When to use this package

- You are talking to `apps/api`.
- You want retrying HTTP requests and a typed client surface.
- You do not need server-side gateway access.

## Example

```ts
import { SqrrlClient } from "@sqrrl/client"

const client = new SqrrlClient({
	baseUrl: "http://127.0.0.1:3847",
})

await client.rawWrite({
	scope: "workspace",
	scopeRef: "default",
	items: [
		{ source: "slack", sourceId: "C1/1731840000.1", kind: "message", text: "Dana will ship it Friday" },
	],
})

const pages = await client.wikiSearch({
	query: "What did Dana commit to?",
	scope: "workspace",
	scopeRef: "default",
	graphExpansion: true,
})
```

## Deadlines, cancellation, and retries

Every request has a 10-second total deadline by default. Set a different client
default with `defaultDeadlineMs`, or override one call and attach caller
cancellation with its second argument:

```ts
const client = new SqrrlClient({
	baseUrl: "http://127.0.0.1:3847",
	defaultDeadlineMs: 5_000,
})

const controller = new AbortController()
const results = await client.wikiSearch(
	{ query: "open tasks for Dana", scope: "workspace", scopeRef: "default" },
	{ timeoutMs: 2_000, signal: controller.signal },
)
```

Safe reads retry transient transport failures plus HTTP 429 and 503 responses.
`Retry-After` is honored when it fits inside the total call deadline.
`rawWrite` also retries: identical content is a no-op server-side, so a retry
after a lost response reports "unchanged". Other mutations are attempted once.

## Supported operations

The wiki (search with graph expansion, get, apply, list, lint, OKF import and
export, maintenance, relationships, merge, task reassign and status, purge,
delete), raw source items (`rawWrite`, `rawSearch`), and scoped API key
management (`whoami`, `listApiKeys`, `createApiKey`, `updateApiKey`,
`revokeApiKey`). Server-local liveness, readiness and probes are intentionally
not client methods.

The conversational memory surface (`add`, `search`, `buildContextBundle`,
lifecycle, profile and friends) was removed with memongo.
