#!/usr/bin/env bash
#
# Send Calendar.app events to the sqrrl API. Run this ON THE MAC.
#
#   SQRRL_API_URL=http://sqrrl.home.example:3847 \
#   SQRRL_API_KEY=mdb_xxx \
#   ./sqrrl-calendar-sync.sh
#
#   --days-back N      how far back to sync (default 30)
#   --days-ahead N     how far ahead to sync (default 14)
#   --all              a year back: the first run
#   --calendars "A,B"  only these calendars (default: all but holidays and
#                      birthdays; see --list-calendars). Also SQRRL_CALENDARS.
#   --include-declined include meetings you declined
#   --include-all-day  include all-day events (off: mostly OOO and holidays)
#   --list-calendars   print the calendars and exit
#   --dry-run          count what would be sent per week, send nothing
#   --redistill        rebuild meeting pages even for unchanged events
#                      (after a server upgrade changes how pages are built)
#
# Each week of the range is one request to /v1/raw/sync carrying every event
# that starts in it. The server stores them as raw items, retires events
# that have disappeared from that week (deleted or cancelled), and builds a
# meetings/ page per event linked to people/ pages for the attendees. No
# LLM is involved, so a year takes seconds, not hours. Re-running is cheap:
# unchanged events are skipped.
#
# The first run compiles sqrrl-calendar-export.swift with the Xcode
# Command Line Tools (xcode-select --install) into .build/ next to this
# script, and macOS asks once for access to your calendars.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_URL="${SQRRL_API_URL:-${MDBRAIN_API_URL:-}}"
API_KEY="${SQRRL_API_KEY:-${MDBRAIN_API_KEY:-}}"
SCOPE_REF="${SQRRL_SCOPE_REF:-${MDBRAIN_SCOPE_REF:-default}}"
CALENDARS="${SQRRL_CALENDARS:-${MDBRAIN_CALENDARS:-}}"
BACK=30
AHEAD=14
DRY=0
LIST=0
REDISTILL=false
EXPORT_FLAGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --days-back)        BACK="${2:-}"; shift ;;
    --days-ahead)       AHEAD="${2:-}"; shift ;;
    --all)              BACK=365 ;;
    --calendars)        CALENDARS="${2:-}"; shift ;;
    --include-declined) EXPORT_FLAGS+=("$1") ;;
    --include-all-day)  EXPORT_FLAGS+=("$1") ;;
    --list-calendars)   LIST=1 ;;
    --dry-run)          DRY=1 ;;
    --redistill)        REDISTILL=true ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
for n in "$BACK" "$AHEAD"; do
  case "$n" in ''|*[!0-9]*) echo "error: day counts must be whole numbers" >&2; exit 2 ;; esac
done
[ -z "$CALENDARS" ] || EXPORT_FLAGS+=(--calendars "$CALENDARS")

# --- build the exporter -------------------------------------------------------

SRC="$HERE/sqrrl-calendar-export.swift"
BIN="$HERE/.build/sqrrl-calendar-export"
if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ]; then
  command -v swiftc >/dev/null 2>&1 || {
    echo "error: swiftc not found; install the Command Line Tools: xcode-select --install" >&2
    exit 2
  }
  echo "compiling the calendar exporter (first run only)..."
  mkdir -p "$HERE/.build"
  # macOS shows the usage string in the permission prompt, and refuses
  # calendar access to a binary without one.
  cat > "$HERE/.build/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>dev.sqrrl.calendar-export</string>
	<key>CFBundleName</key>
	<string>sqrrl calendar export</string>
	<key>NSCalendarsUsageDescription</key>
	<string>sqrrl reads your meetings to link them to people and notes in your wiki.</string>
	<key>NSCalendarsFullAccessUsageDescription</key>
	<string>sqrrl reads your meetings to link them to people and notes in your wiki.</string>
</dict>
</plist>
EOF
  swiftc -O -o "$BIN" "$SRC" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/.build/Info.plist"
  # A stable identifier keeps the calendar permission attached to the
  # binary across runs.
  codesign --force --sign - --identifier dev.sqrrl.calendar-export "$BIN" >/dev/null
fi

if [ "$LIST" -eq 1 ]; then
  "$BIN" --list-calendars
  exit 0
fi

if [ "$DRY" -eq 0 ]; then
  [ -n "$API_URL" ] || { echo "error: set SQRRL_API_URL (e.g. http://sqrrl.example:3847)" >&2; exit 2; }
  [ -n "$API_KEY" ] || { echo "error: set SQRRL_API_KEY" >&2; exit 2; }
  if ! curl -fsS --max-time 15 "$API_URL/ready" >/dev/null 2>&1; then
    echo "error: $API_URL/ready is not responding — check the address, the port and any firewall" >&2
    exit 2
  fi
fi

# --- one request per week ------------------------------------------------------

# Weeks are aligned to Monday 00:00 UTC, so a re-run sends the same windows
# and each event always lands in the same one.
windows="$(python3 -c '
import datetime as dt, sys
back, ahead = int(sys.argv[1]), int(sys.argv[2])
now = dt.datetime.now(dt.timezone.utc)
start = (now - dt.timedelta(days=back)).replace(hour=0, minute=0, second=0, microsecond=0)
start -= dt.timedelta(days=start.weekday())
end = now + dt.timedelta(days=ahead)
fmt = "%Y-%m-%dT%H:%M:%SZ"
while start < end:
    nxt = start + dt.timedelta(days=7)
    print(start.strftime(fmt), nxt.strftime(fmt))
    start = nxt' "$BACK" "$AHEAD")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ok=0; failed=0; total_events=0
while read -r from to; do
  "$BIN" --from "$from" --to "$to" ${EXPORT_FLAGS[@]+"${EXPORT_FLAGS[@]}"} > "$TMP/week.json" || {
    rc=$?
    echo "error: the exporter failed for $from (exit $rc); see the message above" >&2
    exit 1
  }
  n="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["items"]))' "$TMP/week.json")"
  total_events=$((total_events + n))
  printf '  %s  %3d event(s)  ' "${from%%T*}" "$n"
  if [ "$DRY" -eq 1 ]; then echo "(dry run)"; continue; fi

  python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
d.update({"scope": "workspace", "scopeRef": sys.argv[2], "source": "calendar",
          "redistill": sys.argv[4] == "true"})
json.dump(d, open(sys.argv[3], "w"))' "$TMP/week.json" "$SCOPE_REF" "$TMP/body.json" "$REDISTILL"
  resp="$(curl -sS --max-time 300 -X POST "$API_URL/v1/raw/sync" \
            -H "authorization: Bearer $API_KEY" \
            -H 'content-type: application/json' \
            --data-binary "@$TMP/body.json" 2>&1)" || resp='{"error":"request failed"}'
  if printf '%s' "$resp" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: print("unparseable response"); raise SystemExit(1)
if "error" in d: print("error: " + str(d["error"])[:100]); raise SystemExit(1)
m = (d.get("distilled") or {}).get("meetings") or {}
errs = m.get("errors") or []
print("new %d, changed %d, removed %d -> pages +%d ~%d, people +%d%s" % (
    d.get("created", 0), d.get("updated", 0), d.get("retired", 0),
    m.get("created", 0), m.get("updated", 0), m.get("peopleCreated", 0),
    ("  ERRORS: " + str(errs[:2])) if errs else ""))
raise SystemExit(1 if errs else 0)'; then
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
  fi
done <<< "$windows"

echo
echo "$total_events event(s); $ok week(s) sent, $failed failed"
[ "$failed" -eq 0 ] || exit 1
