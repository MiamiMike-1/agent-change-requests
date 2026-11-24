import { describe, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import { runStoreConformance } from "../src/testing/conformance.js";

runStoreConformance({ describe, it }, () => new MemoryStore());
