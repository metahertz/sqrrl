#!/usr/bin/env bash
#
# Send Mail.app mail (Inbox and Sent) to the sqrrl API. Run this ON THE MAC.
#
#   SQRRL_API_URL=http://sqrrl.home.example:3847 \
#   SQRRL_API_KEY=mdb_xxx \
#   ./sqrrl-mail-sync.sh
#
#   --days-back N      how many days to (re)send (default 3)
#   --all              30 days back: the first run
#   --accounts "A,B"   only these Mail accounts (default all enabled ones).
#                      Also SQRRL_MAIL_ACCOUNTS.
#   --redistill        rebuild thread pages even when nothing changed (after
#                      a run whose LLM calls failed)
#   --dry-run          count messages per day, send nothing
#
# Each day goes to /v1/raw/mail. The server drops bulk mail (lists,
# newsletters, notifications, no-reply senders, auto-replies, calendar
# invitations), cuts quoted history, threads the rest and builds one wiki
# page per thread with its tasks, linked to the people in it. Re-sending is
# cheap: unchanged mail is a no-op and costs no LLM call.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_URL="${SQRRL_API_URL:-${MDBRAIN_API_URL:-}}"
API_KEY="${SQRRL_API_KEY:-${MDBRAIN_API_KEY:-}}"
SCOPE_REF="${SQRRL_SCOPE_REF:-${MDBRAIN_SCOPE_REF:-default}}"
ACCOUNTS="${SQRRL_MAIL_ACCOUNTS:-${MDBRAIN_MAIL_ACCOUNTS:-}}"
BACK=3
DRY=0
REDISTILL=false
while [ $# -gt 0 ]; do
  case "$1" in
    --days-back) BACK="${2:-}"; shift ;;
    --all)       BACK=30 ;;
    --accounts)  ACCOUNTS="${2:-}"; shift ;;
    --redistill) REDISTILL=true ;;
    --dry-run)   DRY=1 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$BACK" in ''|*[!0-9]*) echo "error: --days-back needs a whole number" >&2; exit 2 ;; esac

if [ "$DRY" -eq 0 ]; then
  [ -n "$API_URL" ] || { echo "error: set SQRRL_API_URL (e.g. http://sqrrl.example:3847)" >&2; exit 2; }
  [ -n "$API_KEY" ] || { echo "error: set SQRRL_API_KEY" >&2; exit 2; }
  if ! curl -fsS --max-time 15 "$API_URL/ready" >/dev/null 2>&1; then
    echo "error: $API_URL/ready is not responding — check the address, the port and any firewall" >&2
    exit 2
  fi
fi

# Local-midnight day windows, newest last.
windows="$(python3 -c '
import datetime as dt, sys
back = int(sys.argv[1])
today = dt.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
for i in range(back - 1, -1, -1):
    start = today - dt.timedelta(days=i)
    end = start + dt.timedelta(days=1)
    print(start.isoformat(), end.isoformat())' "$BACK")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
EXPORT_ARGS=()
[ -z "$ACCOUNTS" ] || EXPORT_ARGS+=(--accounts "$ACCOUNTS")
ok=0; failed=0
while read -r from to; do
  osascript -l JavaScript "$HERE/sqrrl-mail-export.js" --from "$from" --to "$to" ${EXPORT_ARGS[@]+"${EXPORT_ARGS[@]}"} > "$TMP/day.json" || {
    rc=$?
    echo "error: the Mail export failed for ${from%%T*} (exit $rc). Error -1743 means Terminal/the agent may not control Mail: allow it in System Settings -> Privacy & Security -> Automation" >&2
    exit 1
  }
  n="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["messages"]))' "$TMP/day.json")"
  printf '  %s  %4d message(s)  ' "${from%%T*}" "$n"
  if [ "$DRY" -eq 1 ]; then echo "(dry run)"; continue; fi
  # Requests stay under the API's body limit (2 MiB by default): at most 200
  # messages and about 1.5 MB each. Before that, each message is trimmed to
  # what the server reads: the headers it uses for threading and bulk
  # detection (Mail's full set can run to tens of KB of Received/DKIM lines)
  # and the first 64,000 characters of the body (it keeps 8,000 after
  # removing quoted history). What gets stored does not change.
  python3 -c '
import json, re, sys
KEEP = {"auto-submitted", "content-type", "from", "in-reply-to", "list-id",
        "list-post", "list-unsubscribe", "message-id", "precedence",
        "references", "subject", "x-autoreply", "x-autorespond"}
MAX_CONTENT, MAX_BYTES, MAX_MSGS = 64000, 1_500_000, 200
def trim_headers(raw):
    if not raw:
        return raw
    out, keep = [], False
    for line in str(raw).replace("\r\n", "\n").split("\n"):
        if line[:1] in (" ", "\t"):
            if keep: out.append(line)
            continue
        keep = line.split(":", 1)[0].strip().lower() in KEEP
        if keep: out.append(line)
    return "\n".join(out)
d = json.load(open(sys.argv[1]))
msgs = []
for m in d["messages"]:
    m["headers"] = trim_headers(m.get("headers"))
    c = m.get("content")
    if isinstance(c, str) and len(c) > MAX_CONTENT:
        m["content"] = c[:MAX_CONTENT]
    msgs.append(m)
chunks, cur, size = [], [], 0
for m in msgs:
    n = len(json.dumps(m).encode())
    if cur and (len(cur) >= MAX_MSGS or size + n > MAX_BYTES):
        chunks.append(cur); cur, size = [], 0
    cur.append(m); size += n
chunks.append(cur)
for i, part in enumerate(chunks):
    json.dump({"scope": "workspace", "scopeRef": sys.argv[2], "selfAddresses": d["selfAddresses"],
               "messages": part, "redistill": sys.argv[3] == "true"},
              open(f"{sys.argv[4]}/chunk-{i:03d}.json", "w"))' "$TMP/day.json" "$SCOPE_REF" "$REDISTILL" "$TMP"
  line=""; day_ok=1
  for chunk in "$TMP"/chunk-*.json; do
    resp="$(curl -sS --max-time 3600 -X POST "$API_URL/v1/raw/mail" \
              -H "authorization: Bearer $API_KEY" \
              -H 'content-type: application/json' \
              -w '\n%{http_code}' \
              --data-binary "@$chunk" 2>&1)" || resp=$'{"error":"request failed"}\n0'
    rm -f "$chunk"
    part="$(printf '%s' "$resp" | python3 -c '
import json, sys
raw = sys.stdin.read()
body, _, code = raw.rpartition("\n")
try: d = json.loads(body)
except Exception:
    print("HTTP %s: %s" % (code, " ".join(body.split())[:80] or "empty response")); raise SystemExit(1)
if isinstance(d.get("error"), dict): d["error"] = d["error"].get("message") or d["error"].get("code")
if "error" in d: print("error: " + str(d["error"])[:100]); raise SystemExit(1)
s = d.get("skipped") or {}
t = d.get("threads")
th = t if isinstance(t, str) else ("threads %d, tasks +%d, people +%d" % (t.get("distilled", 0), t.get("tasksCreated", 0), t.get("peopleCreated", 0)) if t else "no thread changes")
errs = (t or {}).get("errors") if isinstance(t, dict) else None
print("new %d, changed %d, bulk %d, invites %d -> %s%s" % (d.get("created", 0), d.get("updated", 0), s.get("bulk", 0), s.get("calendar", 0), th, ("  ERRORS: " + str(errs[:2])) if errs else ""))
raise SystemExit(1 if errs else 0)')" || day_ok=0
    line="${line:+$line; }$part"
  done
  echo "$line"
  if [ "$day_ok" -eq 1 ]; then ok=$((ok + 1)); else failed=$((failed + 1)); fi
done <<< "$windows"

echo
echo "$ok day(s) sent, $failed failed"
[ "$failed" -eq 0 ] || exit 1
