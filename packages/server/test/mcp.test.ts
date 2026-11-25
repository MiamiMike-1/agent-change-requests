import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerChangeRequestTools, withUpdateNotice } from "../src/mcp.js";
import { makeService, request, shippedResolution } from "./helpers.js";

async function connect(principal: string | null) {
  const { service } = makeService();
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  const options = {
    service,
    appName: "Demo",
    extensionId: "com.example/change-requests",
    getPrincipal: () => principal,
  };
  registerChangeRequestTools(server, options);
  server.registerTool(
    "list_things",
    { description: "An app tool." },
    withUpdateNotice(options, async () => ({ content: [{ type: "text" as const, text: "[]" }] })),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, service };
}

type Result = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean; _meta?: any };

describe("MCP adapter", () => {
  it("registers the six change request tools and whats_new", async () => {
    const { client } = await connect("user_a");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "change_requests_confirm",
      "change_requests_get",
      "change_requests_list",
      "change_requests_scorecard",
      "change_requests_submit",
      "change_requests_withdraw",
      "list_things",
      "whats_new",
    ]);
  });

  it("submits, ships, and shows the update notice on any tool until the inbox is read", async () => {
    const { client, service } = await connect("user_a");
    const submitted = (await client.callTool({ name: "change_requests_submit", arguments: request() })) as Result;
    expect(submitted.isError).toBeFalsy();
    const requestId = submitted.structuredContent.requestId as string;

    await service.transition(requestId, { status: "shipped", resolution: shippedResolution, version: "2.0.0" });

    const app = (await client.callTool({ name: "list_things", arguments: {} })) as Result;
    expect(app.content.at(-1)?.text).toBe(
      "Note from Demo: 1 of your change requests has an update. Call change_requests_list to see them.",
    );
    expect(app._meta).toEqual({ "com.example/change-requests": { updates: 1 } });

    const inbox = (await client.callTool({ name: "change_requests_list", arguments: {} })) as Result;
    expect(inbox.structuredContent.requests[0]).toMatchObject({ requestId, status: "shipped", version: "2.0.0" });
    expect(inbox.content).toHaveLength(1);

    const after = (await client.callTool({ name: "list_things", arguments: {} })) as Result;
    expect(after.content).toHaveLength(1);

    const confirmed = (await client.callTool({
      name: "change_requests_confirm",
      arguments: { requestId, outcome: "pass", adopted: true },
    })) as Result;
    expect(confirmed.structuredContent.confirmation).toMatchObject({ outcome: "pass", adopted: true });

    const card = (await client.callTool({ name: "change_requests_scorecard", arguments: {} })) as Result;
    expect(card.structuredContent.numbers.confirmedFixed).toMatchObject({ pass: 1, of: 1 });
  });

  it("returns errors as tool errors with the spec's reason", async () => {
    const { client } = await connect("user_a");
    const result = (await client.callTool({ name: "change_requests_get", arguments: { requestId: "crq_nope" } })) as Result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.data.reason).toBe("not_found");
  });

  it("refuses an unauthenticated caller, including for the scorecard", async () => {
    const { client } = await connect(null);
    const submit = (await client.callTool({ name: "change_requests_submit", arguments: request() })) as Result;
    expect(submit.structuredContent.error.data.reason).toBe("unauthenticated");
    const card = (await client.callTool({ name: "change_requests_scorecard", arguments: {} })) as Result;
    expect(card.structuredContent.error.data.reason).toBe("unauthenticated");
  });
});
