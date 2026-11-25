# SEP-0000: Agent Change Requests Extension (Draft)

Draft of November 22, 2026 · Mike Lingle

## Preamble

| Field | Value |
| --- | --- |
| SEP | 0000 (placeholder until the pull request is opened) |
| Title | Agent Change Requests Extension |
| Author | Mike Lingle (@MiamiMike-1 on GitHub, @miamimike_ on X) |
| Sponsor | None yet |
| Status | Idea (not yet submitted) |
| Type | Extensions Track |
| Proposed identifier | `io.modelcontextprotocol/change-requests` |
| Targets | MCP specification 2026-07-28 and later |
| PR | Not yet opened |
| Builds on | SEP-3415 Events Extension (optional, for push delivery) |
| Related discussion | GitHub Discussion #2369, Opt-In Client Experience Feedback Mechanism for MCP Server Maintainers |

## Abstract

This SEP proposes an optional extension that gives agents a standard way to tell an MCP server what is broken or missing, and gives servers a standard way to answer.

Agents routinely hit gaps while using MCP servers: a tool that lacks a parameter, an error that explains nothing, a capability that does not exist. Several server vendors now expose ad hoc feedback tools to capture this. Each uses a different name and schema, and none defines how the agent learns that its request was addressed.

The extension defines five things:

1. A common request object covering bugs, friction, missing capabilities, and feature requests.
2. Optional acceptance tests: declarative examples of the call the agent wanted to make and the result it expected.
3. A status lifecycle from `received` to `shipped` or `declined`.
4. A principal-scoped inbox, with optional push delivery through the Events extension, so that a later session can learn the outcome after the requesting session has ended.
5. Requester confirmation: the party that asked reports whether the shipped change worked, which gives third parties evidence the server does not control.

The extension is opt-in on both sides and adds no requirements to the core protocol. How a server builds, prioritizes, or ships a change is out of scope.

## Motivation

The core protocol lets a server describe what it offers. It gives a client no way to describe what it needed and did not get. Server authors currently learn about gaps from logs, support tickets, and guesswork, although the agent at the point of failure usually knows exactly what would have helped.

Vendors have started closing this gap on their own. [Sanity](https://www.sanity.io/blog/how-to-get-product-feedback-from-agents), [Vercel](https://vercel.com/docs/agent-resources/vercel-mcp/tools/documentation/submit_feedback), [Netlify](https://www.netlify.com/changelog/2026-11-03-agents-can-send-netlify-feedback/), and [Clerk](https://clerk.com/changelog/2026-10-23-agent-feedback) each ship a feedback tool on their MCP servers, and [LaunchDarkly](https://launchdarkly.com/blog/stories-from-the-factory-floor-empowering-agents-with-launchdarkly-mcp-tools/) reports more than 100 tickets and merged pull requests from about a week of agent reports. The demand is proven. The implementations share four problems:

- **No common shape.** Tool names in the wild include `submit_feedback`, `give_feedback`, `feedback_submit`, `send_feedback`, and `request_feature`, each with its own fields. Clients cannot build consent, redaction, or reporting once and apply it everywhere.
- **No return path.** The agent receives a thank-you and nothing more. By the time a fix ships, the requesting session is gone, so workarounds stay in codebases long after they are needed.
- **No verifiable definition of done.** Requests arrive as prose. The server team must infer what the agent wanted, and nobody can check mechanically whether the shipped change satisfies it.
- **No shared identity or abuse model.** Some vendors record who is asking, and some accept unauthenticated submissions from any client. With no common rule, servers cannot weigh requests consistently or keep out spam.

The pattern is not limited to MCP. [Fly.io](https://fly.io/changelog/agents-can-now-send-us-feedback/) accepts agent feedback through its REST API, tied to a request ID or a URL, and [Medusa](https://medusajs.com/blog/two-things-every-mcp-author-should-add) added a `submit_medusa_feedback` tool to its documentation server. Inside the MCP community, [Discussion #2369](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2369), opened in March 2026, proposes opt-in client experience feedback: the client's model reviews a session and sends anonymized, structured observations about tool design to the server's maintainers. That proposal has a full SEP draft and a prototype SDK branch. It has drawn 13 comments, several from people building similar tooling, and none from a project maintainer. Every one of these efforts flows one way.

A shared extension fixes these once. Server authors get structured, deduplicable demand. Client authors get one consent and redaction surface. Agents get an answer.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

### 1. Identifier and negotiation

The extension identifier is `io.modelcontextprotocol/change-requests`. Prototypes built before acceptance MUST use a third-party vendor prefix instead.

A server that supports the extension advertises it in the `server/discover` response:

```json
{
  "capabilities": {
    "extensions": {
      "io.modelcontextprotocol/change-requests": {
        "kinds": ["bug", "friction", "missing_capability", "feature_request"],
        "acceptanceTests": true,
        "events": true,
        "anonymous": false,
        "policyUri": "https://example.com/change-requests-policy"
      }
    }
  }
}
```

A client that supports the extension advertises it in `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` on each request, with a settings object of `{}`.

| Server setting | Type | Meaning |
| --- | --- | --- |
| `kinds` | string array, required | The request kinds the server accepts. At least one. |
| `acceptanceTests` | boolean, default false | The server stores and evaluates acceptance tests. |
| `events` | boolean, default false | The server publishes status changes as an event type through the Events extension (SEP-3415). |
| `anonymous` | boolean, default false | The server accepts requests without an authenticated principal. |
| `policyUri` | string, optional | A human-readable page describing how requests are used and retained. |
| `changelogUri` | string, optional | A human-readable page listing the server's shipped changes. See Section 12. |
| `changes` | boolean, default false | The server answers `changeRequests/changes` (Section 12). |

A client MUST NOT call the methods below unless the server advertises the extension.

### 2. Methods

| Method | Purpose |
| --- | --- |
| `changeRequests/submit` | Create a request. |
| `changeRequests/get` | Read the current status of one request. |
| `changeRequests/list` | Read the caller's requests, filtered by status or time. This is the inbox. |
| `changeRequests/withdraw` | Withdraw a request the caller no longer needs. |
| `changeRequests/confirm` | Report whether a shipped change satisfied the request. |
| `changeRequests/changes` | Read what the server has shipped since a given version or time, whoever asked for it. |

### 3. Submitting a request

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "changeRequests/submit",
  "params": {
    "kind": "missing_capability",
    "title": "list_invoices cannot filter by customer",
    "description": "Fetching one customer's invoices requires paging through every invoice.",
    "target": { "type": "tool", "name": "list_invoices" },
    "context": {
      "goal": "Total unpaid invoices for one customer",
      "workaround": "Paged all 4,200 invoices and filtered client-side",
      "cause": "The tool may predate customer-level access controls"
    },
    "failureMode": "interface_cost",
    "impact": {
      "blocked": false,
      "frequency": "recurring",
      "severity": "medium",
      "detectability": "immediate"
    },
    "acceptanceTests": [
      {
        "description": "Filter by customer returns only that customer's invoices",
        "call": {
          "method": "tools/call",
          "params": { "name": "list_invoices", "arguments": { "customer_id": "cus_123" } }
        },
        "expect": {
          "isError": false,
          "structuredContentSchema": {
            "type": "object",
            "properties": {
              "invoices": {
                "type": "array",
                "items": { "properties": { "customer_id": { "const": "cus_123" } } }
              }
            },
            "required": ["invoices"]
          }
        }
      }
    ],
    "idempotencyKey": "b7e1c0d4-5a1f-4f0e-9c1b-2e6a8d3f7a10"
  }
}
```

| Field | Requirement | Rules |
| --- | --- | --- |
| `kind` | Required | One of the server's advertised `kinds`. |
| `title` | Required | At most 120 characters. |
| `description` | Required | At most 4,000 characters. Plain text. |
| `target` | Optional | `type` is `tool`, `resource`, `prompt`, or `server`. `name` is required unless `type` is `server`. |
| `context` | Optional | `goal`, `workaround`, `cause`, and `attempts` (at most 5 prior calls with their outcomes). `cause` is the agent's hypothesis about why the gap exists, at most 500 characters. |
| `failureMode` | Optional | How the surface failed. One of the base modes below, or a vendor-prefixed mode. |
| `impact` | Optional | `blocked` is a boolean. `frequency` is `once` or `recurring`. `severity` is `low`, `medium`, or `high`. `detectability` is `immediate`, `eventual`, or `hidden`. |
| `acceptanceTests` | Optional | At most 10. Allowed only when the server advertises `acceptanceTests`. |
| `idempotencyKey` | Required | A client-generated unique string. |

The server responds with the request's identifier and initial status:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "requestId": "crq_01JD3Q8Z",
    "status": "received",
    "duplicateOf": null,
    "demand": 1,
    "ticket": "crt_4c8a91e2"
  }
}
```

Normative requirements:

- A server MUST return the original result when it receives a repeated `idempotencyKey` from the same caller.
- A server MAY merge a request into an existing one. It MUST then set `duplicateOf` to the surviving `requestId` and SHOULD return that request's `demand` count.
- A server MUST return `ticket` when the caller is anonymous. The ticket is a bearer credential for `changeRequests/get` on that one request.
- A server MUST reject a request whose `kind` it did not advertise.
- A server MUST NOT reject a request because of an unrecognized `failureMode`. It SHOULD store the value unchanged.
- A server and any reader of a request MUST treat `context.cause` as the requester's hypothesis, not a finding, and MUST NOT present it as the established cause.

`kind` says what the requester wants. `failureMode` says how the surface failed, so that the same mechanism can be counted across tools and servers. The base failure modes are:

| Failure mode | Meaning |
| --- | --- |
| `capability_missing` | The capability the requester needed does not exist. |
| `interface_cost` | The capability exists, but its shape (parameters, formats, paging) makes the caller pay for it. |
| `data_gap` | Documented or expected data is absent, stale, or wrong. |
| `discoverability` | The capability or state exists, but nothing told the requester where to find it. |
| `scope_not_honored` | A parameter documented as narrowing the result did not change it. |
| `silent_failure` | The call reported success, but no work landed or the result reflected an earlier state. |

A vendor-prefixed mode such as `com.example/quota_reset` MAY be used for a mechanism the base list does not cover.

`detectability` follows the detection axis of failure modes and effects analysis (FMEA). `immediate` means the call itself showed the failure. `eventual` means the requester noticed later in the task. `hidden` means only outside evidence revealed it, for example a later read that contradicted a reported success.

### 4. Acceptance tests

An acceptance test is a declarative example. It names one call the agent wanted to make and the result it expected. It is data. It is never code.

- `call.method` MUST be `tools/call`, `resources/read`, or `prompts/get`.
- `expect` MAY contain `isError` (boolean), `structuredContentSchema` (a JSON Schema), and `textContains` (an array of at most 5 strings).
- A server MUST NOT execute an acceptance test against production data on behalf of the submitter. A server evaluates tests in an environment it controls, with fixtures it chooses.
- A server that marks a request `shipped` SHOULD report a per-test outcome of `pass`, `fail`, or `not_evaluated`.

### 5. Lifecycle

| Status | Meaning | Next statuses |
| --- | --- | --- |
| `received` | Stored, not yet reviewed. | `triaged`, `needs_info`, `declined`, `duplicate` |
| `needs_info` | The server cannot act without more detail. | `triaged`, `declined`, `withdrawn` |
| `triaged` | Reviewed and understood. No commitment yet. | `planned`, `declined` |
| `planned` | The server intends to address it. | `building`, `declined` |
| `building` | Work is in progress. | `shipped`, `declined` |
| `shipped` | Terminal. A change is available. | None |
| `declined` | Terminal. The server will not address it. | None |
| `duplicate` | Terminal. Merged into another request. | None |
| `withdrawn` | Terminal. The caller withdrew it. | None |

A server MUST NOT move a request out of a terminal status. A server MAY skip intermediate statuses. A caller MAY move its own request from any non-terminal status to `withdrawn` by calling `changeRequests/withdraw` with the `requestId`.

### 6. Status object

`changeRequests/get` takes `requestId` (and `ticket` for anonymous callers) and returns:

```json
{
  "requestId": "crq_01JD3Q8Z",
  "status": "shipped",
  "updatedAt": "2026-11-19T14:02:11Z",
  "demand": 37,
  "message": "list_invoices now accepts customer_id.",
  "resolution": {
    "availability": "all",
    "changed": [{ "type": "tool", "name": "list_invoices" }],
    "changelogUri": "https://example.com/changelog#2026-11-19",
    "workaroundObsolete": true,
    "tests": [{ "index": 0, "outcome": "pass" }]
  }
}
```

- `resolution` MUST be present when `status` is `shipped`.
- `availability` is `requester` when the change is live only for the requesting principal, and `all` when it is generally available.
- `message` MUST be present when `status` is `declined` or `needs_info`.

### 7. The inbox

Agent sessions are short-lived. The durable reply address is the authenticated principal, not the session.

- A server MUST bind each request to the authenticated principal that submitted it, when one exists.
- `changeRequests/list` MUST return only the caller's own requests. It accepts `status` (array), `updatedSince` (timestamp), and `cursor`.
- A server MAY announce pending updates by adding `_meta["io.modelcontextprotocol/change-requests"]` with `{ "updates": <count> }` to any response sent to the principal, whether or not the client advertised the extension. Few clients implement the extension yet, and a server that announced updates only to clients that advertised it would reach almost no one.
- The notice goes only to the authenticated principal that owns the requests. A server MUST NOT send it to anonymous callers, and MUST NOT send it, or return inbox contents, under a credential that the server knows unrelated users share, since every holder of that credential would appear as the same principal.
- Clients do not reliably show `_meta` to the model. A server that announces updates SHOULD also end each tool result with one fixed line of text that gives the count and names a way to read the inbox that the client can actually call. A client that does not implement the extension cannot call `changeRequests/list`, so the line MUST name a tool the server exposes for the inbox, for example: "3 of your change requests have an update. Call change_requests_list to see them." A server that exposes no such tool MUST NOT send the line. The line MUST NOT include request titles, messages, or any other request content.
- A server that sends the line SHOULD let the principal turn it off.
- A client that sees a nonzero count, in `_meta` or in the text line, SHOULD read the inbox. Reading a request through `changeRequests/list` or `changeRequests/get`, or the tool that serves them, marks its update as seen, so the count falls to zero once the requester has collected it.
- Answers go to the principal, not to the session that asked. Any session of that principal may collect them, and the first one that reads a request clears its update for all of them. A zero count therefore means only that nothing is unread, not that nothing changed: a session relying on a workaround SHOULD check the request's status rather than wait for the notice.
- A client SHOULD surface `shipped` results with `workaroundObsolete: true` to the user or record them where a later session will find them.

### 8. Status events

Push delivery of status changes uses the Events extension (`io.modelcontextprotocol/events`, SEP-3415). This extension defines no delivery mechanism of its own.

- A server that sets `events: true` MUST also advertise the Events extension and MUST list an event type named `changeRequest.updated` in `events/list`.
- The event's `payloadSchema` MUST be the status object from Section 6. Its `inputSchema` MAY accept a `requestId` argument that filters the subscription to one request.
- The server MUST emit one event on every status change, and MUST deliver it only to subscriptions held by the principal that submitted the request.
- The server SHOULD offer `poll` delivery at minimum, so that a client with no public endpoint can resume from a stored cursor in a later session.
- Subscription, cursors, replay, webhook signing, endpoint verification, and expiry are governed entirely by the Events extension.
- `changeRequests/list` remains REQUIRED. It is the fallback for clients that do not implement Events.

### 9. Consent, privacy, and redaction

**Consent**

- A client MUST NOT send a request unless the user or the deploying operator has enabled the extension for that server. Consent MUST be explicit, per server, and revocable at any time. It MUST be separate from any other consent, such as acceptance of terms of service.
- An operator MAY set a default for a group of users, and MAY set different defaults for different servers.
- A client MUST NOT advertise the extension or submit requests from an ephemeral or incognito session. No setting overrides this rule.
- An update notice (Section 7) is not consent. A server cannot tell whether a client has consented or is ephemeral, so the notice may reach a client that has neither. A client that has not enabled the extension for that server, has revoked consent, or is running an ephemeral or incognito session MUST NOT act on the notice, and SHOULD NOT pass the line to the model when it can remove it.
- A server MUST NOT degrade, limit, or price its service differently for clients that do not advertise the extension or that never submit.

**Content that must not be sent**

- A request MUST NOT contain credentials, personal data, the user's own words, resource contents, file paths, or database names.
- Argument values in `context.attempts` and in acceptance tests MUST be synthetic examples or placeholders, unless the user has approved sending the real values.
- A request MUST NOT name or describe tools or data from any other server connected to the same client.
- A client SHOULD pass every model-written field through a redaction step before sending, and SHOULD let the user review a request when the client cannot verify that it is clean.

**Identity minimization**

- The server learns the submitter as the principal it already authenticates. A client MUST NOT add further identifiers, such as session, device, or user names.

**Client-side controls**

- A client SHOULD cap submissions per server per day, and SHOULD tell the user when the cap is reached.
- A client SHOULD submit a request only when the gap blocked the requester's task, has recurred, or the user asked for the request. A client SHOULD NOT submit a request for a one-time edge case that the requester worked around at little cost.
- When the server advertises `acceptanceTests`, a client SHOULD attach at least one. A gap the requester cannot express as an expected call and result is usually not ready to file.
- Before submitting, a client SHOULD check `changeRequests/list` for its own open requests on the same `target`, and SHOULD NOT file a second request for a gap it has already reported.
- Text supplied by a server, including tool results and status messages, MUST NOT be able to change the client's consent state or redaction rules.
- A client that exposes submission to a model SHOULD do so as a single tool whose input matches the `changeRequests/submit` parameters. The client, and not the server, writes that tool's description.

### 10. Errors

Servers report failures as JSON-RPC errors with code `-32602` for invalid parameters, and with `data.reason` set to one of `kind_unsupported`, `tests_unsupported`, `not_shipped`, `rate_limited`, `not_found`, or `terminal_status`. A `rate_limited` error SHOULD include `data.retryAfterMs`.

### 11. Confirmation

A `shipped` status is the server's claim. Confirmation is the requester's verdict on that claim.

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "changeRequests/confirm",
  "params": {
    "requestId": "crq_01JD3Q8Z",
    "outcome": "pass",
    "tests": [{ "index": 0, "outcome": "pass" }],
    "note": "customer_id filter returns the expected invoices."
  }
}
```

- `outcome` is `pass` or `fail`. `tests` and `note` are optional. `note` is at most 1,000 characters.
- Only the principal that submitted a request MAY confirm it. A server MUST reject a confirmation from any other caller.
- A server MUST reject a confirmation for a request that is not `shipped`, with `data.reason` set to `not_shipped`.
- A server MUST store the requester's outcome unaltered and MUST return it in the status object as `confirmation`, with `outcome` and `confirmedAt`.
- A requester MAY confirm again. The server MUST keep the latest confirmation and SHOULD retain earlier ones.
- A client that submitted acceptance tests SHOULD re-run them against the server after a `shipped` status and confirm with the per-test outcomes. The client makes those calls itself, under its own authorization.
- A server that publishes or exports responsiveness figures MUST count a request as fixed only when its latest confirmation is `pass`, and MUST report unconfirmed shipped requests separately.

### 12. What's new

The inbox tells a requester about the changes it asked for. The people who build on a server also need to hear about the changes they did not ask for: new tools, changed behavior, deprecations, and removals. Today they learn from a changelog page, if they find it, and their agents learn when a call starts failing.

**The changes feed**

`changeRequests/changes` takes `sinceVersion` (string) or `since` (timestamp), and `cursor`. It returns the server's `currentVersion` and the changes shipped after the given point, newest first:

```json
{
  "currentVersion": "1.7.0",
  "changes": [
    {
      "version": "1.7.0",
      "publishedAt": "2026-11-24T15:00:00Z",
      "type": "added",
      "breaking": false,
      "summary": "list_invoices can now filter by customer.",
      "changed": [{ "type": "tool", "name": "list_invoices" }],
      "changelogUri": "https://example.com/changelog#1.7.0"
    },
    {
      "version": "1.7.0",
      "publishedAt": "2026-11-24T15:00:00Z",
      "type": "deprecated",
      "breaking": false,
      "summary": "export_csv is deprecated. Use export_report with format csv.",
      "changed": [{ "type": "tool", "name": "export_csv" }],
      "removeAfter": "2027-02-01"
    }
  ]
}
```

- `type` is one of `added`, `changed`, `deprecated`, `removed`, or `fixed`.
- `breaking` MUST be `true` when a call that worked before the change can fail or return a different shape after it. A `removed` entry is always breaking.
- A `deprecated` entry SHOULD carry `removeAfter`, the earliest date the server may remove the target.
- `summary` is at most 500 characters, written for a person who builds on the server, not for the server's own team.
- `changeRequestIds` MAY list the caller's own requests that the change resolved. It MUST NOT name another principal's requests or reveal their content or demand.
- The feed MUST list only changes available to the caller: everything with `availability: all`, and changes released to that caller alone. A server MAY omit internal changes that no caller can observe.
- The method does not require an authenticated principal, and the server MAY answer it for callers that never submitted a request.
- A server that sets `changes: true` SHOULD also set `changelogUri`, so that people without an agent can read the same list.

**Reaching people**

- A server MAY announce changes the caller has not read by adding `{ "changes": <count> }` to the same `_meta` key as the update notice (Section 7). It SHOULD count only `breaking` and `deprecated` entries, so that routine additions do not become noise.
- A server that announces changes in a tool result's text SHOULD use one fixed line, for example: "2 changes may affect your use of this server. Call whats_new to see them." The line follows the rules for the update notice in Section 7: it names a tool the client can call, carries no change content, and the principal can turn it off.
- A client SHOULD surface `breaking` and `deprecated` entries that affect targets it calls to the user, with the summary and any `removeAfter` date, and SHOULD record them where a later session will find them. A client SHOULD NOT interrupt the user for `added` or `fixed` entries unless the user asked to hear about them.
- A client that exposes the feed to a model SHOULD do so as one tool, for example `whats_new`, whose input matches the method's parameters.

## Rationale

**Protocol methods, with a tool as the model-facing surface.** Today's implementations are plain tools, which need no client changes. Tools alone cannot carry consent, redaction, or an inbox, because those belong to the client and not the model. The extension therefore defines methods, and Section 9 tells clients to expose submission to the model as one tool. Clients gain a single control point, and models keep the calling pattern they already use.

**The principal is the reply address.** Three alternatives were considered. Server-initiated notifications fail because the session that asked no longer exists, and the 2026-07-28 specification removed protocol sessions. Email requires a human in the loop. Webhooks alone exclude every agent that has no public endpoint. Binding requests to the authenticated principal lets any later session collect the answer with no extra infrastructure. Push delivery is delegated to the Events extension, which already defines polling, streaming, and signed webhooks.

**What's new is part of the loop.** A change request ends when the fix ships, but the people building on a server need to plan for every change, including ones they never asked for. Putting a version-keyed feed beside the inbox lets the same agent that files requests also tell its user what changed and what will break, with no extra integration. The feed reuses the notice pattern from Section 7 and is limited to breaking changes and deprecations by default, because a line on every addition would train readers to ignore it.

**Acceptance tests are data.** Letting a requester supply executable code would hand outside parties a path into a vendor's build system. A declarative call plus an expected-result schema captures most of the value: it removes ambiguity about what was wanted and gives both sides a mechanical check. JSON Schema was chosen because tool output schemas already use it.

**Update notices go to every client.** The inbox only helps if the requester knows to look. Limiting the update count to clients that advertise the extension would hide it from nearly every agent in use today, and many clients that do pass `_meta` through never show it to the model. The Tasker test showed the same thing: the return path that worked was text the agent actually read. A count plus one fixed line on every tool result reaches any client, costs a few bytes, and carries no request content. Because it now reaches clients that never opted in, the notice is bounded three ways: it goes only to an authenticated principal that is not a shared credential, it is never consent (Section 9), and its line names a tool the client can call, since a client without the extension cannot call the method.

**Failure mode, detectability, and cause come from FMEA practice.** A `kind` alone tells a server what was asked for, not what went wrong, so two requests about the same defect in different tools look unrelated. A small shared set of failure modes makes the mechanism countable across tools and across servers, which is what lets a registry or a vendor see that one kind of failure keeps recurring. Detectability matters because hidden failures cost the most: nothing else catches them, and the requester acted on a false state. The `cause` field is labeled a hypothesis because it is a model's guess, and a guess presented as a diagnosis sends the fix in the wrong direction. These three fields are adapted from an internal multi-agent "friction ledger" [published as a gist](https://gist.github.com/markalosey/8ea04b76024dcb7824558e365b663253), which records severity and detectability on every report, governs failure modes through a reviewed registry, and renders the reporter's cause as a labeled hypothesis. The base list here is deliberately short and open to vendor prefixes, so that adoption does not wait on agreement about a full taxonomy.

**Filing has a bar.** Agents can file at almost no cost, and an unfiltered stream becomes a backlog nobody reads, which costs the server more than it returns. The public friction ledger cited above shows the risk inside a single team: 443 of its 477 reports were still open when it was described. The Tasker test shows the other side: every request waited for a person's approval, and 14 were filed over six days, not hundreds. A rule that a request must have blocked the task or recurred, and should carry an acceptance test, keeps requests to gaps that cost real work and that a server can check.

**Demand is a count.** Exposing who else asked would leak one customer's activity to another. A bare `demand` number tells the requester the request is not alone and tells nothing else.

**The requester decides whether it worked.** A lifecycle that ends at the server's own `shipped` status measures what vendors say. Third parties such as registries can only trust responsiveness figures built from evidence the vendor does not control. The same friction ledger records a deployment check that passed 22 of 22 tests against cached, pre-deploy output, which is the server-side view of a fix being wrong in exactly this way. Confirmation supplies that evidence, and acceptance tests make it mechanical: the requester re-runs the call it wanted and reports the result. Confirmation is an attribute of a shipped request and not a status, so a missing confirmation never blocks the lifecycle.

**Fulfillment is out of scope.** Whether a human, the vendor's own agent, or an automated pipeline builds the change is a vendor decision. The extension standardizes the conversation and leaves the engineering process alone. A separate extension could later define contributed implementations, where the requester proposes the change itself. That raises review, licensing, and supply-chain questions that deserve their own proposal.

**Related work.** The request and status model follows issue trackers. Idempotency keys follow common payment API practice. The durable-handle pattern follows the MCP Tasks extension, which solved a similar problem for long-running operations.

**Relationship to Discussion #2369.** That proposal and this one are complementary. Discussion #2369 covers periodic, anonymized observations about tool design, generated by the client's model across a session, with consent tiers and token budgets. This extension covers identified, individual requests that expect an answer: a status, a shipped change, and a confirmation. The two differ on anonymity by design, because an answer needs an addressee. The names are kept distinct: this extension uses the changeRequests namespace, while the #2369 draft uses a `feedback` capability and a `feedback/submit` method. The two efforts can proceed independently and could later merge as two modes of one extension.

**Privacy rules adapted from Discussion #2369.** Section 9 adopts five rules from that proposal: consent that is per server, revocable, and separate from other consent; a list of content that must never be sent; no participation from ephemeral sessions; no degraded service for clients that decline; and a client-side cap. One rule is deliberately not adopted. That proposal forbids any submitter identity. This extension needs the authenticated principal to deliver an answer, so it limits identity to that principal and forbids anything beyond it.

**Relationship to the Events extension.** SEP-3415 already standardizes how a server tells a client that something happened, with poll, stream, and webhook delivery, cursors, and signed callbacks. A shipped fix is such an occurrence. Defining a second delivery mechanism here would duplicate a Final extension, so status delivery is expressed as one event type on top of Events. The inbox method stays because Events is optional and its adoption is still early.

## Backward Compatibility

This extension introduces no backward incompatibilities. It adds no required behavior to the core protocol, and extensions are disabled by default on both sides.

Servers that already expose a feedback tool can keep it. A server SHOULD continue to offer its existing tool to clients that do not advertise the extension, and SHOULD route both paths into the same store. A server SHOULD hide the legacy tool from clients that do advertise the extension, so the model sees one way to submit.

Clients that do not implement the extension see no change.

## Reference Implementation

The extension process requires at least one reference implementation in an official SDK before review. That implementation does not exist yet. Work toward it has started outside the SDK.

**What exists today.** [`@agent-change-requests/server`](packages/server) (version 0.2.0, MIT) is a server package for the TypeScript SDK. It plugs into any `McpServer` from `@modelcontextprotocol/sdk` and provides:

- Request validation with the field limits in Section 3, idempotency keys, and a daily cap per principal.
- The lifecycle in Section 5, with terminal statuses that never move again.
- The principal-scoped inbox and the update notice in Section 7, as a count in `_meta` and one line of text on every wrapped tool result, with no inbox for shared credentials.
- Confirmation as in Section 11, kept apart from the server's own `shipped`, plus whether the requester adopted the change.
- An `onEvent` hook on every change, a store interface with an in-memory store, a conformance suite, a Postgres schema, and a health check that needs no credential.
- Six model-facing tools: `change_requests_submit`, `_list`, `_get`, `_withdraw`, `_confirm`, and `_scorecard`.

Tasker's MCP server, the source of the evidence in the README, has implemented the draft since Tasker MCP 1.3.0 under the vendor prefix `com.rocketproforma/change-requests`.

**What is still missing.** The plan for the reference implementation has three parts. The package covers part of the first.

1. **Server middleware for the TypeScript SDK.** Still needed:
   - The `changeRequests/*` protocol methods in Section 2. The package offers tools only, which reach the clients in use today but carry none of the client-side consent or redaction.
   - Status events over the Events extension (Section 8). `onEvent` is the hook to build them on.
   - The changes feed (Section 12).
   - Anonymous callers, which the package does not accept.
   - A move from this repository into the official SDK, or a form the SDK maintainers accept.
2. **Client support in the TypeScript SDK.** Not started. It advertises the extension, exposes the model-facing submission tool, applies a redaction pass, and checks the inbox when a response carries an update count.
3. **A demonstration server.** Not started. One tool with a deliberate gap, a recorded agent run that files a request with an acceptance test, a change that ships, and a second session that collects the `shipped` status and removes its workaround.

The package and the prototype use a vendor prefix until the identifier is approved.

## Security Implications

**Prompt injection through request content.** Request text is written by a model and will often be read by another model on the vendor side. A server MUST treat every field as untrusted data and MUST NOT place request content into a context where it can issue instructions to a tool-using agent without isolation. The same applies in reverse: a client MUST treat `message` and `resolution` fields as untrusted data.

**Induced submissions.** A malicious tool result could instruct an agent to file misleading requests against another server, or to leak task context into a request. The consent requirement in Section 9 limits this to servers the user or operator enabled. Clients SHOULD also rate-limit submissions per server per session.

**Data leakage.** Requests carry task context out of the user's environment. Redaction is a client duty because the server cannot know what was sensitive. Servers MUST publish retention terms at `policyUri` if they retain request content beyond resolution.

**Spam and demand inflation.** Agents can generate requests at no cost. Servers SHOULD rate-limit per principal, SHOULD count `demand` per distinct principal and not per submission, and SHOULD leave `anonymous` off unless they have another abuse control.

**Acceptance test abuse.** A test names a call with arguments. Run carelessly, it becomes a way to trigger operations with attacker-chosen inputs. Section 4 forbids execution against production data on the submitter's behalf. Servers MUST also apply normal authorization to any evaluation.

**Event delivery.** Push and webhook delivery of status changes inherit the security requirements of the Events extension, including callback verification, protection against requests to internal addresses, and signing. This extension adds none of its own. Servers MUST scope `changeRequest.updated` subscriptions to the subscribing principal's own requests, so that an event never reveals another principal's request.

**Cross-tenant disclosure.** `changeRequests/list` and `changeRequests/get` MUST enforce principal ownership. `duplicateOf` and `demand` MUST NOT reveal the content or identity of another principal's request.

**False confirmations.** A vendor could create its own principals to file and confirm requests, and a hostile requester could confirm `fail` on working fixes. Publishers of responsiveness figures SHOULD weight confirmations by distinct principal, SHOULD disclose how many principals contributed, and SHOULD exclude principals controlled by the server operator.

## Open Questions

- Should submission be a protocol method, a reserved tool name, or both? The draft chooses methods plus a client-side tool. A tool-only design would be simpler to adopt and weaker on consent.
- Is the principal the right inbox key for servers that authenticate with shared API keys, where many unrelated agents appear as one caller? Section 7 already keeps the update notice and the inbox away from such credentials; the open question is whether those servers need a finer inbox key.
- Should `demand` be optional, given that some vendors will treat request volume as commercially sensitive?
- Does `availability: requester` belong in this extension, or does per-principal rollout imply too much about how servers ship?
- Should acceptance tests allow a sequence of calls, or stay limited to single calls in version 1?
- Should the base failure modes be fixed in this specification, or kept in a separate registry that can grow through review without a new version of the extension?
- Should the extension define a positive signal ("this worked well"), as at least one vendor tool does today?
- Should the client record `shipped` results in a standard location, for example alongside AGENTS.md, so that later sessions find them without calling the server?
- Should the changes feed (Section 12) live in this extension, or become its own small extension that any server can adopt without supporting change requests?
- Should a change entry say how to migrate, for example by naming the replacement tool in a structured field, rather than only in `summary`?
- Should the extension define a standard export of aggregate figures (requests, shipped, confirmed, median time to ship), so that registries can publish comparable responsiveness scores?
- Should this extension and the Discussion #2369 proposal merge, with anonymous session observations and identified requests as two modes of one `feedback` capability? This draft uses its own namespace so that either outcome stays open.
