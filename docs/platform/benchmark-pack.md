# Benchmark pack

> **Inherited from MDBrain, not maintained.** This page describes the upstream
> MDBrain platform (including the Memongo memory layer SQRRL removed). See the
> top-level README for what SQRRL is.

SQRRL does not expose Memongo benchmark or relevance-admin routes. Retrieval
evaluation runs through the supported SQRRL API surface:

```bash
bun run memory-eval
bun run compare-memory-eval
bun run agent-smoke
```

Archive the API version, pinned Memongo contract version/SHA-256, dataset
digest, environment, and output artifact with every result. Treat benchmark
failures as release blockers only when the dataset and dependency contract are
identical to the accepted baseline.
