import { installChangeRequests, type ChangeRequestsOptions } from "@agent-change-requests/server/middleware";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChangeRequestsClient, MemoryLedger, changeRequestsCapabilities, type ChangeRequestsClientOptions } from "../src/index.js";

const EXT = "com.example/change-requests";
type Result = { content: { type: string; text: string }[]; structuredContent?: unknown; _meta?: Record<string, unknown> };

async function setup(
  serverOptions: Partial<ChangeRequestsOptions> = {},
  clientOptions: Partial<ChangeRequestsClientOptions> = {},
  ledger = new MemoryLedger(),
) {
  const server = new McpServer({ name: "invoices", version: "1.0.0" });
  const { service } = installChangeRequests(server, {
    appName: "Invoices",
    extensionId: EXT,
    store: ":memory:",
    getPrincipal: () => "user_a",
    ...serverOptions,
  });
  server.registerTool(
    "list_invoices",
    { description: "List invoices.", outputSchema: { invoices: z.array(z.string()) } },
    async () => ({ content: [{ type: "text" as const, text: "[]" }], structuredContent: { invoices: [] } }),
  );
  const consent = { consent: clientOptions.consent ?? true, ephemeral: clientOptions.ephemeral ?? false };
  const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: changeRequestsCapabilities(EXT, consent) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const shipped: string[] = [];
  const cr = new ChangeRequestsClient(client, {
    extensionId: EXT,
    ledger,
    onShipped: (s) => void shipped.push(s.requestId),
    ...clientOptions,
    ...consent,
  });
  return { service, client, cr, shipped, ledger };
}

const gap = {
  kind: "missing_capability" as const,
  title: "list_invoices cannot filter by customer",
  description: "Fetching one customer's invoices means paging through all of them.",
  target: { type: "tool" as const, name: "list_invoices" },
  context: { workaround: "Filter on the client" },
};

describe("the changes line for hosts that show structured content (SEP section 12)", () => {
  async function withUnreadChange(clientOptions: Partial<ChangeRequestsClientOptions> = {}) {
    const ctx = await setup({}, clientOptions);
    await ctx.client.callTool({ name: "list_invoices", arguments: {} }); // first contact sets the start
    await ctx.service.publishChange({ version: "1.1.0", type: "deprecated", summary: "export_csv is deprecated." });
    const result = (await ctx.client.callTool({ name: "list_invoices", arguments: {} })) as Result;
    return { ...ctx, result };
  }

  it("keeps the server's changes line after the structured content", async () => {
    const { cr, result } = await withUnreadChange();
    const serverLine = result.content.at(-1)!.text;
    expect(serverLine).toBe("Note from Invoices: 1 change may affect your use of this server. Call whats_new to see them.");
    expect(await cr.modelContent(result)).toEqual([
      { type: "text", text: '{"invoices":[]}' },
      { type: "text", text: serverLine },
    ]);
  });

  it("builds the line from _meta.changes, naming the server's whats_new", async () => {
    const { cr, result } = await withUnreadChange();
    const shown = await cr.modelContent({ structuredContent: result.structuredContent, _meta: result._meta });
    expect(shown.at(-1)!.text).toBe("1 change may affect your use of this server. Call whats_new to see them.");
    const seen = await cr.inspect({ structuredContent: result.structuredContent, _meta: result._meta });
    expect(seen).toMatchObject({ changes: 1, changesNotice: "1 change may affect your use of this server. Call whats_new to see them." });
  });

  it("shows both lines when both are announced, update first", async () => {
    const { cr, result } = await withUnreadChange();
    const shown = await cr.modelContent({ structuredContent: {}, _meta: { [EXT]: { updates: 2, changes: 3 } } });
    expect(shown.slice(1).map((b) => b.text)).toEqual([
      "2 of your change requests have an update. Call change_requests_list to see them.",
      "3 changes may affect your use of this server. Call whats_new to see them.",
    ]);
    expect(result).toBeDefined();
  });

  it("withholds the changes line without consent", async () => {
    const { cr, result } = await withUnreadChange({ consent: false });
    expect(await cr.modelContent(result)).toEqual([{ type: "text", text: '{"invoices":[]}' }]);
    expect(await cr.modelContent({ content: result.content })).toEqual([{ type: "text", text: "[]" }]);
    expect((await cr.inspect(result)).result.content).toEqual([{ type: "text", text: "[]" }]);
  });

  it("names the host's own changes tool when given one", async () => {
    const { cr } = await withUnreadChange({ whatsNewToolName: "host_whats_new" });
    const shown = await cr.modelContent({ structuredContent: {}, _meta: { [EXT]: { changes: 2 } } });
    expect(shown.at(-1)!.text).toBe("2 changes may affect your use of this server. Call host_whats_new to see them.");
  });
});

describe("anonymous tickets", () => {
  it("keeps the ticket in the ledger, reads the request with it in a later session, and records the ship", async () => {
    const ledger = new MemoryLedger();
    const first = await setup({ anonymous: true, getPrincipal: () => null }, {}, ledger);
    const filed = await first.cr.submit(gap);
    if (!filed.submitted) throw new Error("not submitted");
    expect(filed.result.ticket).toMatch(/^crt_/);
    expect(first.cr.entries()[0]!.ticket).toBe(filed.result.ticket);
    await first.service.transition(filed.result.requestId, { status: "shipped", resolution: { availability: "all", workaroundObsolete: true } });

    // A later session with the same ledger; the server never sends an anonymous caller a notice.
    const second = await setup({ anonymous: true, getPrincipal: () => null, service: first.service }, {}, ledger);
    const app = (await second.client.callTool({ name: "list_invoices", arguments: {} })) as Result;
    expect(app._meta).toBeUndefined();
    const check = await second.cr.checkTickets();
    expect(check.shipped.map((s) => s.requestId)).toEqual([filed.result.requestId]);
    expect(second.shipped).toEqual([filed.result.requestId]);
    expect(second.cr.entries()[0]).toMatchObject({ status: "shipped", workaroundObsolete: true });
    expect((await second.cr.checkTickets()).updated).toEqual([]);
  });

  it("does not file the same gap twice while the anonymous request is open", async () => {
    const { cr } = await setup({ anonymous: true, getPrincipal: () => null });
    expect((await cr.submit(gap)).submitted).toBe(true);
    expect(await cr.submit(gap)).toMatchObject({ submitted: false, reason: "already_filed" });
  });
});
