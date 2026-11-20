# Publishing SQRRL 2.0

> **Inherited from MDBrain, not maintained.** This page describes the upstream
> MDBrain platform (including the Memongo memory layer SQRRL removed). See the
> top-level README for what SQRRL is.

Publish one coherent `2.0.0` cohort from the same commit:

1. `@sqrrl/lib`
2. `@sqrrl/wiki-engine`
3. `@sqrrl/memory-bridge`
4. `@sqrrl/client`
5. `@sqrrl/tools`
6. `@sqrrl/memory`

Before publishing:

```bash
bun install --frozen-lockfile
bun run lint
bun run check-types
bun run build
bun run test
bun run check-publishability
```

Inspect every packed tarball. It must contain built output and documentation,
must not contain source tests or secrets, and must declare exact `2.0.0`
dependencies on sibling public packages.
