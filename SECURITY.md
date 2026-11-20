# Security Policy

SQRRL holds personal data: notes, mail, messages, meetings. Treat a
vulnerability here as a privacy problem, not just a bug.

## Supported versions

Only the current `main` branch. There are no released packages.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use
GitHub's private vulnerability reporting:
[https://github.com/metahertz/sqrrl/security/advisories/new](https://github.com/metahertz/sqrrl/security/advisories/new).

Include:

- the affected package or app,
- reproduction steps,
- the impact, and whether source data, secrets or API keys could be exposed.

Reports are acknowledged within 7 days, and a fix is coordinated before
details are published.

## If you run SQRRL

- Keep the master API key for administration; give agents and devices
  scoped keys (`POST /v1/admin/api-keys`).
- Don't expose the API or console to the internet without a proper
  reverse proxy and TLS in front.
- Secrets that appear in your sources are redacted before storage, but
  rotate any credential you find in a note anyway.
