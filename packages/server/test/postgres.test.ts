import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PostgresStore } from "../src/postgres.js";
import { runFeedStoreConformance, runStoreConformance } from "../src/testing/conformance.js";

const schema = readFileSync(new URL("../migrations/postgres.sql", import.meta.url), "utf8");

/** A real Postgres in the test process, with the migration this package ships. */
async function makeDb(): Promise<{ db: PGlite; store: PostgresStore }> {
  const db = new PGlite();
  await db.exec(schema);
  const store = new PostgresStore(async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[]);
  return { db, store };
}

const makeStore = async () => (await makeDb()).store;

runStoreConformance({ describe, it }, makeStore);
runFeedStoreConformance({ describe, it }, makeStore);

describe("PostgresStore records", () => {
  it("are sent as text and stored as JSON objects, so SQL can read inside them", async () => {
    const texts: string[] = [];
    const { db } = await makeDb();
    const store = new PostgresStore(async (text, params) => {
      texts.push(text);
      return (await db.query(text, params)).rows as Record<string, unknown>[];
    });
    const at = "2026-01-02T03:04:05.000Z";
    await store.insert({
      requestId: "crq_1",
      principal: "p",
      idempotencyKey: "k",
      status: "received",
      about: "app",
      unread: false,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    } as never);
    await store.appendChange({ changeId: "chg_1" } as never);
    const rows = (await db.query("select jsonb_typeof(record) as kind, record->>'createdAt' as created from acr_change_requests")).rows;
    expect(rows).toEqual([{ kind: "object", created: at }]);
    expect(await store.oldestSubmittedSince("p", "2026-01-01T00:00:00.000Z")).toBe(at);
    // A bare ::jsonb parameter makes some drivers encode the JSON text a second time.
    const jsonParams = texts.join("\n").match(/\$\d+::(text::)?jsonb/g) ?? [];
    expect(jsonParams.length).toBeGreaterThan(0);
    expect(jsonParams.every((p) => p.includes("::text::jsonb"))).toBe(true);
  });
});
