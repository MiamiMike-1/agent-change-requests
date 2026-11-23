# Tasker agent change requests scorecard

A live test of the agent change request loop on Tasker, my own task app with its own MCP server. The requester is a Claude agent that manages my task list through Tasker. The builder is Claude Code working in the app's repo. I approve each request and merge each change. Times are US Eastern. The test started November 21, 2026, and covers requests back to November 18.

Since Tasker MCP 1.3.0 (November 23, 2026), Tasker implements the draft extension as `com.rocketproforma/change-requests`, and the tables below are generated from its `change_requests_scorecard` tool. The first 8 requests (`crq_seed_01` to `crq_seed_08`) were made in conversation before that, with no structured request object, acceptance tests, or principal-scoped inbox, and were entered afterwards with times recovered from the record; `~` marks the approximate ones.

## Stages

Requested, approved, built (pull request), live (MCP server version), confirmed by the requester, and adopted.

"Confirmed" means the requesting agent tested the behavior itself, not just that a tool or field exists. "Adopted" means the agent actually uses the change or dropped its workaround.

<!-- scorecard:start -->
## Ledger

| # | Request | Kind, origin | Status | Requested | Approved | Built | Merged | Published | Live | Confirmed | Adopted |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Reference items | feature_request, agent | shipped 1.1.0 | Nov 18 | Nov 18~ | Nov 18 | Nov 18 | Nov 19~ | Nov 19~ | Nov 21~ | Nov 21~ |
| 2 | Sub-task close and AI-answer titles | feature_request, agent | shipped 1.1.0 | Nov 18 | Nov 18~ | Nov 18 | Nov 18 | Nov 19~ | Nov 19~ |  |  |
| 3 | Checklists as data | feature_request, agent | shipped 1.1.0 | Nov 18 | Nov 18~ | Nov 18 | Nov 18 | Nov 19~ | Nov 19~ |  |  |
| 4 | Email intake | feature_request, principal | building | Nov 18 | Nov 18~ | Nov 18 | Nov 18 |  |  |  |  |
| 5 | Repeats and alarms through MCP | feature_request, agent | shipped 1.2.0 | Nov 18 | Nov 18~ | Nov 18 | Nov 19 | Nov 19 | Nov 19 |  | Nov 21~ |
| 6 | Clear documentation (get_guide) | feature_request, principal | shipped 1.2.0 | Nov 18 |  | Nov 18 | Nov 19 | Nov 19 | Nov 19 | Nov 21~ | Nov 21~ |
| 7 | Version notices (whats_new and a release item) | feature_request, principal | shipped 1.2.0 | Nov 18 |  | Nov 18 | Nov 19 | Nov 19 | Nov 19 | Nov 21~ | Nov 21~ |
| 8 | App refreshes after MCP writes | bug, principal | shipped 1.2.1 | Nov 21 | Nov 21~ | Nov 21 | Nov 21 | Nov 21~ | Nov 21~ |  |  |
| 9 | Due dates on tasks and checklist items | missing_capability, agent | received | Nov 23 |  |  |  |  |  |  |  |
| 10 | Deep link URL for every task | missing_capability, agent | received | Nov 23 |  |  |  |  |  |  |  |
| 11 | A "today" flag that the app and agents both set and read | missing_capability, agent | received | Nov 23 |  |  |  |  |  |  |  |
| 12 | "Waiting on" field: who, link, and follow-up date | missing_capability, agent | received | Nov 23 |  |  |  |  |  |  |  |
| 13 | Simpler statuses, with a Waiting tab in the app | feature_request, principal | received | Nov 23 |  |  |  |  |  |  |  |
| 14 | History log of who changed what, and when | missing_capability, principal | received | Nov 23 |  |  |  |  |  |  |  |

Dates are US Eastern; ~ marks an approximate time.

## Running numbers (November 23, 2026)

- Requests: 14 (8 agent, 6 principal)
- Live: 7 of 14
- Median request to live: 20.3 h
- Median build time (approved to pull request): 0.3 h
- Median human time (request to approval, plus pull request to publish): 20.3 h
- Confirmed fixed: 3 of 7 shipped (0 failed, 4 unconfirmed)
- Adopted: 4 of 7 shipped
- Contract failures: 1
- Picked up by the requester: 7 of 7 shipped
- Gaps logged: 0, 0 followed by a request within 30 minutes
<!-- scorecard:end -->

## Notes

1. The Tasker MCP changelog lists reference items, checklist tools, sub-task close, and AI-answer titles under v1.1.0 (November 18), not v1.2.0. If that is when they went live, requests 1 to 3 shipped sooner than shown and the median needs recalculating. To be checked against the deploy history.
2. Request 8 went live in v1.2.1 (November 21), per the server changelog. The requesting agent has not yet re-run its test, so it is live but unconfirmed.
3. The failed test on request 8 found the bug. It was a behavior test of what the documentation promised, not a confirmation of a shipped fix. The draft's confirmation step applies once the requester re-tests v1.2.1.
4. Approval and merge are my steps, so builder time and human time should be tracked separately as timestamps improve. The live refresh fix took about 7 minutes to build and then waited on me.
5. The return path that actually worked was pull-based: the server version in the MCP connection instructions plus a `whats_new` tool the agent can call. No push notification was involved.
