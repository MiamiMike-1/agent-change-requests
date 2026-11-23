# Agent Change Requests Extension

A proposed open standard that lets AI agents tell an API or MCP server what is broken or missing, and lets the server answer back when the fix ships.

**Status:** draft. This is not yet an official MCP SEP. It has no sponsor and no number, and the text will change.

## The problem

Agents hit gaps constantly: a tool that lacks a parameter, an error that explains nothing, a capability that doesn't exist. The agent at the point of failure usually knows exactly what would have helped. The people who maintain the server usually never hear about it.

Several vendors have started fixing this on their own by adding a feedback tool or endpoint for agents. That proves the demand, but every one of them stops halfway:

- **No common shape.** Each vendor uses its own tool name and fields, so clients can't build consent, redaction, or reporting once.
- **No return path.** The agent gets a thank-you and nothing more. By the time a fix ships, the session that asked is gone, so workarounds stay in place long after they're needed.
- **No definition of done.** Requests arrive as prose, and nobody can check mechanically whether the shipped change actually satisfies them.
- **No shared identity or abuse model.** Some vendors record who is asking and some accept anonymous submissions. With no common rule, servers can't weigh demand consistently or keep out spam.

## How the loop works

1. **Request.** The agent files a structured request: what it was trying to do, what was missing, how blocked it is, and its workaround.
2. **Acceptance test (optional).** The agent attaches the exact call it wanted to make and the result it expected. It is data, never code.
3. **Lifecycle.** The server moves the request through `received`, `needs_info`, `triaged`, `planned`, and `building` to `shipped` (or `declined`, `duplicate`, or `withdrawn`).
4. **Answer back.** Requests are tied to the authenticated principal, not the session, so any later session can pick up the outcome from its inbox. While an update is waiting, every tool result says so, in `_meta` and in one plain line of text, whatever the client supports. Servers that support [MCP Events (SEP-3415)](https://modelcontextprotocol.io/seps/3415-events-extension) can also push status changes as a `changeRequest.updated` event. The draft defines no delivery mechanism of its own.
5. **Confirmation.** The agent that asked re-runs its test and reports whether the fix worked. A server's `shipped` is a claim. The requester's confirmation is the evidence.

The extension is opt-in on both sides and adds nothing to the core protocol. How a vendor builds, prioritizes, or ships a change is out of scope.

The draft is written as an MCP extension (proposed identifier `io.modelcontextprotocol/change-requests`, with methods under `changeRequests/`) because MCP gives agents and servers a shared place to negotiate it. The same request, lifecycle, and confirmation model applies to plain HTTP APIs.

## Privacy

Requests carry task context out of the user's environment, so the draft sets rules on the client side:

- Consent is explicit, per server, revocable, and separate from accepting terms of service.
- A request never contains credentials, personal data, the user's own words, resource contents, or file paths. Test arguments are synthetic unless the user approves real values.
- Clients don't participate from ephemeral or incognito sessions.
- Servers can't degrade service for clients that opt out.
- The server learns the requester only as the principal it already authenticates.

Most of these rules are adapted from MCP Discussion #2369, credited below.

## Evidence so far

I've been running an informal version of this loop on Tasker, my own task app, which has its own MCP server. A Claude agent that manages my task list through Tasker asks for changes when it hits a gap. I approve them, Claude Code builds them in the app's repo, and the requesting agent tests the result itself once it's live.

Numbers as of November 22, 2026 (full ledger in [scorecard.md](scorecard.md)):

| Measure | Result |
|---|---|
| Requests filed | 8 (4 by the agent, 4 by me, including 1 bug) |
| Live | 7 of 8 |
| Median time from request to live | about 20 hours (6 requests with recorded times) |
| Confirmed by the requester's own behavior test | 3 of 7 live |
| Adopted (the agent actually uses it or dropped its workaround) | 4 of 7 live |
| Contract failures caught by the agent's behavior tests | 1 |

The most useful result was the failure. Tasker's documentation said changes appeared in the app immediately, and the requesting agent's own test showed they didn't. That is the kind of gap a requester-side behavior test catches and a server-side `shipped` status does not.

Three lessons from the test changed how I think about the design:

- **Most of the elapsed time is human approval and merge, not build time.** One fix was built in about 7 minutes and then waited on me. The scorecard should track the two separately.
- **"Shipped" is not "done."** A feature can exist and still not be used, so the scorecard tracks adoption as its own stage.
- **The return path that worked was pull-based.** The agent learned about changes from the server version shown when it connects, plus a `whats_new` tool it can call. That supports the draft's choice to make the inbox required and push delivery optional.

**Limits of this evidence.** This is one server, one user, one agent, and 8 requests, half of them filed by me. Tasker does not implement the draft: requests were made in conversation, with no structured request object, acceptance tests, or principal-scoped inbox. It shows the loop is workable. It does not show that the protocol works across vendors.

## Prior art

Nothing I've found is two-way yet.

- [MCP Discussion #2369](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2369) (March 2026), by Darien Kindlund, proposes opt-in client experience feedback and has a full SEP draft. The client's model reviews a session and sends anonymized observations about tool design to the server's maintainers. It is the closest cross-vendor work, and the two proposals are complementary: that one covers anonymous, batched telemetry, and this one covers identified requests that get an answer. This draft adopts several of its privacy rules and uses its own namespace so the two don't collide.
- [Sanity](https://sanity.io/engineering/how-to-get-product-feedback-from-agents) (June 2026), [Medusa](https://medusajs.com/blog/two-things-every-mcp-author-should-add) (July 2026), [Netlify](https://www.netlify.com/changelog/2026-11-03-agents-can-send-netlify-feedback/) (November 2026), and [Vercel](https://vercel.com/docs/agent-resources/vercel-mcp/tools/documentation/submit_feedback) each ship a feedback tool on their own MCP server. [Fly.io](https://fly.io/changelog/agents-can-now-send-us-feedback/) (November 2026) does the same through its REST API. [Clerk](https://clerk.com/changelog/2026-10-23-agent-feedback) (October 2026) ships a feedback tool that any MCP server built with Clerk can add. In every case the agent gets an acknowledgment and nothing comes back when a fix ships.
- [LaunchDarkly](https://launchdarkly.com/blog/stories-from-the-factory-floor-empowering-agents-with-launchdarkly-mcp-tools/) (July 2026) reports more than 100 triaged tickets and merged pull requests from about a week of agent complaints, which shows the build side of the loop at volume.
- [MCP Events (SEP-3415)](https://modelcontextprotocol.io/seps/3415-events-extension) is a general way for servers to deliver events to clients. It isn't about feedback. This draft uses it as the push channel for status changes.

The design also borrows from issue trackers (request and status model), payment APIs (idempotency keys), and the MCP Tasks extension (durable handles that outlive a session).

## What's in this repo

| File | What it is |
|---|---|
| [SEP-0000-agent-change-requests.md](SEP-0000-agent-change-requests.md) | The full draft: specification, rationale, security, and open questions |
| [scorecard.md](scorecard.md) | The live ledger from the Tasker test |

## Next steps

- Post in MCP Discussion #2369 to introduce this draft and how it relates to that proposal.
- Build a reference implementation in the official TypeScript SDK: server middleware, client support, and a demo server with a deliberate gap.
- Find a working group home and a maintainer sponsor. The Triggers & Events Working Group, which owns MCP Events, is one candidate.
- Invite the vendors above to co-author, since they've already proven the demand.

## Feedback

Open an issue or a discussion in this repo. I'm especially interested in the open questions at the end of the draft, such as whether submission should be a protocol method or a reserved tool name, and how the inbox should work for servers that share one API key across many agents.

## Author

Mike Lingle ([@miamimike_](https://x.com/miamimike_) on X). I'm an early-stage investor, author, and founder, and I build my own tools with AI agents.
