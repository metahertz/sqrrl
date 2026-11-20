// Old MDBRAIN_* settings still work (packages/lib/src/legacy-env.ts).
import "@sqrrl/lib/legacy-env"
import { serve } from "@hono/node-server"
import { createApp, registerGracefulShutdown } from "./app.js"
import { ensureDecisionWorker } from "./routes/decisions.js"
import { loadLiveSettings } from "./lib/runtime-settings.js"
import { closeWikiStore } from "./wiki-store-runtime.js"

// Console settings for the language model override the env files; names
// only are logged, never values.
try {
	const applied = await loadLiveSettings()
	if (applied.length)
		console.error(`console settings applied: ${applied.join(", ")}`)
} catch (err) {
	console.error(
		`console settings not applied: ${err instanceof Error ? err.message : err}`,
	)
}

const app = createApp()
// Resume console decisions queued before a restart. Best effort: the first
// request to /v1/wiki/decisions starts the worker too.
void ensureDecisionWorker().catch((err) =>
	console.error(
		`decision worker not started: ${err instanceof Error ? err.message : err}`,
	),
)

const port = Number(process.env.SQRRL_API_PORT ?? "3847")
const host = process.env.SQRRL_API_HOST ?? "127.0.0.1"

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
	console.error(`sqrrl-api listening on http://${info.address}:${info.port}`)
})

// Graceful shutdown: SIGTERM / SIGINT drain the server, close the store, then
// exit. Timeout is set short enough for container runtimes but long enough to
// let Mongo in-flight writes finish.
registerGracefulShutdown({
	signals: ["SIGTERM", "SIGINT"],
	process,
	closeServer: () =>
		new Promise<void>((resolve) => {
			try {
				server.close(() => resolve())
			} catch {
				resolve()
			}
		}),
	closeStores: closeWikiStore,
	exit: (code) => process.exit(code),
	timeoutMs: 15_000,
})
