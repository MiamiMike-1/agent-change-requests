/**
 * An invoices MCP server with one deliberate gap.
 *
 * Version 1.0.0: list_invoices pages through every invoice, 50 at a time, and has no
 * way to ask for one customer's invoices. An agent that needs one customer's total
 * has to read all of them and filter on its side.
 *
 * Version 1.1.0 ships the fix: list_invoices takes customer_id and status.
 *
 * The change request integration is the block marked below.
 */
import { installChangeRequests } from "@agent-change-requests/server/middleware";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const EXTENSION_ID = "com.example/change-requests";
export const FIXED_IN = "1.1.0";
const PAGE_SIZE = 50;

export interface Invoice {
  id: string;
  customer_id: string;
  amount: number;
  status: "paid" | "unpaid";
}

/** 230 invoices across 20 customers, the same every run. */
export const INVOICES: Invoice[] = Array.from({ length: 230 }, (_, i) => ({
  id: `inv_${String(i + 1).padStart(4, "0")}`,
  customer_id: `cus_${String((i % 20) + 1).padStart(3, "0")}`,
  amount: 100 + ((i * 37) % 900),
  status: i % 3 === 0 ? "unpaid" : "paid",
}));

export interface DemoServerOptions {
  /** "1.0.0" has the gap; "1.1.0" has the fix. */
  version: string;
  /** SQLite file for change requests, shared by every session and by the builder. */
  store: string;
  /** The authenticated user. A real server takes it from its auth layer. */
  principal: string;
}

function hasFix(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 1);
}

export function createInvoiceServer(options: DemoServerOptions) {
  const server = new McpServer({ name: "invoices-demo", version: options.version });

  // ---- Agent Change Requests: the whole integration ----------------------
  const changeRequests = installChangeRequests(server, {
    appName: "Invoices",
    extensionId: EXTENSION_ID,
    store: options.store,
    getPrincipal: () => options.principal,
    policyUri: "https://example.com/change-requests-policy",
  });
  // -------------------------------------------------------------------------

  const fixed = hasFix(options.version);
  const inputSchema = {
    cursor: z.string().optional().describe("nextCursor from the previous page."),
    ...(fixed
      ? {
          customer_id: z.string().optional().describe("Only this customer's invoices."),
          status: z.enum(["paid", "unpaid"]).optional().describe("Only paid or only unpaid invoices."),
        }
      : {}),
  };

  server.registerTool(
    "list_invoices",
    {
      description: fixed
        ? "List invoices, 50 per page, optionally for one customer or one status."
        : "List all invoices, 50 per page.",
      inputSchema,
      outputSchema: {
        invoices: z.array(z.object({ id: z.string(), customer_id: z.string(), amount: z.number(), status: z.enum(["paid", "unpaid"]) })),
        nextCursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { cursor?: string; customer_id?: string; status?: "paid" | "unpaid" }) => {
      const rows = INVOICES.filter(
        (inv) => (!args.customer_id || inv.customer_id === args.customer_id) && (!args.status || inv.status === args.status),
      );
      const offset = Number(args.cursor ?? 0) || 0;
      const page = rows.slice(offset, offset + PAGE_SIZE);
      const next = offset + PAGE_SIZE < rows.length ? String(offset + PAGE_SIZE) : undefined;
      const structuredContent = { invoices: page, ...(next ? { nextCursor: next } : {}) };
      return {
        content: [{ type: "text" as const, text: `${page.length} invoices${next ? `, more after cursor ${next}` : ""}.` }],
        structuredContent,
      };
    },
  );

  return { server, ...changeRequests };
}
