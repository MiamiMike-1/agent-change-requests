# Changelog

## Client 0.2.0 (November 25, 2026)

- The client now carries the update notice for hosts that show the model a tool's `structuredContent` in place of its text, as SEP section 7 asks. `inspect()` returns `notice` and `modelContent`, and the new `noticeLine()` and `modelContent()` work without reading the inbox. The line is the server's own when present, or one built from the `_meta` count that names an inbox tool the model can call (`inboxToolName`, or the server's `change_requests_list`). It is withheld without consent or in an ephemeral session.
- New export `updateNoticeLine(count, tool)`.

## Reference implementation (November 25, 2026)

The three parts the SEP's Reference Implementation section plans, built on `@modelcontextprotocol/sdk` 1.x.

**Server package 0.3.0**

- New `installChangeRequests(server, options)` in `@agent-change-requests/server/middleware`: adds the extension to any `McpServer` in one call. It advertises the settings object under `capabilities.extensions`, answers `changeRequests/submit`, `/get`, `/list`, `/withdraw`, and `/confirm` with the error reasons from SEP section 10, and puts the update count in each result's `_meta`.
- The update notice is added to every tool registered after the install.
- The `change_requests_*` tools stay for clients without the extension. Clients that advertise it no longer see `change_requests_submit`, so the model sees one way to submit.
- Status events: with `publishEvent`, every status change produces a `changeRequest.updated` event carrying the status object, and the server advertises `events: true`. `changeRequestUpdatedEventType` is the entry for `events/list`.
- New `SqliteStore` in `@agent-change-requests/server/sqlite`, on `node:sqlite` (Node 22.5 and later) or `better-sqlite3`. It passes the store conformance suite.
- `ChangeRequestService` gains `subscribe()` for extra listeners and `statusOf()` for reading a status object without clearing its update.
- `registerChangeRequestTools` now returns the tools it registered.

**Client package 0.1.0 (new)**

- `@agent-change-requests/client` wraps `Client` from the SDK. It advertises the extension only with consent and never from an ephemeral session, gives the model one submission tool whose description the client writes, and redacts credentials, contact details, paths, and app-supplied sensitive values before sending.
- Client-side controls: a daily cap per server, no second request for a gap that is already open, and an optional review hook.
- `inspect()` reads the inbox when a result carries an update count, records shipped requests and obsolete workarounds in a ledger that outlives the session, and strips the notice line when the client has no consent.
- `retestAndConfirm()` re-runs the client's own acceptance tests and confirms with per-test outcomes.

- New release workflow, `release-client.yml`: a `client-vX.Y.Z` tag runs the client's tests and publishes it to npm with provenance, the same way the server package is released.

**Demo**

- `packages/demo`: an invoices server whose `list_invoices` cannot filter by customer in 1.0.0 and can in 1.1.0. `npm run demo` runs the loop from the gap to a confirmed shipped change and writes a transcript. CI runs it on every pull request.
- `packages/demo/recordings/claude-code-2026-11-25`: a recorded run with a real model (Claude Code, headless), from an unprompted request against 1.0.0 to a `pass` confirmation on 1.1.0, with findings. `scripts/record-claude.sh` records a new one.

## Spec draft: reference implementation status (November 25, 2026)

- The Reference Implementation section now describes the server package that exists, and lists what is still missing before review: the protocol methods, status events, the changes feed, anonymous callers, a home in the official TypeScript SDK, client support, and the demonstration server.

## Server package 0.2.0 (November 24, 2026)

- New health check, so anyone can confirm a deployed server is up and can reach its store without signing in or copying a token. `healthResponse` answers `200` with `"store": "reachable"` or `503` with `"store": "unreachable"`, and `isHealthRequest` picks out `GET /health` so it can run before the credential check.
- The answer never includes records, counts, or error text. The reason for a failure goes to the server's own `onError` hook.
- Stores may add an optional `ping()`. Without one, the check reads a single request id that does not exist.
- The store conformance suite now checks that a store passes the health check.

## Releases (November 24, 2026)

- `@agent-change-requests/server` is set up to publish to npm from a `server-v*` tag, with tests and provenance. Apps install it with `npm install` and can get update pull requests from Dependabot.
- Tests, typecheck, and build now run on every pull request.

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
