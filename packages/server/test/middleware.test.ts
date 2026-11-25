import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { installChangeRequests, type ChangeRequestsOptions } from "../src/middleware.js";
import { request, shippedResolution } from "./helpers.js";

const EXT = "com.example/change-requests";

async function session(options: Partial<ChangeRequestsOptions> = {}, clientCaps: Record<string, unknown> = {}) {
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  const installed = installChangeRequests(server, {
    appName: "Demo",
    extensionId: EXT,
    getPrincipal: () => "user_a",
    ...options,
  });
  server.registerTool("ping_app", { description: "An app tool." }, async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
  const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: clientCaps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    client.request({ method, params } as never, ResultSchema) as Promise<Record<string, any>>;
  return { ...installed, client, call };
}

describe("installChangeRequests", () => {
  it("advertises the settings object under capabilities.extensions", async () => {
    const { client } = await session({ policyUri: "https://example.com/policy" });
    expect((client.getServerCapabilities() as any).extensions[EXT]).toEqual({
      kinds: ["bug", "friction", "missing_capability", "feature_request"],
      acceptanceTests: true,
      events: false,
      anonymous: false,
      changes: true,
      policyUri: "https://example.com/policy",
    });
  });

  it("answers the five methods and puts the update count in _meta", async () => {
    const { call, service } = await session();
    const submitted = await call("changeRequests/submit", request({ idempotencyKey: "k1" }));
    expect(submitted).toMatchObject({ status: "received", duplicateOf: null, demand: 1 });
    const requestId = submitted.requestId as string;

    expect(await call("changeRequests/get", { requestId })).toMatchObject({ requestId, status: "received" });
    await service.transition(requestId, { status: "shipped", resolution: shippedResolution });

    const another = await call("changeRequests/submit", request({ idempotencyKey: "k0", target: { type: "tool", name: "x" } }));
    expect(another._meta).toEqual({ [EXT]: { updates: 1 } });
    const listed = await call("changeRequests/list", { status: ["shipped"] });
    expect(listed.requests).toHaveLength(1);
    expect(listed._meta).toBeUndefined(); // reading the inbox cleared the update

    const confirmed = await call("changeRequests/confirm", { requestId, outcome: "pass" });
    expect(confirmed.confirmation).toMatchObject({ outcome: "pass" });

    const other = await call("changeRequests/submit", request({ idempotencyKey: "k2" }));
    expect(await call("changeRequests/withdraw", { requestId: other.requestId })).toMatchObject({ status: "withdrawn" });
    await expect(call("changeRequests/withdraw", { requestId: other.requestId })).rejects.toMatchObject({
      code: -32602,
      data: { reason: "terminal_status" },
    });
    await expect(call("changeRequests/get", {})).rejects.toMatchObject({ code: -32602 });
  });

  it("adds the update notice to app tools registered after it", async () => {
    const { client, call, service } = await session();
    const { requestId } = await call("changeRequests/submit", request());
    await service.transition(requestId, { status: "triaged" });
    const result = (await client.callTool({ name: "ping_app", arguments: {} })) as any;
    expect(result._meta).toEqual({ [EXT]: { updates: 1 } });
    expect(result.content.at(-1).text).toBe("Note from Demo: 1 of your change requests has an update. Call change_requests_list to see them.");
  });

  it("hides the legacy submit tool only from clients that advertise the extension", async () => {
    const plain = await session();
    expect((await plain.client.listTools()).tools.map((t) => t.name)).toContain("change_requests_submit");
    const ext = await session({}, { extensions: { [EXT]: {} } });
    expect(ext.clientSupports()).toBe(true);
    expect((await ext.client.listTools()).tools.map((t) => t.name)).not.toContain("change_requests_submit");
    const none = await session({ legacyTools: false });
    expect((await none.client.listTools()).tools.map((t) => t.name)).toEqual(["ping_app"]);
  });

  it("publishes changeRequest.updated with the status object to the owning principal", async () => {
    const events: any[] = [];
    const { call, service, client } = await session({ publishEvent: (e) => void events.push(e) });
    expect((client.getServerCapabilities() as any).extensions[EXT].events).toBe(true);
    const { requestId } = await call("changeRequests/submit", request());
    expect(events).toHaveLength(0);
    await service.transition(requestId, { status: "planned" });
    await call("changeRequests/withdraw", { requestId });
    expect(events.map((e) => [e.type, e.principal, e.payload.status])).toEqual([
      ["changeRequest.updated", "user_a", "planned"],
      ["changeRequest.updated", "user_a", "withdrawn"],
    ]);
  });

  it("keeps requests in a SQLite file that a later session reads", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "acr-")), "requests.db");
    const first = await session({ store: file });
    const { requestId } = await first.call("changeRequests/submit", request());
    await first.service.transition(requestId, { status: "shipped", resolution: shippedResolution });
    const second = await session({ store: file });
    const app = (await second.client.callTool({ name: "ping_app", arguments: {} })) as any;
    expect(app._meta).toEqual({ [EXT]: { updates: 1 } });
    const listed = await second.call("changeRequests/list");
    expect(listed.requests[0]).toMatchObject({ requestId, status: "shipped" });
  });

  it("answers changeRequests/changes for any caller and puts the changes count in _meta and the notice", async () => {
    const { call, client, service } = await session();
    // Seeing the principal once sets where its unread count starts.
    await client.callTool({ name: "ping_app", arguments: {} });
    await service.publishChange({ version: "1.1.0", type: "added", summary: "ping_app takes a message." });
    await service.publishChange({ version: "1.1.0", type: "deprecated", summary: "ping is deprecated.", removeAfter: "2027-02-01" });

    const app = (await client.callTool({ name: "ping_app", arguments: {} })) as any;
    expect(app._meta).toEqual({ [EXT]: { changes: 1 } });
    expect(app.content.at(-1).text).toBe("Note from Demo: 1 change may affect your use of this server. Call whats_new to see them.");

    const feed = await call("changeRequests/changes", { sinceVersion: "1.0.0" });
    expect(feed.currentVersion).toBe("1.0.0"); // the McpServer's own version
    expect(feed.changes.map((c: any) => c.type)).toEqual(["deprecated", "added"]);
    expect(feed._meta).toBeUndefined(); // reading the feed cleared the count
    await expect(call("changeRequests/changes", { sinceVersion: "1.0.0", since: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({
      code: -32602,
      data: { reason: "invalid_params" },
    });

    const anon = await session({ getPrincipal: () => null });
    await anon.service.publishChange({ version: "1.1.0", type: "added", summary: "Public." });
    expect((await anon.call("changeRequests/changes")).changes).toHaveLength(1);
  });

  it("serves whats_new, which can turn the changes notice off", async () => {
    const { client, service } = await session();
    await client.callTool({ name: "ping_app", arguments: {} });
    await service.publishChange({ version: "2.0.0", type: "removed", summary: "ping is gone.", changed: [{ type: "tool", name: "ping" }] });
    const read = (await client.callTool({ name: "whats_new", arguments: { sinceVersion: "1.0.0", notify: false } })) as any;
    expect(read.content[0].text).toContain("- 2.0.0 removed (BREAKING) [ping]: ping is gone.");
    expect(read.structuredContent.changes).toHaveLength(1);
    await service.publishChange({ version: "2.1.0", type: "removed", summary: "pong is gone." });
    const app = (await client.callTool({ name: "ping_app", arguments: {} })) as any;
    expect(app._meta).toBeUndefined();
  });

  it("sends only the _meta counts when it registers no tools the lines could name", async () => {
    const { call, client, service } = await session({ legacyTools: false });
    const { requestId } = await call("changeRequests/submit", request());
    await service.transition(requestId, { status: "triaged" });
    const app = (await client.callTool({ name: "ping_app", arguments: {} })) as any;
    expect(app._meta).toEqual({ [EXT]: { updates: 1 } });
    expect(app.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("leaves the feed out when the store has none", async () => {
    const { client, call } = await session({ changes: false });
    expect((client.getServerCapabilities() as any).extensions[EXT].changes).toBe(false);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("whats_new");
    await expect(call("changeRequests/changes")).rejects.toMatchObject({ code: -32601 });
  });

  it("accepts anonymous callers with a ticket when turned on, and publishes no events for them", async () => {
    const events: any[] = [];
    const { call, client, service } = await session({ anonymous: true, getPrincipal: () => null, publishEvent: (e) => void events.push(e) });
    expect((client.getServerCapabilities() as any).extensions[EXT].anonymous).toBe(true);
    const filed = await call("changeRequests/submit", request());
    expect(filed.ticket).toMatch(/^crt_/);
    await service.transition(filed.requestId, { status: "shipped", resolution: shippedResolution });
    expect(await call("changeRequests/get", { requestId: filed.requestId, ticket: filed.ticket })).toMatchObject({ status: "shipped" });
    await expect(call("changeRequests/get", { requestId: filed.requestId, ticket: "crt_x" })).rejects.toMatchObject({
      data: { reason: "not_found" },
    });
    await expect(call("changeRequests/list")).rejects.toMatchObject({ data: { reason: "unauthenticated" } });
    expect(events).toEqual([]);

    // The legacy tools take the ticket too.
    const viaTool = (await client.callTool({ name: "change_requests_get", arguments: { requestId: filed.requestId, ticket: filed.ticket } })) as any;
    expect(viaTool.structuredContent.status).toBe("shipped");
  });

  it("still refuses anonymous callers by default", async () => {
    const { call, client } = await session({ getPrincipal: () => null });
    expect((client.getServerCapabilities() as any).extensions[EXT].anonymous).toBe(false);
    await expect(call("changeRequests/submit", request())).rejects.toMatchObject({ data: { reason: "unauthenticated" } });
  });
});
