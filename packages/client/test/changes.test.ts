import { installChangeRequests } from "@agent-change-requests/server/middleware";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { ChangesFeed, MemoryChangesLedger, changesCount, type ChangeEntry } from "../src/index.js";

const EXT = "com.example/change-requests";

async function setup(feedOptions: Partial<ConstructorParameters<typeof ChangesFeed>[1]> = {}, version = "1.0.0", changes = true) {
  const server = new McpServer({ name: "invoices", version });
  const { service } = installChangeRequests(server, {
    appName: "Invoices",
    extensionId: EXT,
    store: ":memory:",
    getPrincipal: () => "user_a",
    changes,
  });
  server.registerTool("list_invoices", { description: "List invoices." }, async () => ({ content: [{ type: "text" as const, text: "[]" }] }));
  const client = new Client({ name: "agent", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const seen: ChangeEntry[] = [];
  const ledger = new MemoryChangesLedger();
  const feed = new ChangesFeed(client, { extensionId: EXT, ledger, onChange: (e) => void seen.push(e), ...feedOptions });
  return { client, service, feed, seen, ledger };
}

describe("ChangesFeed", () => {
  it("reads what shipped since the last version, records only breaking and deprecated entries, and moves forward", async () => {
    const { feed, service, seen } = await setup({}, "1.1.0");
    expect(feed.available()).toBe(true);
    await service.publishChange({ version: "1.1.0", type: "added", summary: "list_invoices filters by customer." });
    await service.publishChange({ version: "1.1.0", type: "deprecated", summary: "export_csv is deprecated.", removeAfter: "2027-02-01" });

    const first = await feed.check();
    expect(first.currentVersion).toBe("1.1.0");
    expect(first.changes).toHaveLength(2);
    expect(seen.map((e) => e.type)).toEqual(["deprecated"]);
    expect(feed.notices()[0]).toMatchObject({ summary: "export_csv is deprecated.", removeAfter: "2027-02-01" });

    await service.publishChange({ version: "1.2.0", type: "removed", summary: "export_csv is gone." });
    const second = await feed.check();
    expect(second.changes.map((c) => c.version)).toEqual(["1.2.0"]);
    expect(seen.map((e) => e.type)).toEqual(["deprecated", "removed"]);
  });

  it("surfaces only entries about the targets the client uses", async () => {
    const { feed, service, seen } = await setup({ targets: ["list_invoices"] });
    await service.publishChange({ version: "2.0.0", type: "removed", summary: "export_csv is gone.", changed: [{ type: "tool", name: "export_csv" }] });
    await service.publishChange({ version: "2.0.0", type: "changed", breaking: true, summary: "list_invoices pages by 20.", changed: [{ type: "tool", name: "list_invoices" }] });
    await feed.check();
    expect(seen.map((e) => e.summary)).toEqual(["list_invoices pages by 20."]);
  });

  it("checks when a tool result announces unread changes", async () => {
    const { feed, service, client, seen } = await setup();
    await client.callTool({ name: "list_invoices", arguments: {} });
    await service.publishChange({ version: "1.1.0", type: "deprecated", summary: "list_invoices cursor format changes in 2.0." });
    const result = (await client.callTool({ name: "list_invoices", arguments: {} })) as { content: unknown[]; _meta?: Record<string, unknown> };
    expect(changesCount(result, EXT)).toBe(1);
    expect(changesCount({ content: [{ type: "text", text: "Note from X: 3 changes may affect your use of this server." }] }, EXT)).toBe(3);
    expect(await feed.inspect(result)).not.toBeNull();
    expect(seen).toHaveLength(1);
    const after = (await client.callTool({ name: "list_invoices", arguments: {} })) as { content: unknown[]; _meta?: Record<string, unknown> };
    expect(changesCount(after, EXT)).toBe(0);
  });

  it("gives the model one whats_new tool", async () => {
    const { feed, service } = await setup({ serverName: "Invoices" });
    await service.publishChange({ version: "2.0.0", type: "removed", summary: "export_csv is gone." });
    expect(feed.tool().name).toBe("whats_new");
    const out = await feed.callTool({ sinceVersion: "1.0.0" });
    expect(out.content[0]!.text).toContain("- 2.0.0 removed (breaking): export_csv is gone.");
  });

  it("is unavailable when the server does not advertise changes", async () => {
    const { feed } = await setup({}, "1.0.0", false);
    expect(feed.available()).toBe(false);
    expect((await feed.callTool({})).isError).toBe(true);
  });
});
