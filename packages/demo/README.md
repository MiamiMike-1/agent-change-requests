# Invoices demo

A small MCP server with one deliberate gap, and a run of the whole change request loop against it.

**The gap.** In version 1.0.0, `list_invoices` returns every invoice, 50 per page, and cannot filter by customer or status. An agent that needs one customer's unpaid total has to page through all 230 invoices and filter on its side. Version 1.1.0 ships the fix.

**The integration** is one call in [`src/server.ts`](src/server.ts):

```ts
const changeRequests = installChangeRequests(server, {
  appName: "Invoices",
  extensionId: "com.example/change-requests",
  store: options.store, // a SQLite file
  getPrincipal: () => options.principal,
  policyUri: "https://github.com/MiamiMike-1/agent-change-requests",
});
```

## Run it

From the repository root:

```sh
npm ci
npm run build --workspace packages/server
npm run build --workspace packages/client
npm run demo --workspace packages/demo
```

The run writes `demo-state/transcript.md`. A scripted agent stands in for the model, so the run is the same every time:

1. **Session 1, server 1.0.0.** The agent pages through every invoice (5 calls) to total one customer's unpaid invoices. Its acceptance test fails against 1.0.0. It files a request through the client's `file_change_request` tool; the client redacts the customer's company name before sending. A second attempt to file the same gap is caught by the client.
2. **The vendor ships 1.1.0.** [`src/ship.ts`](src/ship.ts), standing in for a release script, moves the request to `shipped` with `workaroundObsolete: true`, and publishes a `1.1.0 added` entry to the changes feed that names the request.
3. **Session 2, server 1.1.0, a new connection.** The first tool result carries the update count. The client reads its inbox, records that the workaround is obsolete, re-runs its acceptance test (pass), and confirms. It also reads the changes feed from the version it saw in session 1 and finds the fix listed, with its own request id on it. The agent now gets the same total in one call.

`npm test --workspace packages/demo` runs the same loop and checks each step.

## With a real agent

The server also runs over stdio, so any MCP client can use it:

```sh
DEMO_VERSION=1.0.0 node packages/demo/dist/stdio.js   # the version with the gap
node packages/demo/dist/ship.js                       # the vendor ships the fix
DEMO_VERSION=1.1.0 node packages/demo/dist/stdio.js   # the fixed version
```

For example, with Claude Code: `claude mcp add invoices -e DEMO_VERSION=1.0.0 -- node packages/demo/dist/stdio.js`. A client without the extension sees the `change_requests_*` tools and the notice line instead of the protocol methods, which is how most agents reach the extension today. `DEMO_STORE` sets the SQLite file (default `demo-state/requests.db`) and `DEMO_PRINCIPAL` the user every call is made as.

### A recorded run

[`recordings/claude-code-2026-11-25`](recordings/claude-code-2026-11-25) is a real run with Claude Code in headless mode: the model files a request unprompted against 1.0.0, and a later session confirms the shipped fix. It also shows that the notice line does not reach Claude Code for a tool with an `outputSchema`. `scripts/record-claude.sh` records a new run.
