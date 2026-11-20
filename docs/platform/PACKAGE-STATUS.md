# Package status

> **Inherited from MDBrain, not maintained.** This page describes the upstream
> MDBrain platform (including the Memongo memory layer SQRRL removed). See the
> top-level README for what SQRRL is.

| Package | Status | Role |
|---|---|---|
| `packages/wiki-engine` | supported | SQRRL-owned governed wiki and MongoDB store |
| `packages/memory-bridge` | supported | pinned Memongo HTTP gateway |
| `packages/client` | supported | public SQRRL HTTP client |
| `packages/tools` | supported | AI SDK tools for supported client operations |
| `packages/sqrrl-memory` | supported | aggregate client and gateway exports |
| `packages/lib` | runtime support | shared published types |

SQRRL does not ship or import a memory engine. Memongo owns memory storage and
is consumed only through the captured HTTP contract in `docs/contracts/memongo`.
