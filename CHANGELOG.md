# Changelog

## Server package 0.1.0 (November 24, 2026)

First version of `@agent-change-requests/server` in `packages/server`.

- Request validation with the field limits from SEP section 3, idempotency keys, and a per-caller daily cap.
- Lifecycle from `received` to `shipped`, with terminal statuses that never move again.
- Principal-scoped inbox, the update notice in `_meta` and as one line of text, and no inbox for shared credentials.
- Confirmation with per-test outcomes and adoption, kept apart from the server's own `shipped`.
- Scorecard with stages, hours to live, build time, human time, confirmed fix rate, adoption, contract failures, and gaps.
- An `about` tag (`app` or `spec`) so lessons about the standard itself can be gathered across servers. Requests that target the `change_requests_*` tools are tagged `spec` on their own.
- MCP adapter that registers the six `change_requests_*` tools and wraps any tool with the update notice.
- In-memory store, a store conformance suite, and a Postgres schema.
