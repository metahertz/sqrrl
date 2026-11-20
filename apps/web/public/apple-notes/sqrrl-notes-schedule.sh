#!/usr/bin/env bash
# Kept so existing instructions keep working: the scheduler now serves
# notes and calendar alike. See sqrrl-schedule.sh.
exec "$(dirname "$0")/sqrrl-schedule.sh" notes "$@"
