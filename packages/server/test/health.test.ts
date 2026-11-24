import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HEALTH_TIMEOUT_MS, HEALTH_PROBE_REQUEST_ID, checkHealth, healthResponse, isHealthRequest } from "../src/health.js";
import { MemoryStore, type ChangeRequestStore } from "../src/store.js";
import { sampleRecord } from "../src/testing/conformance.js";

afterEach(() => {
  vi.useRealTimers();
});

function brokenStore(error: unknown): ChangeRequestStore {
  const store = new MemoryStore();
  store.get = async () => {
    throw error;
  };
  return store;
}

describe("checkHealth", () => {
  it("reports a store that answers, and adds the extension and version only when given", async () => {
    const store = new MemoryStore();
    expect(await checkHealth({ store })).toEqual({ ok: true, store: "reachable" });
    expect(await checkHealth({ store, extensionId: "com.example/change-requests", version: "1.4.0" })).toEqual({
      ok: true,
      store: "reachable",
      extension: "com.example/change-requests",
      version: "1.4.0",
    });
  });

  it("probes with one read of an id that does not exist, when the store has no ping", async () => {
    const store = new MemoryStore();
    const get = vi.spyOn(store, "get");
    await checkHealth({ store });
    expect(get.mock.calls).toEqual([[HEALTH_PROBE_REQUEST_ID]]);
  });

  it("uses the store's own ping when it has one, and reads nothing else", async () => {
    const store: ChangeRequestStore = new MemoryStore();
    const get = vi.spyOn(store, "get");
    store.ping = vi.fn(async () => {});
    expect((await checkHealth({ store })).ok).toBe(true);
    expect(store.ping).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    store.ping = async () => {
      throw new Error("down");
    };
    expect((await checkHealth({ store })).store).toBe("unreachable");
  });

  it("reports a failing store as unreachable and keeps the reason out of the report", async () => {
    const seen: unknown[] = [];
    const error = new Error("password authentication failed for user secret_user");
    const report = await checkHealth({ store: brokenStore(error), version: "1.4.0", onError: (e) => seen.push(e) });
    expect(report).toEqual({ ok: false, store: "unreachable", version: "1.4.0" });
    expect(JSON.stringify(report)).not.toContain("secret_user");
    expect(seen).toEqual([error]);
  });

  it("catches a store that throws before returning a promise, and a logger that throws", async () => {
    const store = new MemoryStore();
    store.get = (() => {
      throw new Error("sync");
    }) as never;
    const report = await checkHealth({
      store,
      onError: () => {
        throw new Error("logger broke");
      },
    });
    expect(report).toEqual({ ok: false, store: "unreachable" });
  });

  it("gives up on a store that never answers", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    store.get = () => new Promise(() => {});
    const seen: unknown[] = [];
    const pending = checkHealth({ store, onError: (e) => seen.push(e) });
    await vi.advanceTimersByTimeAsync(DEFAULT_HEALTH_TIMEOUT_MS - 1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, store: "unreachable" });
    expect(String(seen[0])).toContain("did not answer");
  });

  it("returns no stored data, whatever the store holds", async () => {
    const store = new MemoryStore();
    await store.insert(sampleRecord({ requestId: HEALTH_PROBE_REQUEST_ID, title: "private title" }));
    const res = await healthResponse({ store });
    expect(await res.text()).toBe('{"ok":true,"store":"reachable"}');
  });
});

describe("healthResponse", () => {
  it("answers 200 or 503 as JSON that is not cached", async () => {
    const up = await healthResponse({ store: new MemoryStore() });
    expect(up.status).toBe(200);
    expect(up.headers.get("content-type")).toBe("application/json");
    expect(up.headers.get("cache-control")).toBe("no-store");
    expect(await up.json()).toEqual({ ok: true, store: "reachable" });
    const down = await healthResponse({ store: brokenStore(new Error("x")) });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false, store: "unreachable" });
  });

  it("sends no body for HEAD", async () => {
    const res = await healthResponse({ store: new MemoryStore(), method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("isHealthRequest", () => {
  const is = (method: string, url: string, path?: string) => isHealthRequest({ method, url }, path);

  it("matches GET and HEAD on a path ending in /health", () => {
    expect(is("GET", "https://example.com/health")).toBe(true);
    expect(is("HEAD", "https://example.com/functions/v1/mcp/health")).toBe(true);
    expect(is("GET", "https://example.com/mcp/health/?x=1")).toBe(true);
    expect(is("GET", "/mcp/health")).toBe(true);
  });

  it("matches nothing else, so every other route keeps its credential check", () => {
    expect(is("POST", "https://example.com/mcp/health")).toBe(false);
    expect(is("DELETE", "https://example.com/mcp/health")).toBe(false);
    expect(is("GET", "https://example.com/mcp")).toBe(false);
    expect(is("GET", "https://example.com/mcp/healthz")).toBe(false);
    expect(is("GET", "https://example.com/mcp/unhealth")).toBe(false);
    expect(is("GET", "https://example.com/mcp?path=/health")).toBe(false);
    expect(is("GET", "https://example.com/health/more")).toBe(false);
  });

  it("takes another path", () => {
    expect(is("GET", "https://example.com/mcp/status", "/status")).toBe(true);
    expect(is("GET", "https://example.com/mcp/health", "/status")).toBe(false);
  });
});
