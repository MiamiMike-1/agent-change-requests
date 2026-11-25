import { describe, it } from "vitest";
import { SqliteStore } from "../src/sqlite.js";
import { runFeedStoreConformance, runStoreConformance } from "../src/testing/conformance.js";

runStoreConformance({ describe, it }, () => SqliteStore.open(":memory:"));
runFeedStoreConformance({ describe, it }, () => SqliteStore.open(":memory:"));
