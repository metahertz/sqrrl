# @sqrrl/inference-canary

Checks that a shared, OpenAI-compatible inference endpoint answers each
request from that request's own input. It exists because the sqrrl
vision nodes were found, on 2026-09-16, to answer images larger than one
llama.cpp micro-batch (512 tokens by default) from the previous request's
state. That was fixed on the servers (`--ubatch-size 2048`); the canary
guards against it coming back.

```sh
CANARY_BASE_URL=http://litellm:4000/v1 CANARY_API_KEY=... \
CANARY_VISION_MODELS=qwen3.5-122b CANARY_TEXT_MODELS=ornith-35b \
  sqrrl-inference-canary
```

## Probes

- **Vision.** A synthetic image with a random shape and color, plus a
  stamped one-time code (a 96 px band below the shape), at each of
  `CANARY_SIZES` (`WxH` or `WxH:jpeg`, the size of the shape). The default,
  `1024x416`, is sent as 1024x512 (512 image tokens). The scheduled run
  also probes `2048x928`, larger than the old micro-batch. Each
  result is labeled with the size sent and its approximate image-token
  count. The answer must give the shape and the color.
- **Text.** Several simultaneous requests, each carrying its own secret
  code to repeat. An answer containing another request's code is a leak.

Each result names the backend that served it (LiteLLM's
`x-litellm-model-id`) and llama.cpp's `timings.cache_n`.

| Verdict | Meaning | Contamination? |
|---|---|---|
| `ok` | Code and content right | no |
| `stamp-misread` | Content right, code misread; the model saw this image | no |
| `partial-image` | Code right, content wrong; the image was partly another | yes |
| `cross-request` | Content and code wrong; the code given back was the one stamped on, or read from, the previous request on the same backend; or another request's secret echoed | yes |
| `error` | The call failed | no |

Content is the primary signal: the model named shape and color correctly
on every clean PNG probe, while its reading of the stamp was unreliable.
A misread code is still useful. It is invented, so when the next request
on the same backend gives back that exact code, the answer carries the
previous request's output. That is how large images leaked on these
nodes before the fix, even when the shape and color were right. Only the previous request
on the same backend counts, and placeholder codes (`123456`, `ABCDEF`) are
ignored, because the model repeats its favorite inventions by chance.

Exit codes: `0` clean, `1` contamination, `2` configuration, `3` every
probe errored. `CANARY_REPORT_FILE` appends one JSON summary per run.
