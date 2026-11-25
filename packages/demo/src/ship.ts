#!/usr/bin/env node
/**
 * The build side of the demo: what a vendor's CI or release script does once the fix
 * is merged. It moves every open request about list_invoices to shipped, with the
 * version the fix is live in, records the build stages for the scorecard, and
 * publishes the change to the changes feed (SEP section 12).
 *
 *   node dist/ship.js [path/to/requests.db] [version]
 */
import { ChangeRequestService } from "@agent-change-requests/server";
import { SqliteStore } from "@agent-change-requests/server/sqlite";
import { FIXED_IN } from "./server.js";

const OPEN = ["received", "needs_info", "triaged", "planned", "building"] as const;

export async function shipFix(storePath: string, version = FIXED_IN): Promise<string[]> {
  const service = new ChangeRequestService({ store: SqliteStore.open(storePath) });
  const open = (await service.listAll({ status: [...OPEN] })).items.filter(
    (r) => r.target?.type === "tool" && r.target.name === "list_invoices",
  );
  const shipped: string[] = [];
  for (const request of open) {
    const at = () => new Date().toISOString();
    // Walk the lifecycle from wherever the request is: triaged, planned, building, shipped.
    const path = ["triaged", "planned", "building"] as const;
    const from = path.indexOf(request.status as (typeof path)[number]);
    for (const status of path.slice(from + 1)) {
      await service.transition(request.requestId, { status });
      if (status === "planned") await service.recordStage(request.requestId, "approved", at());
    }
    await service.recordStage(request.requestId, "built", at());
    await service.recordStage(request.requestId, "merged", at());
    await service.recordStage(request.requestId, "published", at());
    await service.transition(request.requestId, {
      status: "shipped",
      version,
      message: "list_invoices now accepts customer_id and status.",
      resolution: {
        availability: "all",
        changed: [{ type: "tool", name: "list_invoices" }],
        workaroundObsolete: true,
        tests: (request.acceptanceTests ?? []).map((_, index) => ({ index, outcome: "pass" as const })),
      },
    });
    shipped.push(request.requestId);
  }
  // One feed entry for everyone, asked for or not. Each requester also sees its own request id on it.
  // Running the script twice publishes the entry once.
  const published = await service.changes(null);
  if (!published.changes.some((c) => c.version === version && c.type === "added")) {
    await service.publishChange({
      version,
      type: "added",
      summary: "list_invoices can now filter by customer_id and status.",
      changed: [{ type: "tool", name: "list_invoices" }],
      changeRequestIds: shipped,
    });
  }
  return shipped;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [storePath = "demo-state/requests.db", version] = process.argv.slice(2);
  const shipped = await shipFix(storePath, version);
  console.log(shipped.length ? `Shipped ${shipped.join(", ")} in ${version ?? FIXED_IN}.` : "No open requests about list_invoices.");
}
