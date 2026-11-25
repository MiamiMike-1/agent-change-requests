import { installChangeRequests, type StatusEvent } from "@agent-change-requests/server/middleware";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChangeRequestsClient, changeRequestsCapabilities, MemoryLedger, type ChangeRequestsClientOptions } from "../src/index.js";

const EXT = "com.example/change-requests";

const invoices = [
  { id: "inv_1", customer_id: "cus_1", amount: 100 },
  { id: "inv_2", customer_id: "cus_2", amount: 250 },
];

async function setup(options: Partial<ChangeRequestsClientOptions> = {}, principal: string | null = "user_a") {
  const state = { fixed: false };
  const events: StatusEvent[] = [];
  const server = new McpServer({ name: "invoices", version: "1.0.0" });
  const { service } = installChangeRequests(server, {
    appName: "Invoices",
    extensionId: EXT,
    store: ":memory:",
    getPrincipal: () => principal,
    publishEvent: (e) => {
      events.push(e);
    },
  });
  server.registerTool(
    "list_invoices",
    {
      description: "List invoices.",
      inputSchema: { customer_id: z.string().optional() },
      outputSchema: { invoices: z.array(z.object({ id: z.string(), customer_id: z.string(), amount: z.number() })) },
    },
    async ({ customer_id }) => {
      const rows = state.fixed && customer_id ? invoices.filter((i) => i.customer_id === customer_id) : invoices;
      return { content: [{ type: "text" as const, text: JSON.stringify(rows) }], structuredContent: { invoices: rows } };
    },
  );

  const consent = { consent: options.consent ?? true, ephemeral: options.ephemeral ?? false };
  const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: changeRequestsCapabilities(EXT, consent) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const shipped: string[] = [];
  const cr = new ChangeRequestsClient(client, {
    extensionId: EXT,
    serverName: "Invoices",
    ledger: new MemoryLedger(),
    onShipped: (s) => {
      shipped.push(s.requestId);
    },
    ...options,
    ...consent,
  });
  return { state, events, service, client, cr, shipped };
}

const test = {
  description: "Filter by customer returns only that customer's invoices",
  call: { method: "tools/call" as const, params: { name: "list_invoices", arguments: { customer_id: "cus_1" } } },
  expect: {
    isError: false,
    structuredContentSchema: {
      type: "object",
      properties: { invoices: { type: "array", items: { properties: { customer_id: { const: "cus_1" } } } } },
      required: ["invoices"],
    },
  },
};

const gap = {
  kind: "missing_capability" as const,
  title: "list_invoices cannot filter by customer",
  description: "Fetching one customer's invoices means paging through all of them. Reported by jane@example.com.",
  target: { type: "tool" as const, name: "list_invoices" },
  context: { goal: "Total one customer's invoices", workaround: "List all invoices and filter client-side" },
  acceptanceTests: [test],
};

describe("advertising", () => {
  it("advertises only with consent and never from an ephemeral session", () => {
    expect(changeRequestsCapabilities(EXT, { consent: true })).toEqual({ extensions: { [EXT]: {} } });
    expect(changeRequestsCapabilities(EXT, { consent: false })).toEqual({});
    expect(changeRequestsCapabilities(EXT, { consent: true, ephemeral: true })).toEqual({});
  });

  it("reads the server's settings and hides the legacy submit tool from an extension client", async () => {
    const { cr, client } = await setup();
    expect(cr.settings()).toMatchObject({ kinds: ["bug", "friction", "missing_capability", "feature_request"], acceptanceTests: true, events: true, anonymous: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("change_requests_submit");
    expect(names).toContain("change_requests_list");

    const plain = await setup({ consent: false });
    const plainNames = (await plain.client.listTools()).tools.map((t) => t.name);
    expect(plainNames).toContain("change_requests_submit");
  });

  it("gives the model one submission tool, with tests only when the server takes them", async () => {
    const { cr } = await setup();
    const tool = cr.submissionTool();
    expect(tool.name).toBe("file_change_request");
    expect(tool.description).toContain("Invoices");
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain("acceptanceTests");
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).not.toContain("idempotencyKey");
  });
});

describe("the loop, end to end", () => {
  it("files a redacted request, learns it shipped, re-runs its test, and confirms", async () => {
    const { cr, client, service, state, events, shipped } = await setup();

    const filed = await cr.submit(gap);
    expect(filed.submitted).toBe(true);
    if (!filed.submitted) return;
    expect(filed.findings).toEqual([{ path: "description", rule: "email" }]);
    const requestId = filed.result.requestId;
    const stored = (await service.listAll()).items[0]!;
    expect(stored.description).toContain("<email>");
    expect(stored.description).not.toContain("jane@example.com");
    expect(stored.acceptanceTests).toHaveLength(1);

    // The same gap is not filed twice.
    const again = await cr.submit({ ...gap, title: "Same gap, new words" });
    expect(again).toMatchObject({ submitted: false, reason: "already_filed", requestId });

    // The change ships.
    state.fixed = true;
    await service.transition(requestId, { status: "shipped", version: "1.1.0", resolution: { availability: "all", workaroundObsolete: true } });
    expect(events.at(-1)).toMatchObject({ type: "changeRequest.updated", principal: "user_a", requestId, payload: { status: "shipped" } });

    // Any tool result carries the notice; inspecting it reads the inbox.
    const result = (await client.callTool({ name: "list_invoices", arguments: {} })) as { content: unknown[]; _meta?: Record<string, unknown> };
    expect(result._meta?.[EXT]).toEqual({ updates: 1 });
    const seen = await cr.inspect(result);
    expect(seen.updates).toBe(1);
    expect(seen.inbox?.shipped.map((s) => s.requestId)).toEqual([requestId]);
    expect(shipped).toEqual([requestId]);
    expect(cr.entries()[0]).toMatchObject({ requestId, status: "shipped", workaroundObsolete: true });

    // The notice is gone once read.
    const after = (await client.callTool({ name: "list_invoices", arguments: {} })) as { _meta?: Record<string, unknown> };
    expect(after._meta?.[EXT]).toBeUndefined();

    const confirmed = await cr.retestAndConfirm(requestId);
    expect(confirmed.outcome).toBe("pass");
    expect(confirmed.status.confirmation).toMatchObject({ outcome: "pass" });
    expect(cr.entries()[0]).toMatchObject({ confirmed: "pass" });
  });

  it("confirms fail when the shipped change does not do what the test asked", async () => {
    const { cr, service } = await setup();
    const filed = await cr.submit(gap);
    if (!filed.submitted) throw new Error("not submitted");
    await service.transition(filed.result.requestId, { status: "shipped", resolution: { availability: "all" } });
    const confirmed = await cr.retestAndConfirm(filed.result.requestId);
    expect(confirmed.outcome).toBe("fail");
    const record = (await service.listAll()).items[0]!;
    expect(record.confirmations.at(-1)).toMatchObject({ outcome: "fail", tests: [{ index: 0, outcome: "fail" }] });
    expect(record.confirmations.at(-1)?.note).toContain("schema");
  });
});

describe("client-side controls", () => {
  it("does not submit or act on notices without consent, and strips the notice line", async () => {
    const { cr, client, service } = await setup({ consent: false });
    expect(await cr.submit(gap)).toEqual({ submitted: false, reason: "not_enabled" });

    // The legacy tool still works for this client; the notice reaches it as text.
    const legacy = (await client.callTool({ name: "change_requests_submit", arguments: { ...gap, idempotencyKey: "k1" } })) as unknown as {
      structuredContent: { requestId: string };
    };
    await service.transition(legacy.structuredContent.requestId, { status: "triaged" });
    const result = (await client.callTool({ name: "list_invoices", arguments: {} })) as { content: { text: string }[] };
    expect(result.content.at(-1)?.text).toContain("1 of your change requests has an update");
    const seen = await cr.inspect(result);
    expect(seen.updates).toBe(0);
    expect(seen.result.content).toHaveLength(1);
    expect(seen.inbox).toBeUndefined();
  });

  it("caps submissions per day", async () => {
    const { cr } = await setup({ dailyCap: 1 });
    expect((await cr.submit({ ...gap, target: { type: "tool", name: "a" } })).submitted).toBe(true);
    expect(await cr.submit({ ...gap, target: { type: "tool", name: "b" } })).toEqual({ submitted: false, reason: "daily_cap" });
  });

  it("lets a review hook cancel a request", async () => {
    const { cr } = await setup({ review: () => false });
    expect(await cr.submit(gap)).toEqual({ submitted: false, reason: "cancelled" });
  });

  it("answers the model through the submission tool", async () => {
    const { cr } = await setup();
    const first = await cr.callSubmissionTool(gap);
    expect(first.content[0]!.text).toMatch(/^Filed as crq_/);
    const second = await cr.callSubmissionTool(gap);
    expect(second.content[0]!.text).toMatch(/^You already filed this gap/);
  });
});

describe("protocol errors", () => {
  it("returns JSON-RPC -32602 with the spec's reason", async () => {
    const { client } = await setup();
    await expect(
      client.request({ method: "changeRequests/submit", params: { ...gap, kind: "praise", idempotencyKey: "k" } } as never, ResultSchema),
    ).rejects.toMatchObject({ code: -32602, data: { reason: "kind_unsupported" } });
    await expect(
      client.request({ method: "changeRequests/confirm", params: { requestId: "crq_nope", outcome: "pass" } } as never, ResultSchema),
    ).rejects.toMatchObject({ code: -32602, data: { reason: "not_found" } });
  });

  it("returns the first answer for a repeated idempotency key", async () => {
    const { client } = await setup();
    const params = { ...gap, idempotencyKey: "same" };
    const one = await client.request({ method: "changeRequests/submit", params } as never, ResultSchema);
    const two = await client.request({ method: "changeRequests/submit", params } as never, ResultSchema);
    expect(two).toEqual(one);
  });
});

