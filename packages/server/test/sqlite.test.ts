import { describe, it } from "vitest";
import { SqliteStore } from "../src/sqlite.js";
import { runStoreConformance } from "../src/testing/conformance.js";

runStoreConformance({ describe, it }, () => SqliteStore.open(":memory:"));
