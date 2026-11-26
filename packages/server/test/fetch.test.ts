import { describe, expect, it } from "vitest";
import { endpointCaller } from "../src/endpoint.js";
import { changeRequestsFetchHandler, rateLimiter } from "../src/fetch.js";
import { MemoryStore } from "../src/store.js";
import { ChangeRequestsEndpointSink } from "../src/upstream.js";

const EXT = "com.example/change-requests";

function endpoint(extra: Record<string, unknown> = {}) {
  return changeRequestsFetchHandler({
    appName: "Maintainers",
    extensionId: EXT,
    getPrincipal: () => null,
    anonymous: true,
    legacyTools: false,
    store: new MemoryStore(),
    ...extra,
  });
}

const post = (handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request("https://maintainers.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("changeRequestsFetchHandler", () => {
  it("answers a stateless anonymous submit and a get by ticket", async () => {
    const { handler, service } = endpoint();
    const submit = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "changeRequests/submit",
      params: { kind: "friction", title: "t", description: "d", idempotencyKey: "k1", target: { type: "extension", name: EXT } },
    });
    expect(submit.status).toBe(200);
    const { result } = (await submit.json()) as { result: { requestId: string; ticket: string } };
    expect(result.ticket).toBeTypeOf("string");

    await service.transition(result.requestId, { status: "declined", message: "Not now." });
    const got = await post(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "changeRequests/get",
      params: { requestId: result.requestId, ticket: result.ticket },
    });
    expect(((await got.json()) as { result: { status: string } }).result.status).toBe("declined");
  });

  it("works with the relay's endpoint sink through a full MCP client", async () => {
    const { handler, service } = endpoint();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
    try {
      const sink = new ChangeRequestsEndpointSink({ call: endpointCaller("https://maintainers.example.com/mcp", { extensionId: EXT }) });
      const sent = await sink.forward({ requestId: "crq_1", kind: "bug", title: "t", description: "d", submittedAt: "2026-01-01T00:00:00Z" });
      expect(await sink.poll(sent.ref)).toEqual({ state: "open" });
      expect((await service.listAll()).items).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("answers GET and DELETE with 405, without opening a stream or counting the call", async () => {
    let checked = 0;
    const { handler } = endpoint({ allow: () => ((checked += 1), true) });
    for (const method of ["GET", "DELETE"]) {
      const response = await handler(
        new Request("https://maintainers.example.com/mcp", { method, headers: { accept: "text/event-stream" } }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect((await response.json()).error.message).toBe("Method not allowed.");
    }
    expect(checked).toBe(0);
  });

  it("refuses oversized bodies and callers over the limit", async () => {
    const { handler } = endpoint({ maxBodyBytes: 200, allow: rateLimiter({ limit: 2, now: () => 0 }) });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const from = { "x-forwarded-for": "203.0.113.5" };
    expect((await post(handler, "x".repeat(500), from)).status).toBe(413);
    expect((await post(handler, ping, from)).status).toBe(200);
    expect((await post(handler, ping, from)).status).toBe(429);
    expect((await post(handler, ping, { "x-forwarded-for": "203.0.113.9" })).status).toBe(200);
  });
});
