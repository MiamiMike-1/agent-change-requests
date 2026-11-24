# @agent-change-requests/server

Server side of the [Agent Change Requests extension](../../SEP-0000-agent-change-requests.md): agents tell your API or MCP server what is broken or missing, and your server answers back when the fix ships.

It handles the parts every server needs the same way:

- **Request rules:** the fields and limits in SEP section 3, idempotency keys, and a daily cap per caller.
- **Lifecycle:** `received` through `shipped`, with terminal statuses that never move again.
- **Inbox:** requests belong to the authenticated caller, not the session. Any later session collects the answer.
- **Update notice:** a count in `_meta` and one plain line of text on every tool result while an update is unread.
- **Confirmation:** the requester's own verdict on a shipped change, kept separately from the server's claim, plus whether it adopted the change.
- **Scorecard:** each request's stages and times, and the running numbers (time to live, build time, human time, confirmed fix rate, adoption, gaps).
- **MCP tools:** `change_requests_submit`, `_list`, `_get`, `_withdraw`, `_confirm`, and `_scorecard` on any `McpServer` from `@modelcontextprotocol/sdk`.

## What your app supplies

| Piece | What to provide |
|---|---|
| Storage | A `ChangeRequestStore`. `MemoryStore` is included for tests. For Postgres or Supabase, apply [`migrations/postgres.sql`](migrations/postgres.sql) and implement the interface against it, then run the conformance suite. |
| Auth | `getPrincipal(call)`: the user or account the server already authenticates. Return `null` when there is none. Never a session id. |
| Notify | `onEvent(event)`: called on every submit, status change, stage, confirmation, and withdrawal. Use it to tell whoever builds changes, or to publish MCP Events. |
| Build side | Call `transition()` when a request is triaged, planned, built, shipped, or declined, and `recordStage()` when it is approved, gets a pull request, merges, publishes, and goes live. A CI or release script is the natural place. |
| Settings | `appName`, `extensionId` (a vendor prefix such as `com.example/change-requests` until the identifier is approved), accepted `kinds`, and `dailyCap`. |

## Quick start

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChangeRequestService, MemoryStore } from "@agent-change-requests/server";
import { registerChangeRequestTools, withUpdateNotice } from "@agent-change-requests/server/mcp";

const service = new ChangeRequestService({
  store: new MemoryStore(),
  onEvent: (event) => console.log("change request", event.type, event.requestId),
});

const server = new McpServer({ name: "my-app", version: "1.4.0" });
const options = {
  service,
  appName: "My App",
  extensionId: "com.example/change-requests",
  getPrincipal: (call) => call.authInfo?.clientId ?? null,
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

## Store conformance

```ts
import { describe, it } from "vitest";
import { runStoreConformance } from "@agent-change-requests/server/testing";

runStoreConformance({ describe, it }, () => new MyPostgresStore(freshDatabase()));
```

## Not in this version

- Protocol methods (`changeRequests/submit` and the rest). The tools cover clients that don't implement the extension, which is nearly all of them today.
- Anonymous callers and tickets. `anonymous` is false.
- MCP Events delivery. `onEvent` is the hook to build it on.
- Evaluating acceptance tests. They are stored as data and never run.
- A Postgres or Supabase store. The schema is here, and the adapter comes with the first app that uses it.

## License

MIT. The specification in the root of this repository is CC0.
