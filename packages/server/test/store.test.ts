import { describe, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import { runFeedStoreConformance, runStoreConformance } from "../src/testing/conformance.js";

runStoreConformance({ describe, it }, () => new MemoryStore());
runFeedStoreConformance({ describe, it }, () => new MemoryStore());
