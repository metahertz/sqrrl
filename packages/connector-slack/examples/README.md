# Running the Slack connector on a timer

The connector is a one-shot command: each run syncs new and recently
changed Slack messages, then exits. These files are examples of how the
author runs it under systemd.

| File | What |
| --- | --- |
| `slack-sync.sh` | Loads settings from a private env file and runs one pass. With no token, it exits quietly. |
| `sqrrl-slack-sync.service` | A systemd user unit for one pass. |
| `sqrrl-slack-sync.timer` | Starts the service 30 minutes after the previous pass ends. |

Setup:

1. Create the Slack app from `../slack-app-manifest.json` (Settings → Slack
   in the console walks through it) and get the user token (`xoxp-...`).
2. Build: `bun run build` at the repo root.
3. Write the env file named in `slack-sync.sh` with `chmod 600`. Use a
   scoped API key, not the master key.
4. Try it: `./slack-sync.sh --dry-run`.
5. Install and enable the timer, as described at the top of the `.service` file.

macOS has no systemd. Run `slack-sync.sh` from a launchd agent with
`StartInterval` set to 1800 instead.
