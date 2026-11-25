import { describe, expect, it } from "vitest";
import { GitHubIssueSink, issueBody, UpstreamRelay, type UpstreamRequest, type UpstreamSink, type UpstreamState } from "../src/upstream.js";
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
    const relay = new UpstreamRelay({ service, sink, serverName: "Example" });
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
    const relay = new UpstreamRelay({ service, sink, maxPerDay: 1 });
    const a = await service.submit("user_a", specRequest({ title: "One" }));
    const b = await service.submit("user_b", specRequest({ title: "Two" }));
    await relay.forward(a.requestId);
    await expect(relay.forward(b.requestId)).rejects.toThrow(/at most 1/);
    expect(sink.forwarded).toHaveLength(1);
  });

  it("does not forward requests about the app", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const relay = new UpstreamRelay({ service, sink });
    const { requestId } = await service.submit("user_a", request());
    expect(await relay.forward(requestId)).toBeNull();
    expect(sink.forwarded).toHaveLength(0);
  });

  it("forwards on submit when attached, and a failing sink never fails the submit", async () => {
    const { service } = makeService();
    const sink = new FakeSink();
    const errors: unknown[] = [];
    const relay = new UpstreamRelay({ service, sink, onError: (e) => errors.push(e) });
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
    const relay = new UpstreamRelay({ service, sink });
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
