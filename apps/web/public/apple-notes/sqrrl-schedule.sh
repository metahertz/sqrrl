#!/usr/bin/env bash
#
# Run a sync on a schedule with launchd. Run this ON THE MAC, from the
# folder the scripts were unpacked into (the agent runs them from there, so
# keep the folder where it is). JOB is notes (Apple Notes), calendar
# (Calendar.app) or mail (Mail.app); each is its own agent and log.
#
#   ./sqrrl-schedule.sh JOB install    # asks for URL, key, scope; then runs once
#   ./sqrrl-schedule.sh JOB run        # run now (output in the log)
#   ./sqrrl-schedule.sh JOB status
#   ./sqrrl-schedule.sh JOB uninstall
#
#   SQRRL_SYNC_INTERVAL   seconds between runs (default 3600)
#
# The URL, key and scope live in ~/.config/sqrrl/notes.env (mode 600),
# shared by both jobs, not in the plist: LaunchAgent plists are
# world-readable. Use a scoped key with write access to one scope
# (dashboard -> API keys), never the master key.
#
# Notes: before the first scheduled run, run ./sqrrl-notes-sync.sh
# --dry-run once from Terminal. macOS asks once whether the caller may
# control Notes, and a launchd job cannot show that prompt. If the log shows
# error -1743, allow it under System Settings -> Privacy & Security ->
# Automation.
#
# Mail: like notes, run ./sqrrl-mail-sync.sh --dry-run once from Terminal
# first; macOS asks whether the caller may control Mail (error -1743 if not).
#
# Calendar: the run that install starts asks for calendar access on behalf
# of sqrrl-calendar-export; allow it. Running from Terminal grants
# Terminal instead, which does not cover the agent.

set -euo pipefail

JOB="${1:-}"
case "$JOB" in
  notes|calendar|mail) shift ;;
  *) sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
LABEL="dev.sqrrl.$JOB-sync"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_DIR="$HOME/.config/sqrrl"
ENV_FILE="$ENV_DIR/notes.env"
LOG="$HOME/Library/Logs/sqrrl-$JOB-sync.log"
INTERVAL="${SQRRL_SYNC_INTERVAL:-${MDBRAIN_SYNC_INTERVAL:-3600}}"
DOMAIN="gui/$(id -u)"

xml_escape() {
  local s=$1
  # Quoted replacements: bash 5.2+ treats a bare & in one as the match.
  s=${s//&/"&amp;"}; s=${s//</"&lt;"}; s=${s//>/"&gt;"}
  printf '%s' "$s"
}

write_env() {
  local url key scope
  read -r -p "sqrrl API URL (e.g. http://sqrrl.example:3847): " url
  read -r -s -p "sqrrl API key (scoped, write): " key; echo
  read -r -p "Wiki scopeRef [default]: " scope
  [ -n "$url" ] && [ -n "$key" ] || { echo "error: URL and key are required" >&2; exit 2; }
  mkdir -p "$ENV_DIR"
  umask 077
  {
    printf 'SQRRL_API_URL=%q\n' "$url"
    printf 'SQRRL_API_KEY=%q\n' "$key"
    printf 'SQRRL_SCOPE_REF=%q\n' "${scope:-default}"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  # bash -c sources the env file at run time, so a rotated key needs no
  # reinstall: edit notes.env and the next run uses it.
  local cmd="set -a; . $(printf '%q' "$ENV_FILE"); set +a; exec $(printf '%q' "$HERE/sqrrl-$JOB-sync.sh")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>-c</string>
		<string>$(xml_escape "$cmd")</string>
	</array>
	<key>StartInterval</key>
	<integer>$INTERVAL</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
}

case "${1:-}" in
  install)
    [ -f "$ENV_FILE" ] && echo "Keeping existing $ENV_FILE (delete it to re-enter)." || write_env
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    write_plist
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed $LABEL: every ${INTERVAL}s, log $LOG"
    echo "Running once now..."
    launchctl kickstart "$DOMAIN/$LABEL"
    ;;
  run)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Started; follow with: tail -f $LOG"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
      | grep -E '^\s*(state|last exit code|runs|run interval) =' || echo "not installed"
    [ -f "$LOG" ] && { echo "--- last lines of $LOG"; tail -n 5 "$LOG"; }
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL. Credentials left in $ENV_FILE; delete that file if no longer needed."
    ;;
  *)
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
