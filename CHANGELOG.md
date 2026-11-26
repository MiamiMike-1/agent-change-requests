# Changelog

## Unreleased

**SEP**

- Section 3: a new target type, `extension`, for requests about an extension itself, with an optional `component`. Servers must accept these, should relay them to the extension's maintainers without requester identity or task context, and should carry the answer back through the inbox. Rationale and Security Implications explain the relay.

**Server package**

- `target.type` accepts `extension`, with `target.component`. A request that targets the change requests extension under any vendor prefix is marked `about: "spec"`.
- New `UpstreamRelay` and `GitHubIssueSink`: forward requests about any extension to the tracker its maintainers name, one sink per extension identifier, and sync each issue's state back as `shipped` or `declined`.
- `ChangeRequestService` gains `setUpstream()` and `recordOf()` for the builder side.

**Client package**

- `Target` accepts `extension` and `component`. `component` is redacted like `name`, and the open-request check compares it.

## Changes feed and anonymous callers (November 25, 2026)

The last two protocol pieces the SEP's Reference Implementation section listed as missing.

**Server package 0.4.0**

- The changes feed (SEP section 12). `service.publishChange()` adds an entry from a release script; `changeRequests/changes` and a new `whats_new` tool return what shipped after `sinceVersion` or `since`, newest first, with `currentVersion` (the `McpServer`'s version by default). The feed needs no signed-in caller. Requester-only entries and `changeRequestIds` are shown only to their owners. `removed` entries are always breaking.
- The changes notice: `{ "changes": <count> }` in `_meta`, and the line "N changes may affect your use of this server. Call whats_new to see them.", for unread breaking and deprecated entries. Reading the feed clears it, a principal's first call sets where it starts, and `whats_new` with `notify: false` turns it off.
- The settings object now carries `changes: true`. `SqliteStore` and `MemoryStore` implement the new `ChangeFeedStore`; `migrations/postgres.sql` adds its two tables, and `runFeedStoreConformance` tests other stores.
- Anonymous callers (SEP section 3), off by default. With `anonymous: true`, a caller without a principal can submit and gets a `ticket`, a bearer credential for `changeRequests/get` (and `change_requests_get`) on that one request. No inbox, notice, withdraw, confirmation, or status events for them. They share one daily cap (`anonymousDailyCap`, default 50) and count as one principal toward demand.
- With `legacyTools: false` the notice is sent as `_meta` counts only, since there is no tool the lines could name (SEP section 7).
- New exports: `applyNotices`, `changesNoticeLine`, `noticeMeta`, `compareVersions`, `ANONYMOUS_PRINCIPAL`, `isChangeFeedStore`, `validateChange`.

**Client package 0.3.0**

- New `ChangesFeed`: reads the feed from the version the client last saw, records breaking and deprecated entries about the targets it uses in a ledger that outlives the session, calls `onChange` for each, and gives the model one `whats_new` tool. `changesCount()` reads the count from `_meta` or the text line.
- `modelContent()` and `inspect()` now also carry the changes line, after the update line, for hosts that show the model structured content: the server's own line, or one built from `_meta.changes` naming `whatsNewToolName` or the server's `whats_new`. New `changesNoticeLine()`; `inspect()` returns `changes` and `changesNotice`.
- Anonymous tickets: `submit()` keeps a returned ticket in the ledger, `get()` passes it, and the new `checkTickets()` reads open anonymous requests by ticket and reports shipped ones to `onShipped`.

**Demo**

- The release script publishes the 1.1.0 fix to the changes feed, and session 2 finds it there with its own request id.

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
