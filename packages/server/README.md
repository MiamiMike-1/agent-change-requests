# @agent-change-requests/server

Server side of the [Agent Change Requests extension](../../SEP-0000-agent-change-requests.md): agents tell your API or MCP server what is broken or missing, and your server answers back when the fix ships.

It handles the parts every server needs the same way:

- **Protocol methods:** `changeRequests/submit`, `/get`, `/list`, `/withdraw`, `/confirm`, and `/changes` as middleware for `McpServer`, advertised under `capabilities.extensions`, in one call.
- **SQLite store:** `SqliteStore` on `node:sqlite` (Node 22.5 and later) or `better-sqlite3`, so requests outlive the session that filed them.
- **Status events:** `changeRequest.updated` with the status object, handed to your Events implementation on every status change.

- **Request rules:** the fields and limits in SEP section 3, idempotency keys, and a daily cap per caller.
- **Lifecycle:** `received` through `shipped`, with terminal statuses that never move again.
- **Inbox:** requests belong to the authenticated caller, not the session. Any later session collects the answer.
- **Update notice:** a count in `_meta` and one plain line of text on every tool result while an update is unread.
- **What's new:** a version-keyed changes feed (SEP section 12) of everything the server ships, whoever asked for it, with a notice for unread breaking changes and deprecations that each caller can turn off.
- **Anonymous callers (opt in):** requests without a signed-in principal, each answered with a ticket that reads that one request.
- **Confirmation:** the requester's own verdict on a shipped change, kept separately from the server's claim, plus whether it adopted the change.
- **Scorecard:** each request's stages and times, and the running numbers (time to live, build time, human time, confirmed fix rate, adoption, gaps).
- **Health check:** a route that needs no credential and says whether the server can reach its store, without returning any data.
- **MCP tools:** `change_requests_submit`, `_list`, `_get`, `_withdraw`, `_confirm`, `_scorecard`, and `whats_new` on any `McpServer` from `@modelcontextprotocol/sdk`.

## What your app supplies

| Piece | What to provide |
|---|---|
| Storage | A `ChangeRequestStore`. `SqliteStore` (from `@agent-change-requests/server/sqlite`) works out of the box; `MemoryStore` is included for tests. For Postgres or Supabase, apply [`migrations/postgres.sql`](migrations/postgres.sql) and implement the interface against it, then run the conformance suite. `update()` must write only when the stored `revision` matches, so two writers never overwrite each other. |
| Auth | `getPrincipal(call)`: the user or account the server already authenticates. Return `null` when there is none. Never a session id, and never an OAuth client id, which every user of that client shares. |
| Notify | `onEvent(event)`: called on every submit, status change, stage, confirmation, and withdrawal. Use it to tell whoever builds changes, or to publish MCP Events. |
| Build side | Call `transition()` when a request is triaged, planned, built, shipped, or declined, and `recordStage()` when it is approved, gets a pull request, merges, publishes, and goes live. Call `publishChange()` for every change a caller can observe, asked for or not. A CI or release script is the natural place. |
| Settings | `appName`, `extensionId` (a vendor prefix such as `com.example/change-requests` until the identifier is approved), accepted `kinds`, and `dailyCap`. |

## Quick start: the protocol middleware

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installChangeRequests } from "@agent-change-requests/server/middleware";

const server = new McpServer({ name: "my-app", version: "1.4.0" });
const { service } = installChangeRequests(server, {
  appName: "My App",
  extensionId: "com.example/change-requests", // a vendor prefix until the identifier is approved
  store: "change-requests.db",                // a SQLite file, or any ChangeRequestStore
  getPrincipal: (call) => {
    const userId = call.authInfo?.extra?.userId; // the signed-in user, never authInfo.clientId
    return typeof userId === "string" ? userId : null;
  },
});

// Register your own tools after the install: their results carry the update notice.
server.registerTool("list_things", { description: "List things." }, async () => ({ content: [{ type: "text", text: "[]" }] }));
```

Call `installChangeRequests` before `server.connect()`. It:

- advertises the SEP section 1 settings object under `capabilities.extensions[extensionId]` in the `initialize` result (SDK 1.x has no `server/discover` yet; the object is the same),
- answers the `changeRequests/*` methods (`/changes` too, when the store keeps the feed), with errors as JSON-RPC `-32602` and `data.reason` from SEP section 10, and the update count in each result's `_meta`,
- registers the `change_requests_*` tools for clients that do not implement the extension, and hides `change_requests_submit` from clients that do, so the model sees one way to submit (`legacyTools: false` turns the tools off),
- wraps every tool registered after it with the update notice (`noticeOnAllTools: false` turns that off; `withUpdateNotice` is returned for tools registered earlier),
- with `publishEvent`, advertises `events: true` and hands a `changeRequest.updated` event with the status object to your Events implementation on every status change. List `changeRequestUpdatedEventType` in your `events/list` and deliver each event only to subscriptions its `principal` holds.

One `McpServer` serves one connection, so hiding the submit tool is per client.

When `legacyTools` is false the server exposes no tool the notice lines could name, so it sends only the `_meta` counts, as SEP sections 7 and 12 require.

## What's new: the changes feed

`SqliteStore` and `MemoryStore` also keep the changes feed, so the middleware advertises `changes: true`, answers `changeRequests/changes`, and registers a `whats_new` tool. Publish entries from your release script:

```ts
await service.publishChange({
  version: "1.5.0",
  type: "deprecated",            // added, changed, deprecated, removed, or fixed
  summary: "export_csv is deprecated. Use export_report with format csv.",
  changed: [{ type: "tool", name: "export_csv" }],
  removeAfter: "2027-02-01",
  changeRequestIds: ["crq_..."], // requests this resolved; each owner sees only its own ids
});
```

- `changeRequests/changes` takes `sinceVersion` or `since`, plus `cursor` and `limit`, and returns `currentVersion` (the `McpServer`'s version unless you pass `currentVersion`) and the entries after that point, newest first. Versions compare as semantic versions; pass `compareVersions` for another scheme.
- It needs no signed-in caller. Anonymous callers and shared credentials see the entries marked `availability: "all"`; a signed-in principal also sees `requester` entries released to it.
- `removed` entries are always breaking. Set `breaking: true` on any other change that can make a call that worked before fail.
- Each signed-in principal gets `{ "changes": <count> }` in `_meta` and the line "N changes may affect your use of this server. Call whats_new to see them." while breaking or deprecated entries are unread. Reading the feed clears it. A principal's first call sets the starting point, so new callers are not told about old deprecations. `whats_new` with `notify: false` turns the notice off for that principal (`service.setChangeNotice()` does the same).
- `changes: false` turns the feed off. A database store implements `ChangeFeedStore` next to `ChangeRequestStore`, or you pass a separate one as `feed`. [`migrations/postgres.sql`](migrations/postgres.sql) has the two tables.

Set `changelogUri` too, so people without an agent can read the same list.

## Anonymous callers

Off by default. Turn it on only with another abuse control in front of the server, as the SEP's security section advises:

```ts
installChangeRequests(server, { /* ... */ anonymous: true, anonymousDailyCap: 50 });
```

- When `getPrincipal` returns `null`, `changeRequests/submit` still accepts the request and returns a `ticket` (`crt_...`). The ticket is a bearer credential for `changeRequests/get` (and `change_requests_get`) on that one request: pass `requestId` and `ticket`. A wrong ticket reads as `not_found`.
- Anonymous callers have no inbox, no update notice, no withdraw, no confirmation, and no status events.
- They share one principal, `ANONYMOUS_PRINCIPAL`: one daily cap across all of them (`anonymousDailyCap`, default 50), and one unit of demand however many of them ask. A signed-in principal with that value is refused.
- The store keeps the ticket so a repeated idempotency key gets the same answer back, so treat the store as holding credentials.

The [demo server](../demo) uses exactly this, and [`@agent-change-requests/client`](../client) is the matching client.

## Quick start: tools only

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChangeRequestService, MemoryStore } from "@agent-change-requests/server";
import {
  registerChangeRequestTools,
  withUpdateNotice,
  type McpAdapterOptions,
} from "@agent-change-requests/server/mcp";

const service = new ChangeRequestService({
  store: new MemoryStore(),
  onEvent: (event) => console.log("change request", event.type, event.requestId),
});

const server = new McpServer({ name: "my-app", version: "1.4.0" });
const options: McpAdapterOptions = {
  service,
  appName: "My App",
  extensionId: "com.example/change-requests",
  // The signed-in user your auth layer puts on the request. Not authInfo.clientId,
  // which every user of the same OAuth client shares.
  getPrincipal: (call) => {
    const userId = call.authInfo?.extra?.userId;
    return typeof userId === "string" ? userId : null;
  },
};

registerChangeRequestTools(server, options);

// Wrap your own tools so their results carry the update notice too.
server.registerTool(
  "list_things",
  { description: "List things." },
  withUpdateNotice(options, async () => ({ content: [{ type: "text", text: "[]" }] })),
);
```

On the build side:

```ts
await service.recordStage(requestId, "approved", new Date().toISOString());
await service.transition(requestId, { status: "building" });
await service.transition(requestId, {
  status: "shipped",
  version: "1.5.0",
  resolution: { availability: "all", workaroundObsolete: true },
});
```

The requester sees the update the next time it calls any wrapped tool, reads it with `change_requests_list`, re-runs its acceptance test, and reports with `change_requests_confirm`.

## Reporting back to the spec

Every request carries `about`: `app` for the server's own tools, or `spec` for the change request tools and the standard itself. A request that targets one of the `change_requests_*` tools is marked `spec` on its own, and an agent can set it for anything else about the standard.

Because every server that uses this package computes the same scorecard and the same tag, their numbers line up. A periodic job can read each server's `change_requests_scorecard` and `change_requests_list` with `about: "spec"`, and draft one cross-server report for the spec's maintainers: the numbers per server and the lessons about the standard, written without any server's data.

### Relaying requests to the spec's maintainers

An agent can also file a request about the extension itself with `target: { type: "extension", name: "<extension id>", component: "spec" | "server-sdk" | "client-sdk" }`. Those are marked `spec` too. The same target works for any extension the server implements. To send them one level up, attach an `UpstreamRelay`:

```ts
import { GitHubIssueSink, UpstreamRelay } from "@agent-change-requests/server";

const relay = new UpstreamRelay({
  service,
  // One sink per extension, keyed by its identifier: wherever that extension's
  // maintainers say they accept requests.
  sinks: {
    "com.example/change-requests": new GitHubIssueSink({
      repo: "example-org/change-requests-spec",
      token: process.env.UPSTREAM_GITHUB_TOKEN!,
    }),
  },
  // Also relay spec requests that target a change_requests_* tool.
  extensionId: "com.example/change-requests",
  serverName: "Example MCP",
});
relay.attach(); // forwards each new spec request after submit answers

// On a schedule: closed as completed -> shipped, closed as not planned -> declined.
await relay.sync();
```

The relay sends only `kind`, `title`, `description`, `target`, `failureMode`, and `impact`. It never sends the principal, `context`, or acceptance tests, and it neutralizes `@` mentions. It forwards at most 20 requests a day by default (`maxPerDay`). On forwarding, a `received` request moves to `triaged` with the issue link as its message, so the requester can follow it. The issue is public, so say so in your policy (SEP section 3). An extension with no entry in `sinks` is not relayed: its requests stay on this server like any other. The token must be able to create issues in each repository. For a tracker other than GitHub, write your own `UpstreamSink`.

## Store conformance

```ts
import { describe, it } from "vitest";
import { runStoreConformance } from "@agent-change-requests/server/testing";

runStoreConformance({ describe, it }, () => new MyPostgresStore(freshDatabase()));
// If it also keeps the changes feed:
runFeedStoreConformance({ describe, it }, () => new MyPostgresStore(freshDatabase()));
```

## Health check

A deployed server should be able to say whether it is up and can reach its store without anyone signing in first. Leave one route open and send it to `healthResponse`, before your credential check:

```ts
import { healthResponse, isHealthRequest } from "@agent-change-requests/server";

async function handle(request: Request): Promise<Response> {
  if (isHealthRequest(request)) {
    return healthResponse({
      store,
      method: request.method,
      extensionId: "com.example/change-requests",
      version: "1.4.0", // leave out to keep your version private
      onError: (error) => console.error("change request store unreachable", error),
    });
  }
  // ...check credentials, then handle MCP as usual
}
```

`GET <your MCP URL>/health` then answers `200 {"ok":true,"store":"reachable",...}`, or `503` with `"store":"unreachable"` when the store fails or takes longer than `timeoutMs` (3 seconds by default). `isHealthRequest` matches only GET and HEAD on a path ending in `/health`, so every other route keeps its credential check.

The route is public, so the answer is a fixed shape: no records, no counts, and never the error text, which goes to `onError` only. The probe is one read of a request id that does not exist. If your store can check itself more cheaply or more thoroughly, give it an optional `ping()` and the health check uses that. For a server that is not built on `Request` and `Response`, call `checkHealth(options)` and send the report yourself.

## Install and stay current

```sh
npm install @agent-change-requests/server
```

Each release has a version number and an entry in the repository's [CHANGELOG](../../CHANGELOG.md). Patch and minor versions don't break existing calls; a major version can. To get an update pull request whenever a new version is published, add this to `.github/dependabot.yml` in your app's repository:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    allow:
      - dependency-name: "@agent-change-requests/server"
```

The `allow` list keeps Dependabot to this package only. Drop it if you want updates for every dependency.

## Releasing (maintainers)

1. Update `version` in `packages/server/package.json` and add a CHANGELOG entry.
2. Merge to `main`, then push a tag named `server-v` plus the version, for example `server-v0.2.0`.
3. The release workflow runs the tests, builds, and publishes to npm with provenance.

The workflow publishes through npm trusted publishing, so no npm token is stored. Set it up on npmjs.com under the package's **Settings**, **Trusted publishing**, **GitHub Actions**, with this repository and the workflow file `release-server.yml`. The workflow passes no npm token: if one is set, npm publishes with it instead of trusted publishing, and npm refuses it once the package requires two-factor authentication.

## Not in this version

- MCP Events delivery itself. The SDK has no Events implementation yet, so `publishEvent` hands each `changeRequest.updated` event to yours.
- Evaluating acceptance tests. They are stored as data and never run.
- A Postgres or Supabase store. The schema is here, and the adapter comes with the first app that uses it.

## License

MIT. The specification in the root of this repository is CC0.
