# @agent-change-requests/client

Client side of the [Agent Change Requests extension](../../SEP-0000-agent-change-requests.md), for `Client` from `@modelcontextprotocol/sdk`. It covers what SEP section 9 makes the client's job:

- **Advertising, with consent.** The extension is advertised only when the user or operator turned it on for this server, and never from an ephemeral or incognito session.
- **One submission tool for the model.** Its input matches `changeRequests/submit`, and the client writes its description, not the server.
- **Redaction.** Every model-written field and every argument value goes through a redaction pass before it is sent, and a review hook lets the user see the cleaned request.
- **Client-side controls.** A daily cap per server, no second request for a gap already open, and acceptance tests only when the server takes them.
- **The inbox.** When any response carries an update count, the client reads its inbox, records what shipped, and tells you which workarounds are obsolete. Without consent, it removes the notice line instead.
- **Confirmation.** The client re-runs the acceptance tests it sent, under its own authorization, and confirms the result.

## Quick start

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChangeRequestsClient, FileLedger, changeRequestsCapabilities } from "@agent-change-requests/client";

const extensionId = "com.example/change-requests";
const consent = { consent: settings.changeRequestsEnabledFor("invoices"), ephemeral: session.incognito };

const client = new Client({ name: "my-agent", version: "1.0.0" }, {
  capabilities: changeRequestsCapabilities(extensionId, consent),
});
await client.connect(transport);

const changeRequests = new ChangeRequestsClient(client, {
  extensionId,
  ...consent,
  serverName: "Invoices",
  ledger: new FileLedger(".agent/change-requests/invoices.json"),
  redaction: { sensitiveValues: [user.name, workspace.name], foreignNames: otherServersToolNames },
  review: (draft, findings) => askUser(draft, findings), // optional
  onShipped: (status, entry) => notes.add(`${entry.title} shipped in ${status.version}; drop: ${entry.workaround}`),
});
```

Show the model the submission tool next to the server's own tools, and route calls to it:

```ts
const tools = [...(await client.listTools()).tools];
if (changeRequests.enabled()) tools.push(changeRequests.submissionTool());

// when the model calls it
const result = await changeRequests.callSubmissionTool(args);
```

Pass every result from the server through `inspect`:

```ts
const raw = await client.callTool({ name, arguments: args });
const { result, inbox } = await changeRequests.inspect(raw);
// inbox?.shipped lists requests that shipped with workaroundObsolete: true
```

After a request ships:

```ts
await changeRequests.retestAndConfirm(requestId); // re-runs its tests, confirms pass or fail
```

## The ledger

The server's status object does not return the acceptance tests or the target, and a session does not outlive its task. The ledger keeps what the client needs between sessions: each request's target, tests, workaround, last status, and the daily count behind the cap. `FileLedger` keeps one JSON file per server; `MemoryLedger` is for tests. Nothing in the ledger is sent anywhere.

## Redaction

`redactSubmission` replaces credentials (API keys, bearer tokens, JWTs, private keys, `password=` assignments, credentials in URLs), email addresses, phone numbers, IP addresses, file paths, and long opaque tokens with placeholders such as `<email>` and `<path>`. It also replaces the values only your app knows are sensitive (`sensitiveValues`) and the names of other servers' tools (`foreignNames`). The findings it returns name the field and the rule, never the removed value.

It is a safety net, not a guarantee. When the client cannot verify that a request is clean, give it a `review` hook (and `reviewAll: true` to review every request).

## Not in this version

- Anonymous tickets. Servers built on the matching server package do not accept anonymous requests.
- The changes feed (`changeRequests/changes`) and Events subscriptions. The inbox covers the return path; push delivery comes with an Events client.
- Per-request `_meta` advertisement on calls the app makes itself. The client advertises at `initialize`, which is what SDK 1.x servers read, and adds the per-request form on its own `changeRequests/*` calls.

## License

MIT.
