import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { installChangeRequests } from "../src/middleware.js";
import { ChangeRequestsEndpointSink, GitHubIssueSink, issueBody, UpstreamRelay, type UpstreamRequest, type UpstreamSink, type UpstreamState } from "../src/upstream.js";
import { makeService, request } from "./helpers.js";

class FakeSink implements UpstreamSink {
  forwarded: UpstreamRequest[] = [];
  states = new Map<string, UpstreamState>();
  fail = false;
  async forward(req: UpstreamRequest) {
    if (this.fail) throw new Error("sink down");
    this.forwarded.push(req);
    const ref = `o/r#${this.forwarded.length}`;
    return { ref, url: `https://github.com/o/r/issues/${this.forwarded.length}` };
  }
  async poll(ref: string): Promise<UpstreamState> {
    return this.states.get(ref) ?? { state: "open" };
  }
}

const EXT = "com.example/change-requests";

const specRequest = (overrides: Record<string, unknown> = {}) =>
  request({
    kind: "friction",
    title: "The update notice line is easy to miss",
    description: "Ping @someone: the line sits after a long table.",
    target: { type: "extension", name: "com.example/change-requests", component: "spec" },
    context: { goal: "Private task details", workaround: "Secret workaround" },
    ...overrides,
  });

describe("extension targets", () => {
  it("accepts an extension target with a component and marks it as about the spec", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", specRequest());
    const status = await service.get("user_a", requestId);
    expect(status.about).toBe("spec");
  });

  it("leaves another extension's target as about the app", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", specRequest({ target: { type: "extension", name: "io.modelcontextprotocol/events" } }));
    expect((await service.get("user_a", requestId)).about).toBe("app");
  });

  it("rejects a component on a non-extension target and an extension target without a name", async () => {
    const { service } = makeService();
    await expect(service.submit("user_a", request({ target: { type: "tool", name: "x", component: "spec" } }))).rejects.toThrow(/component/);
    await expect(service.submit("user_a", request({ target: { type: "extension" } }))).rejects.toThrow(/target.name/);
  });
});

describe("UpstreamRelay", () => {
  it("forwards spec requests once, without identity or context, and tells the requester", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: sink }, serverName: "Example" });
    const { requestId } = await service.submit("user_a", specRequest());

    const link = await relay.forward(requestId);
    await relay.forward(requestId);
    expect(link?.ref).toBe("o/r#1");
    expect(sink.forwarded).toHaveLength(1);
    const sent = sink.forwarded[0]!;
    expect(sent.server).toBe("Example");
    expect(JSON.stringify(sent)).not.toContain("user_a");
    expect(JSON.stringify(sent)).not.toContain("Secret workaround");
    expect(sent).not.toHaveProperty("context");

    const status = await service.get("user_a", requestId);
    expect(status.status).toBe("triaged");
    expect(status.message).toContain("https://github.com/o/r/issues/1");
  });

  it("caps how many requests it forwards a day", async () => {
    const { service } = makeService({ dailyCap: 0 });
    const sink = new FakeSink();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: sink }, maxPerDay: 1 });
    const a = await service.submit("user_a", specRequest({ title: "One" }));
    const b = await service.submit("user_b", specRequest({ title: "Two" }));
    await relay.forward(a.requestId);
    await expect(relay.forward(b.requestId)).rejects.toThrow(/at most 1/);
    expect(sink.forwarded).toHaveLength(1);
  });

  it("routes by extension, and relays only extensions that have a sink", async () => {
    const { service } = makeService();
    const ours = new FakeSink();
    const events = new FakeSink();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: ours, "io.example/events": events } });
    const a = await service.submit("user_a", specRequest({ target: { type: "extension", name: "io.example/events" } }));
    const b = await service.submit("user_a", specRequest({ target: { type: "extension", name: "io.example/unknown" } }));
    expect((await relay.forward(a.requestId))?.extension).toBe("io.example/events");
    expect(await relay.forward(b.requestId)).toBeNull();
    expect(events.forwarded).toHaveLength(1);
    expect(ours.forwarded).toHaveLength(0);
  });

  it("sends spec requests that target a change_requests tool to extensionId's sink", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const without = new UpstreamRelay({ service, sinks: { [EXT]: sink } });
    const { requestId } = await service.submit("user_a", request({ target: { type: "tool", name: "change_requests_list" } }));
    expect(await without.forward(requestId)).toBeNull();
    const withId = new UpstreamRelay({ service, sinks: { [EXT]: sink }, extensionId: EXT });
    expect((await withId.forward(requestId))?.extension).toBe(EXT);
  });

  it("forwards what was missed once the sink is back", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: sink } });
    relay.attach();
    sink.fail = true;
    const a = await service.submit("user_a", specRequest({ title: "One" }));
    const b = await service.submit("user_a", specRequest({ title: "Two" }));
    await service.submit("user_a", request());
    await new Promise((r) => setTimeout(r, 0));
    expect(await relay.forwardPending()).toEqual([]);
    sink.fail = false;
    expect((await relay.forwardPending()).sort()).toEqual([a.requestId, b.requestId].sort());
    expect(await relay.forwardPending()).toEqual([]);
    expect(sink.forwarded).toHaveLength(2);
  });

  it("does not forward requests about the app", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: sink } });
    const { requestId } = await service.submit("user_a", request());
    expect(await relay.forward(requestId)).toBeNull();
    expect(sink.forwarded).toHaveLength(0);
  });

  it("forwards on submit when attached, and a failing sink never fails the submit", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const errors: unknown[] = [];
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: sink }, onError: (e) => errors.push(e) });
    const stop = relay.attach();
    await service.submit("user_a", specRequest());
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.forwarded).toHaveLength(1);

    sink.fail = true;
    const second = await service.submit("user_a", specRequest({ title: "Another" }));
    expect(second.status).toBe("received");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    stop();
  });

  it("syncs shipped and declined answers back into the inbox", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: sink } });
    const a = await service.submit("user_a", specRequest({ title: "One" }));
    const b = await service.submit("user_a", specRequest({ title: "Two" }));
    const c = await service.submit("user_a", specRequest({ title: "Three" }));
    for (const r of [a, b, c]) await relay.forward(r.requestId);

    sink.states.set("o/r#1", { state: "shipped", url: "https://github.com/o/r/issues/1", at: "2026-01-06T00:00:00.000Z" });
    sink.states.set("o/r#2", { state: "declined", reason: "it is not planned" });
    const report = await relay.sync();
    expect(report).toEqual({ checked: 3, shipped: [a.requestId], declined: [b.requestId] });

    const shipped = await service.get("user_a", a.requestId);
    expect(shipped.status).toBe("shipped");
    expect(shipped.resolution).toEqual({ availability: "all", changelogUri: "https://github.com/o/r/issues/1" });
    expect((await service.get("user_a", b.requestId)).status).toBe("declined");
    expect((await service.get("user_a", c.requestId)).status).toBe("triaged");

    // Terminal requests are not polled again.
    expect((await relay.sync()).checked).toBe(1);
  });
});

describe("GitHubIssueSink", () => {
  it("files an issue and reads its state", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies: unknown[] = [
      { number: 7, html_url: "https://github.com/o/r/issues/7", state: "open" },
      { number: 7, html_url: "https://github.com/o/r/issues/7", state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" },
      { number: 7, html_url: "https://github.com/o/r/issues/7", state: "closed", state_reason: "not_planned" },
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const sink = new GitHubIssueSink({ repo: "o/r", token: "t", fetch: fakeFetch });

    const sent = await sink.forward({
      requestId: "crq_1",
      kind: "friction",
      title: "Hi @team",
      description: "Line one\nLine two",
      submittedAt: "2026-01-01T00:00:00Z",
    });
    expect(sent).toEqual({ ref: "o/r#7", url: "https://github.com/o/r/issues/7" });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.title).toBe("Hi @​team");
    expect(body.labels).toEqual(["agent-change-request"]);

    expect(await sink.poll("o/r#7")).toEqual({ state: "shipped", url: "https://github.com/o/r/issues/7", at: "2026-02-01T00:00:00Z" });
    expect((await sink.poll("o/r#7")).state).toBe("declined");
  });

  it("quotes agent text and neutralizes mentions in the body", () => {
    const body = issueBody({
      requestId: "crq_1",
      kind: "bug",
      title: "t",
      description: "cc @maintainers\nsecond",
      target: { type: "extension", name: "com.example/change-requests", component: "client-sdk" },
      submittedAt: "2026-01-01T00:00:00Z",
    });
    expect(body).toContain("> cc @​maintainers\n> second");
    expect(body).toContain("`extension / com.example/change-requests / client-sdk`");
  });
});

describe("ChangeRequestsEndpointSink", () => {
  /** The maintainers' side: a server that speaks the extension and accepts anonymous callers. */
  async function maintainers(anonymous = true) {
    const server = new McpServer({ name: "maintainers", version: "1.0.0" });
    const installed = installChangeRequests(server, {
      appName: "Maintainers",
      extensionId: EXT,
      getPrincipal: () => null,
      anonymous,
    });
    const client = new Client({ name: "relay", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = (method: string, params: Record<string, unknown>) =>
      client.request({ method, params } as never, ResultSchema) as Promise<Record<string, unknown>>;
    return { upstream: installed.service, call };
  }

  it("relays with no credential and carries the maintainers' answer back", async () => {
    const { upstream, call } = await maintainers();
    const { service } = makeService();
    const relay = new UpstreamRelay({ service, sinks: { [EXT]: new ChangeRequestsEndpointSink({ call }) }, serverName: "Example" });
    const a = await service.submit("user_a", specRequest({ title: "One" }));
    const b = await service.submit("user_a", specRequest({ title: "Two" }));
    await relay.forward(a.requestId);
    await relay.forward(b.requestId);

    const received = (await upstream.listAll()).items;
    expect(received.map((r) => r.title).sort()).toEqual(["One", "Two"]);
    expect(received.every((r) => r.anonymous && !r.context)).toBe(true);
    expect(JSON.stringify(received)).not.toContain("user_a");

    // The requester sees that it was relayed, but never the ticket.
    const relayed = await service.get("user_a", a.requestId);
    expect(relayed.status).toBe("triaged");
    const ticket = received[0]!.ticket!;
    expect(JSON.stringify(relayed)).not.toContain(ticket);

    const one = received.find((r) => r.title === "One")!;
    const two = received.find((r) => r.title === "Two")!;
    await upstream.transition(one.requestId, {
      status: "shipped",
      resolution: { availability: "all", changelogUri: "https://example.com/changes#1" },
    });
    await upstream.transition(two.requestId, { status: "declined", message: "Out of scope for version 1." });
    expect(await relay.sync()).toEqual({ checked: 2, shipped: [a.requestId], declined: [b.requestId] });
    expect((await service.get("user_a", a.requestId)).resolution).toEqual({
      availability: "all",
      changelogUri: "https://example.com/changes#1",
    });
    expect((await service.get("user_a", b.requestId)).message).toContain("Out of scope for version 1.");
  });

  it("files once when a forward is retried", async () => {
    const { upstream, call } = await maintainers();
    const sink = new ChangeRequestsEndpointSink({ call });
    const req = { requestId: "crq_1", kind: "bug" as const, title: "t", description: "d", submittedAt: "2026-01-01T00:00:00Z" };
    const first = await sink.forward(req);
    expect(await sink.forward(req)).toEqual(first);
    expect((await upstream.listAll()).items).toHaveLength(1);
  });

  it("fails clearly when the endpoint does not accept anonymous callers", async () => {
    const { call } = await maintainers(false);
    const sink = new ChangeRequestsEndpointSink({ call });
    await expect(
      sink.forward({ requestId: "crq_1", kind: "bug", title: "t", description: "d", submittedAt: "2026-01-01T00:00:00Z" }),
    ).rejects.toThrow();
  });
});
