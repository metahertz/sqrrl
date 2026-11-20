// Old MDBRAIN_* settings still work (packages/lib/src/legacy-env.ts).
import "@sqrrl/lib/legacy-env"
import { availableParallelism } from "node:os"
import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { ConfigError, loadConfig } from "./config.js"
import {
	createDecoder,
	probeDuration,
	resolveFfmpeg,
	sweepScratch,
} from "./decode.js"
import { loadWhisperThread } from "./engine-thread.js"
import { JobQueue } from "./queue.js"

let config: ReturnType<typeof loadConfig>
try {
	config = loadConfig(process.env, availableParallelism())
} catch (err) {
	console.error(err instanceof ConfigError ? `config: ${err.message}` : err)
	process.exit(2)
}

const ffmpeg = resolveFfmpeg(config.ffmpegPath)
// Staged uploads a crash left behind; anything this old is not in use.
sweepScratch(config.tmpDir, 12 * 3600 * 1000).then(
	(removed) =>
		removed.length > 0 &&
		console.error(`removed ${removed.length} stale scratch dir(s)`),
	() => {},
)
const started = Date.now()
// One engine per worker, each on its own thread: a transformers.js pipeline
// carries state across a generate() call, so workers cannot share one, and
// its JS-side work would serialize on a shared main thread (engine-thread.ts).
// They load in parallel and in the background, so /health answers while
// weights download. The first load populates the cache directory and the
// rest read it, so this is not N downloads.
const engines = Array.from({ length: config.workers }, () =>
	loadWhisperThread(config, (err) => {
		// A dead slot would fail every job leased to it; restart instead
		// (the unit has Restart=always).
		console.error(`transcription worker died: ${err.message}`)
		process.exit(1)
	}),
)
Promise.all(engines).then(
	() =>
		console.error(
			`model ${config.modelId} (${config.dtype}) ready in ${Date.now() - started} ms — ` +
				`${config.workers} worker(s) x ${config.threads} thread(s)`,
		),
	(err) => {
		console.error(
			`model ${config.modelId} failed to load: ${err instanceof Error ? err.message : err}`,
		)
		process.exit(1)
	},
)

const app = createApp({
	config,
	engines,
	decode: createDecoder(ffmpeg, config.maxAudioSeconds, config.tmpDir),
	probe: (path, signal) => probeDuration(ffmpeg, path, signal),
	queue: new JobQueue(config.maxQueue, config.workers),
})

const server = serve(
	{ fetch: app.fetch, hostname: config.host, port: config.port },
	(info) => {
		console.error(
			`sqrrl-transcriber listening on http://${info.address}:${info.port} (models: ${config.modelAliases.join(", ")})`,
		)
	},
)

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 5000).unref()
	})
}
