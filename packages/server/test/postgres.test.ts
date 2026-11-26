import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, it } from "vitest";
import { PostgresStore } from "../src/postgres.js";
import { runFeedStoreConformance, runStoreConformance } from "../src/testing/conformance.js";

const schema = readFileSync(new URL("../migrations/postgres.sql", import.meta.url), "utf8");

/** A real Postgres in the test process, with the migration this package ships. */
async function makeStore(): Promise<PostgresStore> {
  const db = new PGlite();
  await db.exec(schema);
  return new PostgresStore(async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[]);
}

runStoreConformance({ describe, it }, makeStore);
runFeedStoreConformance({ describe, it }, makeStore);
