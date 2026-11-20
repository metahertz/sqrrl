# @sqrrl/connector-nextcloud

Syncs a Nextcloud instance into the sqrrl wiki: files selected by **folder** or
**system tag**, and notes from the **Notes app** selected by category. Documents,
images and recordings are turned into text first, so they go through the same
git-diff maintenance as any other source: an LLM title, summary and claims, plus
task extraction and graph edges. The extracted text itself is kept verbatim as
raw items in Layer 1 (`/v1/raw/items`), searchable with `/v1/raw/search`.

This is the first `SourceConnector` that does real work. The other connectors in
`@sqrrl/wiki-engine` (`wiki-connectors.ts`) are stubs that discover nothing.

## Running

```sh
sqrrl-nextcloud-sync            # one pass, then exit
sqrrl-nextcloud-sync --dry-run  # list what would be synced, write nothing
```

Scheduling belongs to a timer (systemd or cron), not to a daemon, so a crashed
pass never leaves a wedged process. Exit codes: `0` success, `1` some items
failed or discovery was incomplete, `2` configuration or authentication error.

## Configuration

| Variable | Default | |
|---|---|---|
| `NEXTCLOUD_URL` | required | Origin, including any subpath install |
| `NEXTCLOUD_USER` / `NEXTCLOUD_APP_PASSWORD` | required | Use an app password, not the login password |
| `NEXTCLOUD_FOLDERS` | | Comma-separated, recursive, relative to the account root |
| `NEXTCLOUD_TAGS` | | System tag names |
| `NEXTCLOUD_NOTES_CATEGORIES` | | Includes subcategories; `*` selects every note |
| `NEXTCLOUD_SCOPE` / `NEXTCLOUD_SCOPE_REF` | `workspace` / `nextcloud` | Where pages are written |
| `NEXTCLOUD_PRIVACY_TIER` | `internal` | Stamped on every page |
| `NEXTCLOUD_VISION_MODEL` | empty | Chat model that accepts image input |
| `NEXTCLOUD_TRANSCRIPTION_MODEL` | empty | Model served at `/audio/transcriptions` |
| `NEXTCLOUD_AI_BASE_URL` / `_API_KEY` | `SQRRL_LLM_BASE_URL` / `_KEY` | OpenAI-compatible endpoint for both |
| `NEXTCLOUD_MAX_FILE_BYTES` | 50 MiB | Documents and images; larger ones are skipped without downloading |
| `NEXTCLOUD_MAX_MEDIA_BYTES` | 2 GiB | Audio and video, which are streamed to disk |
| `NEXTCLOUD_FFMPEG_PATH` | bundled | Path to another ffmpeg; `none` sends recordings whole |
| `NEXTCLOUD_AUDIO_SEGMENT_SECONDS` | 600 | Recordings are transcribed in segments this long |
| `NEXTCLOUD_MAX_RAW_UPLOAD_BYTES` | 25 MiB | Without ffmpeg, larger recordings are refused |
| `NEXTCLOUD_MAX_SCANNED_PAGES` | 100 | Scanned pages read per PDF; the rest are noted |
| `NEXTCLOUD_PDF_RENDER_SCALE` | 2 | Scanned-page render scale (1 = 72 dpi) |
| `NEXTCLOUD_MAX_IMAGE_EDGE` | 1600 | Images are downscaled to this before captioning |
| `NEXTCLOUD_TRANSCRIPTION_BASE_URL` / `_API_KEY` | the AI endpoint | Separate endpoint for speech, such as the local transcriber |
| `NEXTCLOUD_VERIFY_IMAGES` | `0` | `1` stamps images with a code the model must read back |
| `NEXTCLOUD_VERIFY_RETRIES` | 2 | Extra attempts after a failed read-back |
| `NEXTCLOUD_MAX_PART_CHARS` | 60000 | Longer text is split into part pages |
| `NEXTCLOUD_STATE_FILE` | `nextcloud-sync-state.json` | Etags and slugs between runs |
| `NEXTCLOUD_AI_TIMEOUT_MS` / `NEXTCLOUD_WIKI_TIMEOUT_MS` | 10 min / 15 min | Local models are slow |
| `SQRRL_API_URL` / `SQRRL_API_KEY` | required | The API the pages are written through |

At least one of folders, tags or note categories must be set. A run with nothing
selected would otherwise conclude that everything was deleted.

**Permissions do not carry over.** The connector reads as one account, so
everything that account can see in the selection becomes readable to wiki
readers of the target scope. Use a dedicated account with only the intended
folders shared to it, and a separate scope for each audience.

## What becomes of each file

| Type | Extraction | Notes |
|---|---|---|
| Notes, `.md`, `.txt`, `.csv`, `.json`, `.vtt`, `.srt` | as-is | HTML is stripped |
| PDF | text layer via `unpdf`; scanned pages rendered and transcribed by the vision model | Capped per document; pages still waiting for a model are noted |
| docx, pptx, xlsx, odt, odp, ods | read directly from the zip's XML | No LibreOffice needed |
| PNG, JPEG, WebP, GIF, HEIC/HEIF | re-encoded as PNG (HEIC decoded first), downscaled, then described by the vision model, with any text transcribed | |
| Audio, video | ffmpeg → 16 kHz mono MP3 segments → transcription endpoint | Transcript carries `[hh:mm:ss]` marks per segment |
| Anything else | skipped | Recorded at its etag so it is not downloaded again |

### Local tools

All bundled as npm dependencies, so the host needs neither root nor system
packages. `sqrrl-nextcloud-sync` prints what it found at startup.

| Package | Does | License |
|---|---|---|
| `ffmpeg-static` | Splits and re-encodes recordings, and drops video | GPL-3.0-or-later (a separate binary, run as a process) |
| `@napi-rs/canvas` | Renders PDF pages; decodes, resizes and re-encodes images | MIT |
| `pdfjs-dist` | Supplies the 14 standard PDF fonts, so pages render their text on a host with no fonts installed | Apache-2.0 |
| `heic-decode` | Decodes HEIC/HEIF (libheif compiled to wasm) | ISC (libheif: LGPL-3.0) |

Vision and transcription still run on the AI endpoint, not the host.

### When a model is missing

A file that needs an unconfigured model is **parked**, not retried every
pass. It is recorded at its etag with `pending: "vision"` or
`"transcription"`, and synced again as soon as that model is configured (or
the file changes). A PDF with some scanned pages is synced straight away with
its text pages, and the scanned pages follow once a vision model is set.

### What the vision endpoint needed

Measured against `qwen3.5-122b` behind LiteLLM on 2026-09-16:

- **Large images were answered from the previous request's state.** An
  image longer than one llama.cpp micro-batch (512 tokens by default; one
  token per 32x32 px) came back described as the image sent before it,
  in PNG and JPEG alike: 0 of 21 right at 1152 image tokens and above.
  This was fixed on the servers on 2026-09-16 (`--ubatch-size 2048
  --image-max-tokens 2048`), not here; see "Cross-request contamination"
  in the ops runbook. The `@sqrrl/inference-canary` package watches for
  it coming back. Images are still sent as PNG, the one format every
  llama.cpp build reads (WebP is not).
- **Scanned pages are transcribed, not described.** Asking the model to
  describe a page of text, or list its figures, produced invented
  figures. The document prompt asks only for the text, and `[no text]`
  marks a blank page.
- **Stamp verification is opt-in** (`NEXTCLOUD_VERIFY_IMAGES=1`). Each
  image gets a black band reading `VERIFY` plus a one-time code, and
  answers that do not read it back are rejected. On this model the stamp
  was read exactly on 0 of 8 clean 1024 px PNGs whose content was
  described correctly, so it would reject good captions. It also cannot
  catch the partial corruption above, where the stamp was read correctly.
- **An earlier fix did nothing.** Leading each prompt with a hash of the
  image, to stop prompt-cache reuse, was removed. The servers report
  `cache_n=0` on every vision request, contamination was seen with the
  hash in place, and the model copied the hex into its verification line.

## Behavior worth knowing

- **Pages are keyed by Nextcloud file id**, not path (`sources/nextcloud/files/<fileid>`,
  `sources/nextcloud/notes/<id>`). Renaming or moving a file updates its page.
- **Change detection is per-item etag.** Notes use `pruneBefore` so unchanged notes
  arrive as bare ids. The note cursor is reset whenever the category selection
  or `EXTRACTOR_VERSION` changes, because a pruned note carries no category.
- **Deletions deprecate; they never delete.** A vanished item's pages get
  `frontmatter.status: "deprecated"`, and are restored to `stable` if the item
  returns. `DELETE /v1/wiki/<slug>` would tombstone the slug permanently.
- **Deletions are only inferred from a complete listing.** A failed folder, an
  unknown tag or a failed notes listing withholds stale marking for that source.
- **Failures split three ways.** Endpoint or API errors retry on the next
  pass. A missing model parks the file until the model is configured.
  Unsupported, undecodable or oversized files wait until their etag changes.
- **Raw text goes to Layer 1 first.** Each part's extracted text is written
  to `POST /v1/raw/items` (sourceId `file:<id>#<part>`) before its wiki page
  is distilled. The same text again is a no-op; a re-extraction whose text
  differs, as vision and transcription output does, becomes a new version.
  Retired parts get a tombstone version, never a delete.
- **Provenance uses the OKF frontmatter fields** the wiki schema already defines:
  `sources[].resource` links to the file in Nextcloud, `generated.by` records the
  extractor and its version, and `tags` carries the selecting tags or categories.
- **Long documents are split into part pages.** Part 1 keeps the base path, so a
  document that grows does not move its main page. Parts left over after a
  document shrinks are deprecated.

## Phase 2: image embeddings

Phase 1 turns images into text because Atlas Automated Embedding accepts only
`modality: "text"` (see the MongoDB Automated Embedding docs). Real image
vectors would need client-side embedding with a multimodal model, stored in a
separate vector field and index, since an index cannot mix models. That
reverses ADR 0006, which removed client-side embedding, so it should come with
an ADR amendment. The `sources` and `generated` provenance recorded here is what
phase 2 would use to find which pages came from images and where the originals are.
