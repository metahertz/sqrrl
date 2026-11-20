<h1 align="center">SQRRL</h1>

<p align="center">
  <strong>A self-hosted second brain for one person's working life.</strong><br>
  It squirrels away your notes, meetings, files, Slack, mail and calendar,<br>
  and turns them into a living wiki of people, topics and the things you said you'd do.
</p>

<p align="center">
  <a href="https://github.com/metahertz/sqrrl">github.com/metahertz/sqrrl</a> ·
  <a href="#why">Why</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#how-it-differs-from-mdbrain">How it differs from MDBrain</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#thanks">Thanks</a>
</p>

---

## Why

A working day is spread across a dozen places. A promise made in a meeting,
a decision in a Slack thread, a follow-up in an email, a half-finished note
on the phone, a recording nobody will listen to again. None of it is lost,
exactly. It just isn't anywhere you'll look when it matters.

Most "second brain" tools want you to do the filing. That works until the
day it doesn't, and for brains that go *oh look, a squirrel* every few
minutes, that day comes quickly. SQRRL takes the opposite approach: **you
keep working the way you already do, and it does the filing.**

- Everything you already produce is captured raw, as it happened, with
  its date, author and source.
- An LLM distills each new item into a linked wiki: a page per note,
  meeting, file or Slack conversation-day, hubs for the people and topics in
  them, and **tasks with an owner and a due date**, yours and other people's.
- Those tasks are kept alive. When a later meeting, email or message shows
  something was done or dropped, SQRRL suggests closing it, with the quote
  that proves it. You decide.
- You can ask it questions in plain language and get answers that cite the
  pages and messages they came from.

The name: it squirrels knowledge away so you don't have to, and it's built
for the squirrel-brained.

### Personal, not corporate

SQRRL is for **one person's data and day-to-day work**. It is not a
company knowledge base. It assumes:

- **One owner.** It knows who "me" is, so "I'll send it Friday" in your
  notes becomes your task, and your own name never turns into a stranger's
  person page.
- **Your sources, not a team's.** Your notes, your inbox, your calendar,
  the Slack conversations you're in, the files you keep.
- **Your hardware.** Everything runs self-hosted. The LLM, vision and
  transcription endpoints are any OpenAI-compatible URL, so they can be
  models on your own machines. Secrets found in your sources are redacted
  before anything is stored, embedded or sent to a model.
- **Room to grow.** Every write records who made it, access is through
  scoped API keys, and each scope is a hard partition. A team or a shared
  space can come later without migrating data.

## What it does

**Capture (Layer 1: what happened).**

| Source | How |
| --- | --- |
| Apple Notes, Calendar, Mail | A small Mac agent (JXA and Swift, run by launchd) exports and submits them. See `apps/web/public/apple-notes/`. |
| Nextcloud files and Notes | `packages/connector-nextcloud`: documents, PDFs (with OCR), images (described by a vision model), HEIC, and audio and video recordings (transcribed). |
| Slack | `packages/connector-slack`: a read-only user token covering channels, private channels, DMs and group DMs. Set it up from the console. |
| Anything else | `POST /v1/raw/sync` and `POST /v1/raw/mail` accept raw items from your own scripts. |

Raw items keep their source-native shape (thread, channel, author,
participants, attachments, occurredAt), are searchable by text and meaning,
and support time-range recall ("what did Kai say last week").

**Distill (Layer 2: what it means).**

- A page per source unit, with claims and a summary.
- **People hubs that know a person by every name they go by.** "Taylor M",
  "Taylor Morgan", "Taylor", taylor.morgan@example.com and a Slack display
  name all land on one person. When a first name could be two people,
  SQRRL picks the right one from context, and if it can't, it asks you.
- **Topic hubs**, plus typed edges: attended by, organized by, owned by,
  participant, derived from.
- **Tasks** (`taskCard`: owner, status, due, completedAt). They are
  reconciled every time a source changes and never silently deleted, and a
  status you set survives re-extraction.
- **Living tasks.** A background review matches new evidence against your
  open tasks and suggests "done" or "dropped", grounded in a quote. Nothing
  changes until you accept.

**Use it.**

- **Ask**: cited answers over the wiki and the raw layer (`POST /v1/wiki/answer`).
- **Web console** (`apps/web`):
  - overview and tasks
  - the wiki
  - a graph of everything (sigma.js)
  - one-click decisions on suggestions and same-person questions
  - settings for models, Slack and who you are
- **MCP server** (`apps/mcp`): search, read, answer, and curate (link,
  merge, reassign, set status, decide suggestions) from Claude or any MCP
  client.
- **Read-only wiki** at `/wiki` for plain browsing.

**Run it.**

- **A local Whisper transcriber** (`apps/transcriber`, ONNX, OpenAI-compatible).
  It has a bounded queue, cancels a job when its client goes away, and
  streams uploads to disk.
- **An inference canary** (`packages/inference-canary`) that probes shared
  LLM nodes for cross-request contamination.
- **Prometheus-style status**: per-job freshness, queue depths and suggestion counts.

## How it differs from MDBrain

SQRRL started as a fork of [MDBrain](https://github.com/romiluz13/mdbrain)
and kept its best part, a governed, MongoDB-native LLM wiki engine. What was
built on top points somewhere else:

| | MDBrain | SQRRL |
| --- | --- | --- |
| Built for | A company or team knowledge base shared by many agents and people | One person's working life |
| Where knowledge comes from | Agents and callers write pages; long-term memory lives in a separate memory service (Memongo) | Your own sources, captured raw and distilled by a pipeline; you curate |
| Unit of value | Claims, governance, shared memory | Commitments: who owes what, by when, and the evidence it happened |
| People | Generic entities | Identity resolution across names, emails and handles, with "me" as a first-class person |
| Raw data | Held by the memory service | Its own Layer 1 (`@sqrrl/source-layer`): raw items, distillers, redaction |
| Inference | Cloud LLM by default | Any OpenAI-compatible endpoint, designed for self-hosted models |

The memory service, its bridge and its tools were removed. The wiki engine
(store, revisions, governance, hybrid search, graph traversal, OKF
import/export, scoped keys) is still at the center, and SQRRL leans on it
every day.

## Architecture

```
 CONNECTORS (write via the API)          LAYER 1  @sqrrl/source-layer          LAYER 2  @sqrrl/wiki-engine
 Mac agent: Notes, Calendar, Mail ─┐     raw items (MongoDB, auto-embedded)     wiki pages + revisions
 Nextcloud: files, Notes, audio   ─┼──▶  · source, author, participants   ──▶   · sources/*, topics/*, people/*
 Slack: channels, DMs             ─┤     · thread/channel, occurredAt            · tasks with owner/status/due
 Your scripts: /v1/raw/*          ─┘     · secrets redacted at the door          · typed edges, governance
                                         DISTILLERS                              · hybrid search, graph expansion
                                         · digest + task extraction (LLM)
                                         · people and topic resolution
                                         · task review (suggest done/dropped)

 USE: web console :3040 · HTTP API :3847 · MCP (stdio) · /wiki
 MODELS: any OpenAI-compatible LLM / vision / transcription endpoint · local Whisper :3960
```

| Path | What |
| --- | --- |
| `apps/api` | Hono HTTP API: `/v1/wiki/*`, `/v1/raw/*`, answers, decisions, settings, `/wiki` browse |
| `apps/web` | Next.js console (`/dashboard`) |
| `apps/mcp` | MCP server over stdio, calling the HTTP API |
| `apps/transcriber` | Local Whisper, OpenAI-compatible `/v1/audio/transcriptions` |
| `packages/wiki-engine` | Governed wiki store, search, graph, revisions, scoped keys (from MDBrain) |
| `packages/source-layer` | Raw items, distillers, people identity, task review, redaction |
| `packages/extract` | Documents, images and recordings to text |
| `packages/connector-nextcloud`, `packages/connector-slack` | Source connectors |
| `packages/client` | TypeScript HTTP client |
| `packages/inference-canary` | Contamination probe for shared LLM nodes |
| `packages/lib` | Shared utilities |

## Getting started

SQRRL is a personal project that runs every day for its author, not a
hosted product. Expect to read some code. You need:

- **Node 22+** and **Bun 1.2+**.
- **MongoDB with Atlas Search and Vector Search.** That's either MongoDB
  Atlas or the local Atlas stack in `docker/mongodb`, which needs a replica
  set because the wiki uses transactions.
- **Embeddings.** An Atlas Model API (Voyage) key, so pages and raw items
  are embedded automatically.
- **An OpenAI-compatible LLM endpoint** for distillation, task extraction and
  answers. That can be a local llama.cpp or vLLM server behind LiteLLM, or a
  hosted API.

```bash
bun install
cp .env.example .env        # set SQRRL_WIKI_MONGODB_URI, SQRRL_API_KEY, SQRRL_LLM_*, VOYAGE_API_KEY
(cd docker && docker compose up -d)   # or point SQRRL_WIKI_MONGODB_URI at Atlas
bun run build

set -a; . ./.env; set +a
(cd apps/api && bun run start)        # API on :3847
(cd apps/web && bun run start)        # console on :3040 (NEXT_PUBLIC_SQRRL_API_URL at build time)
```

Open `http://localhost:3040/dashboard` and paste your API key. Then:

1. **Settings → You**: tell it which person page is you, and the names and
   addresses you go by.
2. **Settings → Models**: check the LLM, vision and transcription endpoints.
3. **Add a source**: the Mac agent, a Nextcloud folder, or a Slack token
   (Settings → Slack walks you through the app manifest).
4. **Run task review on a timer**: `POST /v1/wiki/task-review/run` every few
   minutes.

**Connect Claude (or any MCP client):**

```json
{
  "mcpServers": {
    "sqrrl": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/sqrrl/apps/mcp/src/server.ts"],
      "env": { "SQRRL_API_URL": "http://127.0.0.1:3847", "SQRRL_API_KEY": "<a scoped key>" }
    }
  }
}
```

Mint scoped keys for agents and devices with `POST /v1/admin/api-keys`, and
keep the master key for administration.

**Development:** `bun run test`, `bun run check-types`, `bun run lint`. Tests
are Vitest and sit next to the code. See `CLAUDE.md` for conventions.

## Status

- **Working daily:** Apple Notes, Nextcloud (documents, images,
  recordings), calendar, mail, the wiki, people identity, living tasks,
  cited answers, the console and MCP.
- **Built and tested against a fake API, waiting for a real workspace:** Slack.
- **Inherited from MDBrain and not maintained here:** the docs under
  `docs/` and `apps/docs`. They describe the upstream platform, and some of
  what they describe was removed here.

APIs and storage can change without notice. Issues and ideas are welcome.
Pull requests are best discussed in an issue first.

## Thanks

**[MDBrain](https://github.com/romiluz13/mdbrain) by Rom Iluz** is the
jumping-off point for all of this. Its MongoDB-native wiki engine, with
governed writes, revisions, hybrid search, graph traversal, OKF interchange
and scoped keys, is the foundation SQRRL is built on. MDBrain set out to
build a shared brain for a company. SQRRL took that engine and pointed it
at one person's day. If a governed wiki for agents and teams is what you
need, start there.

Also standing on:

- **Andrej Karpathy**: the LLM-wiki idea, where an LLM maintains a
  persistent, interlinked knowledge layer instead of retrieving chunks at
  query time.
- **[Google Open Knowledge Format](https://groundingpage.com/facts/open-knowledge-format/)**:
  page interchange.
- **[John Underwood's mdb-community-search](https://github.com/JohnGUnderwood/mdb-community-search)**:
  the local MongoDB stack.
- **[sigma.js](https://www.sigmajs.org/)**, **[graphology](https://graphology.github.io/)**,
  **[Hono](https://hono.dev/)**, **[Next.js](https://nextjs.org/)** and
  **[transformers.js](https://huggingface.co/docs/transformers.js)**.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. SQRRL is a derivative of MDBrain,
which is also Apache-2.0, and keeps its attribution.
