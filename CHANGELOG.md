# Changelog

## Spec draft: what's new (November 24, 2026)

- New Section 12: a changes feed (`changeRequests/changes`) so the people who build on a server hear about every shipped change, not only the ones they requested. Entries carry a version, type, `breaking` flag, plain summary, and a `removeAfter` date for deprecations.
- New server settings `changelogUri` and `changes`.
- The update notice can also count breaking changes and deprecations the caller has not read.
- Clients should tell their user about breaking changes and deprecations that affect tools they call.
- Two new open questions on where the feed belongs and how to describe migrations.

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
