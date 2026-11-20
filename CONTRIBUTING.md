# Contributing to SQRRL

SQRRL is a personal project: a self-hosted second brain for one person's
working life (see the README). It moves to suit how its author works, so
contributions are welcome but best started as an issue: describe the
problem or idea first, and we'll agree on a shape before you write code.

## Making a change

1. Fork [https://github.com/metahertz/sqrrl](https://github.com/metahertz/sqrrl) and branch from `main`.
2. Make one logical change. Keep files under ~500 lines and put tests next
   to the code (`*.test.ts`, Vitest).
3. Run the local checks, and make sure all of them pass:

   ```bash
   bun install
   bun run build
   bun run check-types
   bun run lint
   bun run test
   ```

4. Commit with a short, action-oriented message (`source-layer: resolve
   relay addresses`, `web: calm graph load`).
5. Open a pull request describing what changed and how you checked it.

## Ground rules

- **No personal data in the repo.** Tests and examples use made-up people
  and `example.*` / `*.test` domains. Never commit a real name, address,
  hostname, connection string or token.
- **Secrets stay out of logs and output.** Source text passes through
  `redactSecrets` before it is stored, embedded or sent to a model; keep it
  that way for any new ingestion path.
- **Suggest, don't decide.** Anything that changes the owner's data on its
  own (closing tasks, merging people) is proposed and waits for the owner
  to accept it.
- **American English** in code, comments and docs.

Conventions for coding agents are in `CLAUDE.md` (also `AGENTS.md`).
