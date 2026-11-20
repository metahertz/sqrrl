# @sqrrl/transcriber

Local speech-to-text on CPU with an OpenAI-compatible API, for hosts with no
GPU, no compiler and no Python. It runs Whisper through transformers.js on
ONNX Runtime; both ship prebuilt on npm and work on CPUs without AVX.

```
POST /v1/audio/transcriptions   multipart: file, model, response_format, language
GET  /v1/models
GET  /health                    no auth; reports model readiness and queue depth
```

`response_format` accepts `json` (default), `text`, `verbose_json`, `srt` and
`vtt`. Any audio or video ffmpeg can read is accepted; it is decoded to
16 kHz mono first, using the ffmpeg binary bundled by `ffmpeg-static`.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRANSCRIBER_API_KEY` | required | Bearer token. `TRANSCRIBER_ALLOW_NO_AUTH=1` skips it, on loopback only |
| `TRANSCRIBER_HOST` / `_PORT` | `127.0.0.1` / `3960` | |
| `TRANSCRIBER_MODEL` | `onnx-community/whisper-base.en` | Any ONNX Whisper export |
| `TRANSCRIBER_DTYPE` | `q8` | `fp32`, `fp16`, `q8`, `int8`, `uint8` or `q4` |
| `TRANSCRIBER_MODEL_ALIASES` | | Extra names accepted as `model`, e.g. `whisper-1` |
| `TRANSCRIBER_CACHE_DIR` | `./models` | Weights are downloaded here on first start |
| `TRANSCRIBER_MAX_QUEUE` | 8 | Requests waiting behind the running one; beyond that, 503 |
| `TRANSCRIBER_MAX_UPLOAD_BYTES` | 200 MiB | |
| `TRANSCRIBER_MAX_AUDIO_SECONDS` | 3 h | |
| `TRANSCRIBER_MAX_JOB_SECONDS` | 1800 | Running time (decode + transcription, not queue wait) before a job is stopped with 504 |
| `TRANSCRIBER_THREADS` | CPU count | ONNX Runtime intra-op threads |
| `TRANSCRIBER_FFMPEG_PATH` | bundled | |
| `TRANSCRIBER_TMP_DIR` | `/var/tmp` | Staged uploads and decoded samples. Must be disk-backed: files on a tmpfs `/tmp` are RAM charged to the service's memory limit |

A `model` the server does not serve gets 404 `model_not_found` rather than
silently being transcribed with a different model.

## Load and cancellation

- A request the queue cannot take gets 503 `queue_full` before its body is
  read. `Retry-After` is when a place should open, i.e. when the
  soonest-finishing running job should end: its audio (from the file
  header, then the decode) rounded up to 30 s Whisper windows, over the
  recent speed in windows per second, less its elapsed time; clamped to 5
  to 600 s. A job of unknown length counts as an average one; with nothing
  measured or nothing running it is 60 s.
- Uploads are parsed as they stream in (busboy) and the file is written
  straight to `TRANSCRIBER_TMP_DIR`, so an upload costs a few stream buffers
  of memory whatever its size. The size limit is enforced on the stream, so
  a chunked upload with no `Content-Length` is stopped at the limit (413).
  The staged file is removed on every outcome; scratch directories a crash
  leaves behind are swept at startup once 12 h old.
- A caller that disconnects while queued is dropped and never runs; one that
  disconnects while running is stopped. A job that runs past
  `TRANSCRIBER_MAX_JOB_SECONDS` is stopped and the caller gets 504
  `job_timeout`. Stopping is cooperative, at the next decoder step (usually
  under a second; up to one encoder pass). The worker thread is never killed:
  terminating it mid-inference aborts the whole process in onnxruntime-node.
- `/health` also reports `running`, `saturated` (every worker busy),
  `workers` and `queueLimit`.

## Isolation

Jobs run strictly one at a time. Each request decodes into its own buffer,
and the model is only ever inside one generate call, so no state is shared
between requests beyond the model weights. `app.test.ts` sends 12 concurrent
requests with different audio and checks that each response matches its own
input.

## Speed

Measured on a 1 vCPU QEMU guest with SSE4.2 only, 11 s clip:

| Model | Realtime factor | Memory |
|---|---|---|
| whisper-tiny.en q8 | 2.6x | 543 MB |
| whisper-base.en q8 | 1.4x | 726 MB |
| whisper-small.en q8 | 0.45x | 1.2 GB |

`engine.e2e.test.ts` runs the real model when `TRANSCRIBER_E2E_WAV` points
at the JFK "ask not" sample.
