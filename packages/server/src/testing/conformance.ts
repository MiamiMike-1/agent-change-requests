/**
 * A conformance suite for ChangeRequestStore implementations. Run it from your own
 * test runner against a fresh store for each test:
 *
 *   import { describe, it } from "vitest";
 *   import { runStoreConformance } from "@agent-change-requests/server/testing";
 *   runStoreConformance({ describe, it }, () => new MyStore(freshDb()));
 */
import assert from "node:assert/strict";
import type { ChangeRequestStore } from "../store.js";
import type { ChangeRequestRecord } from "../types.js";

export interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
}

export function sampleRecord(overrides: Partial<ChangeRequestRecord> = {}): ChangeRequestRecord {
  const at = overrides.createdAt ?? "2026-01-05T12:00:00.000Z";
  return {
    requestId: "crq_sample",
    principal: "user_a",
    idempotencyKey: "key-1",
    kind: "missing_capability",
    title: "Example request",
    description: "An example.",
    origin: "agent",
    about: "app",
    status: "received",
    demandFrom: [overrides.principal ?? "user_a"],
    confirmations: [],
    stages: { requested: at },
    approximate: [],
    unread: false,
    pickedUp: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function runStoreConformance(t: TestApi, makeStore: () => ChangeRequestStore | Promise<ChangeRequestStore>): void {
  t.describe("ChangeRequestStore conformance", () => {
    t.it("round-trips a record unchanged", async () => {
      const store = await makeStore();
      const record = sampleRecord({
        target: { type: "tool", name: "list_things" },
        acceptanceTests: [{ call: { method: "tools/call", params: { name: "list_things" } } }],
        approximate: ["approved"],
      });
      await store.insert(record);
      assert.deepEqual(await store.get(record.requestId), record);
    });

    t.it("returns null for an unknown id", async () => {
      const store = await makeStore();
      assert.equal(await store.get("crq_missing"), null);
    });

    t.it("refuses a second record with the same principal and idempotency key", async () => {
      const store = await makeStore();
      await store.insert(sampleRecord());
      await assert.rejects(store.insert(sampleRecord({ requestId: "crq_other" })));
      // Another principal may reuse the key.
      await store.insert(sampleRecord({ requestId: "crq_b", principal: "user_b" }));
      assert.equal((await store.findByIdempotencyKey("user_b", "key-1"))?.requestId, "crq_b");
    });

    t.it("updates a record in place", async () => {
      const store = await makeStore();
      await store.insert(sampleRecord());
      const changed = sampleRecord({ status: "shipped", unread: true, updatedAt: "2026-01-06T00:00:00.000Z" });
      await store.update(changed);
      assert.deepEqual(await store.get("crq_sample"), changed);
    });

    t.it("lists one principal's records newest first, with filters and pages", async () => {
      const store = await makeStore();
      const days = ["01", "02", "03", "04"];
      for (const [i, d] of days.entries()) {
        await store.insert(
          sampleRecord({
            requestId: `crq_${i}`,
            idempotencyKey: `k${i}`,
            updatedAt: `2026-01-${d}T00:00:00.000Z`,
            status: i % 2 === 0 ? "received" : "shipped",
            about: i === 3 ? "spec" : "app",
          }),
        );
      }
      await store.insert(sampleRecord({ requestId: "crq_x", principal: "user_b", idempotencyKey: "kx" }));

      const all = await store.list("user_a", {});
      assert.deepEqual(all.items.map((r) => r.requestId), ["crq_3", "crq_2", "crq_1", "crq_0"]);

      const shipped = await store.list("user_a", { status: ["shipped"] });
      assert.deepEqual(shipped.items.map((r) => r.requestId), ["crq_3", "crq_1"]);

      const spec = await store.list("user_a", { about: "spec" });
      assert.deepEqual(spec.items.map((r) => r.requestId), ["crq_3"]);

      const recent = await store.list("user_a", { updatedSince: "2026-01-03T00:00:00.000Z" });
      assert.deepEqual(recent.items.map((r) => r.requestId), ["crq_3", "crq_2"]);

      const first = await store.list("user_a", { limit: 3 });
      assert.equal(first.items.length, 3);
      assert.ok(first.nextCursor);
      const second = await store.list("user_a", { limit: 3, cursor: first.nextCursor });
      assert.deepEqual(second.items.map((r) => r.requestId), ["crq_0"]);
      assert.equal(second.nextCursor, undefined);

      const everyone = await store.list(null, {});
      assert.equal(everyone.items.length, 5);
    });

    t.it("counts submissions and unread updates per principal", async () => {
      const store = await makeStore();
      await store.insert(sampleRecord({ requestId: "a", idempotencyKey: "a", createdAt: "2026-01-01T00:00:00.000Z" }));
      await store.insert(sampleRecord({ requestId: "b", idempotencyKey: "b", createdAt: "2026-01-02T00:00:00.000Z", unread: true }));
      await store.insert(sampleRecord({ requestId: "c", idempotencyKey: "c", principal: "user_b", createdAt: "2026-01-02T00:00:00.000Z", unread: true }));
      assert.equal(await store.countSubmittedSince("user_a", "2026-01-01T12:00:00.000Z"), 1);
      assert.equal(await store.oldestSubmittedSince("user_a", "2025-12-31T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
      assert.equal(await store.oldestSubmittedSince("user_a", "2026-02-01T00:00:00.000Z"), null);
      assert.equal(await store.countUnread("user_a"), 1);
    });

    t.it("stores and filters gaps", async () => {
      const store = await makeStore();
      await store.insertGap({ principal: "user_a", target: "list_things", reason: "empty_result", at: "2026-01-01T00:00:00.000Z" });
      await store.insertGap({ principal: "user_b", target: "list_things", reason: "validation_error", at: "2026-01-02T00:00:00.000Z" });
      assert.equal((await store.listGaps("user_a")).length, 1);
      assert.equal((await store.listGaps(null)).length, 2);
      assert.equal((await store.listGaps(null, "2026-01-01T12:00:00.000Z")).length, 1);
    });
  });
}
