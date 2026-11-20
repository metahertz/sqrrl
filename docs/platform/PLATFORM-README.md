# SQRRL platform

> **Inherited from MDBrain, not maintained.** This page describes the upstream
> MDBrain platform (including the Memongo memory layer SQRRL removed). See the
> top-level README for what SQRRL is.

SQRRL 2.0 is a governed wiki and orchestration gateway over Memongo HTTP.

```text
apps/api -> packages/memory-bridge -> Memongo HTTP
        \-> packages/wiki-engine -> wiki MongoDB
```

The two storage domains are separate. SQRRL never accesses Memongo
collections and Memongo never owns wiki collections. Use `/health` for process
liveness and `/ready` for dependency and contract readiness.

See:

- `docs/platform/self-host.md`
- `docs/platform/validation-pack.md`
- `docs/platform/capability-matrix.md`
- `docs/platform/publish.md`
