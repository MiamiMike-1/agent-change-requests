# Tasker agent change requests scorecard

A live test of the agent change request loop on Tasker, my own task app with its own MCP server. The requester is a Claude agent that manages my task list through Tasker. The builder is Claude Code working in the app's repo. I approve each request and merge each change. Times are US Eastern. The test started November 21, 2026, and covers requests back to November 18.

The first 8 requests were an informal test, made in conversation, with no structured request object, acceptance tests, or principal-scoped inbox. Since November 23, 2026, Tasker MCP 1.3.0 runs a prototype of the draft extension, and new requests are filed through it.

## Stages

Requested, approved, built (pull request), merged, published, live (MCP server version), confirmed by the requester, and adopted.

"Confirmed" means the requesting agent tested the behavior itself, not just that a tool or field exists. "Adopted" means the agent actually uses the change or dropped its workaround.

## Ledger

Generated daily from Tasker's live data, so this file's commit history is the audit trail. Requests are numbered by when they were filed. A new request shows as "(private request)" until I approve publishing its title, because agents write titles and they can describe private work.

<!-- scorecard:begin -->
| # | Request | Origin | Requested | Live | Request to live | Confirmed | Adopted |
|---|---|---|---|---|---|---|---|
| 1 | Reference items (keep info and links without counting them as open work) | Agent | Nov 18 | v1.2.0, Nov 19 (see note 1) | ~21 h | Yes | Yes |
| 2 | Checklists as data | Agent | Nov 18 | v1.2.0, Nov 19 (see note 1) | ~21 h | Partly: tools present, not exercised yet | No |
| 3 | Sub-task close and AI-answer titles | Agent | Nov 18 | v1.2.0, Nov 19 (see note 1) | ~21 h | Partly: documented, not exercised yet | No |
| 4 | Repeats and alarms through MCP | Agent | Nov 18 | v1.2.0, Nov 19 | ~20 h | Partly: field present | Yes: a monthly recurring task now uses it |
| 5 | Email intake | Me | Nov 18 | Not yet: needs my setup | Open | No | No |
| 6 | Clear documentation (`get_guide`) | Me | Nov 18 | v1.2.0, Nov 19 | ~8 h | Yes | Yes |
| 7 | Version notices (`whats_new` and a release item) | Me | Nov 18 | v1.2.0, Nov 19 | ~8 h | Yes | Yes |
| 8 | App refreshes after MCP writes (bug: docs said changes appear immediately, but the agent's behavior test showed a reload was needed) | Me (bug) | Nov 21 | v1.2.1, Nov 21 | Same day, hours not recorded | Not yet re-tested after the fix | No |

## Running numbers (November 22, 2026)

- Requests: 8 (4 from the agent, 4 from me, 1 of them a bug)
- Live: 7 of 8
- Median request to live: about 20 hours, across the 6 requests with recorded times
- Confirmed by behavior test: 3 of 7 live
- Adopted: 4 of 7 live
- Contract failures caught by the agent's behavior tests: 1 (live refresh, request 8)
<!-- scorecard:end -->

## Notes

1. Requests 1 to 3 shipped in v1.1.0 (merged November 18), per the Tasker MCP changelog. The earliest proof they were live is the v1.2.0 deploy on November 19, so that is the live time used here.
2. Request 8 went live in v1.2.1 (November 21), per the server changelog. As of November 22, the requesting agent had not re-run its test, so it was live but unconfirmed.
3. The failed test on request 8 found the bug. It was a behavior test of what the documentation promised, not a confirmation of a shipped fix. The draft's confirmation step applies once the requester re-tests v1.2.1.
4. Approval and merge are my steps, so builder time and human time should be tracked separately as timestamps improve. The live refresh fix took about 7 minutes to build and then waited on me.
5. The return path that actually worked was pull-based: the server version in the MCP connection instructions plus a `whats_new` tool the agent can call. No push notification was involved.
