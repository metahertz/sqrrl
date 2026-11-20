#!/usr/bin/env bash
# One Slack → SQRRL sync pass, then exit. Meant to be run by a timer
# (see sqrrl-slack-sync.timer) every half hour or so. Pass --dry-run to list
# conversations and per-day message counts without writing anything.
#
# Settings come from an env file you keep private (chmod 600), for example:
#
#   SQRRL_API_URL=http://127.0.0.1:3847
#   SQRRL_API_KEY=<a scoped key with write capability>
#   SLACK_USER_TOKEN=xoxp-...
#   SLACK_STATE_FILE=/var/lib/sqrrl/slack-state.json
#
# Every SLACK_* option is in packages/connector-slack/src/config.ts.
set -euo pipefail

SQRRL_HOME="${SQRRL_HOME:-$HOME/sqrrl}"              # your checkout, built with `bun run build`
SQRRL_ENV_FILE="${SQRRL_ENV_FILE:-$HOME/.config/sqrrl/slack.env}"

set -a
# shellcheck disable=SC1090
. "$SQRRL_ENV_FILE"
set +a

# No token yet: exit quietly, so the timer can be enabled before the Slack
# app is approved and starts working as soon as a token is added.
if [ -z "${SLACK_USER_TOKEN:-}" ]; then
	echo "slack-sync $(date -u +%Y-%m-%dT%H:%M:%SZ): no SLACK_USER_TOKEN yet; skipped"
	exit 0
fi

export SQRRL_API_URL="${SQRRL_API_URL:-http://127.0.0.1:3847}"
export SLACK_STATE_FILE="${SLACK_STATE_FILE:-$SQRRL_HOME/connectors/slack/state.json}"
mkdir -p "$(dirname "$SLACK_STATE_FILE")"

exec node "$SQRRL_HOME/packages/connector-slack/dist/cli.js" "$@"
