#!/usr/bin/env bash
#
# Export Apple Notes and submit them to the sqrrl API. Run this ON THE MAC.
#
#   SQRRL_API_URL=http://sqrrl.home.example:3847 \
#   SQRRL_API_KEY=mdb_xxx \
#   ./sqrrl-notes-sync.sh
#
#   --all       export every note, not just the ones changed since the last
#               run. Notes the server already holds unchanged are skipped
#               in seconds, so an interrupted --all run resumes cheaply.
#   --force     rebuild the wiki for every note sent, even unchanged ones
#               (e.g. after wiki pages were purged)
#   --dry-run   list what would be sent, export nothing, send nothing
#   --batch N   send N notes per request (default 1)
#
# --batch lets the server overlap the LLM work for the notes in a request.
# How much actually overlaps is the server's decision
# (SQRRL_ENRICHMENT_CONCURRENCY), so a batch bigger than the model server
# will serve simply queues there. Notes in a batch share a fate: if the
# request is rejected none of them are marked done and the next run resends
# the whole batch.
#
# Everything after the export is two HTTP calls per batch. The first stores
# the notes' own words as raw items (Layer 1, /v1/raw/items); the second
# builds the wiki from them: page, claims, task pages with owners and due
# dates, and the graph edges.
#
#   --no-memory accepted and ignored; conversational memory (memongo) was
#               retired and nothing is written there any more
#
# Nothing needs to reach back to this machine.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SQRRL_NOTES_DIR:-${MDBRAIN_NOTES_DIR:-$HOME/mdbrain-notes}}"
API_URL="${SQRRL_API_URL:-${MDBRAIN_API_URL:-}}"
API_KEY="${SQRRL_API_KEY:-${MDBRAIN_API_KEY:-}}"
# A slow local model takes minutes per note: the server makes two LLM calls.
TIMEOUT="${SQRRL_TIMEOUT:-${MDBRAIN_TIMEOUT:-900}}"

DRY=0
FORCE=0
BATCH=1
EXPORT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY=1;    EXPORT_ARGS+=("$1") ;;
    --no-memory) ;;
    --force)     FORCE=1 ;;
    --batch)     BATCH="${2:-1}"; shift ;;
    --batch=*)   BATCH="${1#*=}" ;;
    *)           EXPORT_ARGS+=("$1") ;;
  esac
  shift
done
case "$BATCH" in
  ''|*[!0-9]*|0) echo "error: --batch needs a positive integer" >&2; exit 2 ;;
esac

if [ "$DRY" -eq 0 ]; then
  [ -n "$API_URL" ] || { echo "error: set SQRRL_API_URL (e.g. http://sqrrl.example:3847)" >&2; exit 2; }
  [ -n "$API_KEY" ] || { echo "error: set SQRRL_API_KEY" >&2; exit 2; }
  # Fail before touching Notes if the endpoint is wrong or unreachable.
  if ! curl -fsS --max-time 15 "$API_URL/ready" >/dev/null 2>&1; then
    echo "error: $API_URL/ready is not responding — check the address, the port and any firewall" >&2
    exit 2
  fi
fi

SQRRL_NOTES_DIR="$OUT_DIR" osascript -l JavaScript "$HERE/sqrrl-notes-export.js" ${EXPORT_ARGS[@]+"${EXPORT_ARGS[@]}"}
[ "$DRY" -eq 0 ] || exit 0

shopt -s nullglob
bodies=("$OUT_DIR"/*.json)
if [ ${#bodies[@]} -eq 0 ]; then
  echo "nothing new to send"
  exit 0
fi

total=${#bodies[@]}
echo "$total note(s) to send in batches of $BATCH. The server runs two LLM"
echo "calls per note, so this is minutes per note on a local model, not"
echo "seconds. Ctrl-C is safe: a note is only marked done once the server has"
echo "accepted it, so re-running resumes. Notes the server already holds"
echo "unchanged skip the wiki step."
echo

# Merges N per-note bodies into one request. The exporter writes each note as
# a standalone body; the server takes many changedSources in a single call and
# overlaps their LLM work, so batching is what turns a faster model server
# into a faster import.
merge_bodies() {
  python3 -c '
import json, sys
out = None
for path in sys.argv[1:]:
    d = json.load(open(path))
    d.pop("raw", None)
    if out is None:
        out = d
    else:
        out["changedSources"].extend(d.get("changedSources") or [])
json.dump(out, sys.stdout)' "$@"
}

# Notes whose raw write landed but whose wiki build did not. Their raw item
# reads as unchanged on the next run, so this list is what stops them being
# skipped as "already in the wiki".
PENDING="$OUT_DIR/.wiki-pending"
touch "$PENDING"
is_pending() { grep -qxF "$1" "$PENDING"; }
set_pending() {
  local tmp="$PENDING.tmp" slug
  grep -vxF -f <(for slug in "${@:2}"; do echo "$slug"; done) "$PENDING" > "$tmp" || true
  if [ "$1" = add ]; then for slug in "${@:2}"; do echo "$slug" >> "$tmp"; done; fi
  mv "$tmp" "$PENDING"
}

ok=0; failed=0; skipped=0; n=0
started=$(date +%s)
for ((i = 0; i < total; i += BATCH)); do
  batch=("${bodies[@]:i:BATCH}")
  n=$((n + ${#batch[@]}))
  if [ "${#batch[@]}" -eq 1 ]; then
    slug="$(basename "${batch[0]}" .json)"
    # tr guards against control characters that survived the export; cut keeps
    # one long title from pushing the result off the line.
    label="$(sed -n 's/^title: "\(.*\)"$/\1/p' "$OUT_DIR/$slug.md" \
             | head -1 | tr -d '\000-\037' | cut -c1-34)"
    label="${label:-$slug}"
  else
    label="${#batch[@]} notes"
  fi
  printf '  [%3d/%3d] %-34s ' "$n" "$total" "$label"

  # Layer 1 first: the raw notes are the record the wiki is distilled from,
  # so a batch whose raw write fails is not distilled and stays queued.
  # Bodies exported before the exporter added "raw" have none; they go
  # straight to the wiki as before.
  python3 -c '
import json, sys
items, scope, ref = [], None, None
for path in sys.argv[1:]:
    d = json.load(open(path))
    scope, ref = d.get("scope", "workspace"), d.get("scopeRef", "default")
    if d.get("raw"):
        items.append(d["raw"])
json.dump({"scope": scope, "scopeRef": ref, "items": items}, sys.stdout)' "${batch[@]}" \
    > "$OUT_DIR/.raw.json"
  slugs=()
  for f in "${batch[@]}"; do slugs+=("$(basename "$f" .json)"); done
  rawline=""
  rawnew=1
  if grep -q '"items": \[{' "$OUT_DIR/.raw.json"; then
    rawresp="$(curl -sS --max-time "$TIMEOUT" -X POST "$API_URL/v1/raw/items" \
                 -H "authorization: Bearer $API_KEY" \
                 -H 'content-type: application/json' \
                 --data-binary "@$OUT_DIR/.raw.json" 2>&1)" || rawresp='{"error":"request failed"}'
    rawline="$(printf '%s' "$rawresp" | python3 -c '
import json,sys
try: d = json.load(sys.stdin)
except Exception: print("raw: unparseable response"); raise SystemExit(1)
if "error" in d: print("raw error: " + str(d["error"])[:80]); raise SystemExit(1)
print("raw+%s~%s" % (d.get("created", 0), d.get("updated", 0)))')" || {
      rm -f "$OUT_DIR/.raw.json"
      echo "$rawline"
      failed=$((failed + ${#batch[@]}))
      continue
    }
  fi
  rm -f "$OUT_DIR/.raw.json"

  # The server already holds every note in this batch word for word, and the
  # last wiki build for them succeeded: nothing to redo.
  if [ "$rawline" = "raw+0~0" ] && [ "$FORCE" -eq 0 ]; then
    rawnew=0
    for slug in "${slugs[@]}"; do is_pending "$slug" && rawnew=1; done
    if [ "$rawnew" -eq 0 ]; then
      echo "unchanged, already in the wiki"
      rm -f "${batch[@]}"
      skipped=$((skipped + ${#batch[@]}))
      continue
    fi
  fi

  merge_bodies "${batch[@]}" > "$OUT_DIR/.batch.json"
  resp="$(curl -sS --max-time "$TIMEOUT" -X POST "$API_URL/v1/wiki/maintenance" \
            -H "authorization: Bearer $API_KEY" \
            -H 'content-type: application/json' \
            --data-binary "@$OUT_DIR/.batch.json" 2>&1)" || resp='{"error":"request failed"}'
  rm -f "$OUT_DIR/.batch.json"

  # No jq dependency: a python3 one-liner reads the counts, and macOS ships
  # python3 with the Command Line Tools.
  line="$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d = json.load(sys.stdin)
except Exception: print("unparseable response"); raise SystemExit(1)
if "error" in d:
    print("error: " + str(d["error"])[:90]); raise SystemExit(1)
t = d.get("tasks") or {}
errs = d.get("errors") or []
print("claims=%s tasks+%s edges+%s%s" % (
    d.get("claimsAdded", 0), t.get("created", 0), t.get("edgesAdded", 0),
    ("  ERRORS: " + str(errs[:2])) if errs else ""))
raise SystemExit(1 if errs else 0)')" && rc=0 || rc=1

  echo "${rawline:+$rawline }$line"
  if [ "$rc" -eq 0 ]; then
    # Only drop the queued bodies once the server has accepted them, so a
    # failed batch is retried next run rather than silently lost.
    rm -f "${batch[@]}"
    set_pending del "${slugs[@]}"
    ok=$((ok + ${#batch[@]}))
  else
    set_pending add "${slugs[@]}"
    failed=$((failed + ${#batch[@]}))
  fi
done

elapsed=$(( $(date +%s) - started ))
echo
printf '%d sent, %d unchanged, %d failed in %dm%02ds\n' "$ok" "$skipped" "$failed" $((elapsed / 60)) $((elapsed % 60))
[ "$failed" -eq 0 ] || exit 1
