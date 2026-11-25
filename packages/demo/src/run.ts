#!/usr/bin/env node
/**
 * The whole loop, end to end, with a scripted agent standing in for the model:
 *
 * Session 1 (server 1.0.0): the agent needs one customer's unpaid total, has to page
 * through every invoice, and files a change request with an acceptance test through
 * the client's submission tool.
 * The vendor ships the fix in 1.1.0.
 * Session 2 (server 1.1.0, a new connection): any tool result says an update is waiting,
 * the client reads its inbox, finds the request shipped, re-runs its acceptance test,
 * confirms pass, and the agent drops its workaround. The client also reads the changes
 * feed from the version it last saw, and finds the same fix listed for everyone.
 *
 *   node dist/run.js [state directory]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ChangeRequestsClient,
  ChangesFeed,
  FileChangesLedger,
  FileLedger,
  changeRequestsCapabilities,
  runAcceptanceTest,
} from "@agent-change-requests/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXTENSION_ID, FIXED_IN, createInvoiceServer, type Invoice } from "./server.js";
import { shipFix } from "./ship.js";

const CUSTOMER = "cus_007";

type ListResult = {
  content: { type: string; text: string }[];
  structuredContent?: { invoices: Invoice[]; nextCursor?: string };
  _meta?: Record<string, unknown>;
};

export interface DemoResult {
  requestId: string;
  callsWithWorkaround: number;
  callsAfterFix: number;
  total: number;
  testBeforeFix: "pass" | "fail";
  confirmation: "pass" | "fail";
  /** What the changes feed listed in session 2, since the version session 1 saw. */
  changesSeen: { version: string; type: string; changeRequestIds?: string[] }[];
  transcript: string;
}

/** The acceptance test the agent writes: the call it wanted, and what it expected back. */
const acceptanceTest = {
  description: "Filtering by customer returns only that customer's unpaid invoices",
  call: {
    method: "tools/call" as const,
    params: { name: "list_invoices", arguments: { customer_id: "cus_123", status: "unpaid" } },
  },
  expect: {
    isError: false,
    structuredContentSchema: {
      type: "object",
      properties: {
        invoices: {
          type: "array",
          items: { type: "object", properties: { customer_id: { const: "cus_123" }, status: { const: "unpaid" } } },
        },
      },
      required: ["invoices"],
    },
  },
};

async function connect(version: string, dir: string, principal: string) {
  const { server, service } = createInvoiceServer({ version, store: join(dir, "requests.db"), principal });
  // The user turned change requests on for this server; this is not an ephemeral session.
  const consent = { consent: true, ephemeral: false };
  const client = new Client({ name: "demo-agent", version: "1.0.0" }, { capabilities: changeRequestsCapabilities(EXTENSION_ID, consent) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server, service, consent };
}

export async function runDemo(dir: string, principal = "demo-user"): Promise<DemoResult> {
  const lines: string[] = [];
  const say = (line = "") => lines.push(line);
  const ledger = new FileLedger(join(dir, "ledger.json"));
  const changesLedger = new FileChangesLedger(join(dir, "changes.json"));

  // ---- Session 1 -----------------------------------------------------------
  say(`## Session 1: server 1.0.0`);
  say();
  const s1 = await connect("1.0.0", dir, principal);
  const cr1 = new ChangeRequestsClient(s1.client, {
    extensionId: EXTENSION_ID,
    serverName: "Invoices",
    ledger,
    ...s1.consent,
    redaction: { sensitiveValues: ["Acme Corp"] },
  });
  say(`The server advertises ${EXTENSION_ID}: ${JSON.stringify(cr1.settings())}`);
  const tools1 = (await s1.client.listTools()).tools.map((t) => t.name);
  say(`Tools the model sees from the server: ${tools1.join(", ")} (no change_requests_submit, since this client has the extension).`);
  say(`Tool the client adds for the model: ${cr1.submissionTool().name}`);
  const feed1 = new ChangesFeed(s1.client, { extensionId: EXTENSION_ID, ledger: changesLedger, targets: ["list_invoices"] });
  const seen1 = await feed1.check();
  say(`The client reads the changes feed once and remembers the version: ${seen1.currentVersion}, ${seen1.changes.length} changes listed.`);
  say();
  say(`Task: total the unpaid invoices of ${CUSTOMER} (for Acme Corp).`);

  let cursor: string | undefined;
  let calls = 0;
  const unpaid: Invoice[] = [];
  do {
    const result = (await s1.client.callTool({ name: "list_invoices", arguments: cursor ? { cursor } : {} })) as ListResult;
    calls += 1;
    unpaid.push(...result.structuredContent!.invoices.filter((i) => i.customer_id === CUSTOMER && i.status === "unpaid"));
    cursor = result.structuredContent!.nextCursor;
  } while (cursor);
  const total = unpaid.reduce((sum, i) => sum + i.amount, 0);
  say(`list_invoices has no customer filter, so the agent paged through all of it: ${calls} calls for ${unpaid.length} invoices, total ${total}.`);

  const before = await runAcceptanceTest(s1.client, acceptanceTest);
  say(`The agent's acceptance test against 1.0.0: ${before.outcome} (${before.reasons.join("; ")}).`);
  say();

  // The model calls the client's submission tool. The client redacts, dedupes, caps, and sends.
  const filed = await cr1.callSubmissionTool({
    kind: "missing_capability",
    title: "list_invoices cannot filter by customer or status",
    description:
      "Totalling one customer's unpaid invoices for Acme Corp means paging through every invoice and filtering on the client. A customer_id and a status filter would make it one call.",
    target: { type: "tool", name: "list_invoices" },
    context: {
      goal: "Total one customer's unpaid invoices",
      workaround: "Page through all invoices and filter by customer_id and status on the client",
      cause: "The tool may predate per-customer reporting",
    },
    failureMode: "interface_cost",
    impact: { blocked: false, frequency: "recurring", severity: "medium", detectability: "immediate" },
    acceptanceTests: [acceptanceTest],
  });
  say(`Agent calls ${cr1.submissionTool().name}. Client answers the model: "${filed.content[0]!.text}"`);
  const requestId = cr1.entries()[0]!.requestId;
  const again = await cr1.callSubmissionTool({
    kind: "missing_capability",
    title: "Need a customer filter on list_invoices",
    description: "Same gap, noticed again.",
    target: { type: "tool", name: "list_invoices" },
  });
  say(`Later in the session the agent tries to file the same gap again: "${again.content[0]!.text}"`);
  await s1.client.close();
  say(`Session 1 ends. The client's ledger keeps the request, its test, and the workaround it relies on.`);
  say();

  // ---- The vendor ships ------------------------------------------------------
  say(`## The vendor ships ${FIXED_IN}`);
  say();
  const stored = (await s1.service.listAll()).items.find((r) => r.requestId === requestId)!;
  say(`What the vendor receives (after the client's redaction pass): "${stored.description}"`);
  say(`Acceptance test stored as data, never run on production data: ${JSON.stringify(stored.acceptanceTests![0]!.call)}`);
  const shipped = await shipFix(join(dir, "requests.db"), FIXED_IN);
  say(`The release script moves ${shipped.join(", ")} through triaged, planned, and building to shipped, with workaroundObsolete true.`);
  say();

  // ---- Session 2 -------------------------------------------------------------
  say(`## Session 2: server ${FIXED_IN}, a new connection`);
  say();
  const s2 = await connect(FIXED_IN, dir, principal);
  const obsolete: string[] = [];
  const cr2 = new ChangeRequestsClient(s2.client, {
    extensionId: EXTENSION_ID,
    serverName: "Invoices",
    ledger,
    ...s2.consent,
    onShipped: (status, entry) => {
      obsolete.push(status.requestId);
      say(`Client records: "${entry.title}" shipped in ${status.version}. Workaround no longer needed: ${entry.workaround}.`);
    },
  });
  const workaround = cr2.entries().find((e) => e.requestId === requestId)?.workaround;
  say(`The agent starts the same task with its old workaround (${workaround}).`);
  const first = (await s2.client.callTool({ name: "list_invoices", arguments: {} })) as ListResult;
  say(`First result carries _meta ${JSON.stringify(first._meta)} and the line "${first.content.at(-1)!.text}"`);
  const seen = await cr2.inspect(first);
  say(`The client reads its inbox: ${seen.inbox!.shipped.map((s) => `${s.requestId} ${s.status}: ${s.message}`).join("; ")}`);
  const confirmed = await cr2.retestAndConfirm(requestId);
  say(`The client re-runs its acceptance test under its own authorization: ${confirmed.outcome}. It confirms ${confirmed.outcome} to the server.`);

  const feed2 = new ChangesFeed(s2.client, { extensionId: EXTENSION_ID, ledger: changesLedger, targets: ["list_invoices"] });
  const news = await feed2.check();
  say(
    `The client reads the changes feed since ${seen1.currentVersion}: ${news.changes
      .map((c) => `${c.version} ${c.type}: "${c.summary}" (your request ${c.changeRequestIds?.join(", ") ?? "none"})`)
      .join("; ")}. Now at ${news.currentVersion}.`,
  );

  const fixedResult = (await s2.client.callTool({
    name: "list_invoices",
    arguments: { customer_id: CUSTOMER, status: "unpaid" },
  })) as ListResult;
  const fixedTotal = fixedResult.structuredContent!.invoices.reduce((sum, i) => sum + i.amount, 0);
  say(`The agent drops the workaround: 1 call with customer_id and status, total ${fixedTotal} (was ${calls} calls).`);

  const card = (await s2.client.callTool({ name: "change_requests_scorecard", arguments: {} })) as unknown as {
    structuredContent: { numbers: { confirmedFixed: { pass: number; of: number } } };
  };
  const fixedCount = card.structuredContent.numbers.confirmedFixed;
  say(`Scorecard: ${fixedCount.pass} of ${fixedCount.of} shipped requests confirmed fixed by the requester.`);
  await s2.client.close();

  if (fixedTotal !== total) throw new Error("The fixed call should give the same total as the workaround.");
  if (!obsolete.includes(requestId)) throw new Error("The client should have recorded the shipped request.");

  return {
    requestId,
    callsWithWorkaround: calls,
    callsAfterFix: 1,
    total,
    testBeforeFix: before.outcome,
    confirmation: confirmed.outcome,
    changesSeen: news.changes.map((c) => ({ version: c.version, type: c.type, ...(c.changeRequestIds ? { changeRequestIds: c.changeRequestIds } : {}) })),
    transcript: lines.join("\n"),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "demo-state";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const result = await runDemo(dir);
  const doc = `# Demo run\n\n${result.transcript}\n`;
  writeFileSync(join(dir, "transcript.md"), doc);
  console.log(doc);
}
