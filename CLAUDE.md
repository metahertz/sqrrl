# SQRRL Repository Guidelines

- Repo: https://github.com/metahertz/sqrrl
- A fork of [MDBrain](https://github.com/romiluz13/mdbrain), run as its own product (see README).
- In chat replies, file references must be repo-root relative only (example: `packages/source-layer/src/raw-items.ts:80`); never absolute paths or `~/...`.

## Project Structure

SQRRL is a **Turborepo/Bun monorepo**: a self-hosted, MongoDB-native "second brain" that keeps raw source items (Layer 1) and distills them into a linked wiki of sources, topics, people and tasks (Layer 2). It is for one person's data and day-to-day tasks, not a company knowledge base; see README.md for the why.

```
sqrrl/
  apps/
    api/          HTTP API server (Hono): /v1/wiki/*, /v1/raw/*, /wiki browse
    mcp/          MCP server (stdio, calls HTTP API): wiki + curation tools
    web/          Next.js web console (/dashboard)
    transcriber/  Local Whisper, OpenAI-compatible transcription
  packages/
    wiki-engine/          Governed LLM wiki and MongoDB store (Layer 2)
    source-layer/         Raw items, distillers, secret redaction (Layer 1)
    extract/              Documents, images, recordings to text
    connector-nextcloud/  Nextcloud files and Notes into Layer 1 + wiki
    connector-slack/      Slack channels and DMs into Layer 1 + wiki
    inference-canary/     Cross-request contamination probe for LLM nodes
    client/               TypeScript HTTP client SDK
    lib/                  Shared types and utilities
  docker/
    mongodb/         Local MongoDB dev stack (atlas-local + mongot)
  docs/              Inherited MDBrain platform docs (not maintained)
```

## Build, Test, and Development

- Runtime: Node 22+, Bun 1.2+ as package manager
- Install: `bun install`
- Build: `bun run build` (Turbo)
- Dev: `bun run dev`
- Test: `bun run test` (Turbo -> Vitest). Per package, use its own `bun run test`; a bare `vitest run` in apps/api or apps/mcp can pick up stale compiled tests from dist/.
- Type-check: `bun run check-types`
- Lint/format: `bun run lint` / `bun run format` (Biome)
- MongoDB local: `cd docker && docker compose up` (or `docker compose -f docker/docker-compose.yml up`)

## Coding Style

- Language: TypeScript (ESM). Strict typing; avoid `any`.
- Formatting/linting via Biome (tabs, double quotes, semicolons as needed).
- Keep files under ~500 LOC; split/refactor when it improves clarity.
- Tests: colocated `*.test.ts` with source, Vitest + V8 coverage.
- Written English: American spelling and grammar.

## Package Naming

- `@sqrrl/wiki-engine` -- governed LLM wiki engine
- `@sqrrl/source-layer` -- raw items, distillers, redaction
- `@sqrrl/extract` -- bytes to text for connectors
- `@sqrrl/client` -- HTTP client SDK
- `@sqrrl/lib` -- shared utilities (private)
- `@sqrrl/api`, `@sqrrl/mcp`, `@sqrrl/web` -- apps (private)

## Commit Guidelines

- Follow concise, action-oriented commit messages (e.g., `engine: add graph expansion`).
- Group related changes; avoid bundling unrelated refactors.

## Security

- Never commit secrets. Use environment variables (`SQRRL_WIKI_MONGODB_URI`, `SQRRL_API_KEY`, etc.).
- Never put a secret in a command's output, a log or a chat transcript; write tokens straight to a mode-600 file.
- Text from sources passes through `redactSecrets` (source-layer) before it is stored, embedded or sent to an LLM.
- Never publish real connection strings, API keys, or personal data in code or docs. Tests use made-up people and example domains.
