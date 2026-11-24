import { describe, expect, it } from "vitest";
import { ChangeRequestError } from "../src/errors.js";
import { makeService, request, shippedResolution } from "./helpers.js";

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChangeRequestError) return e.reason;
    throw e;
  }
  return "no error";
}

describe("submit", () => {
  it("stores a request and returns its id and status", async () => {
    const { service, events } = makeService();
    const result = await service.submit("user_a", request());
    expect(result).toEqual({ requestId: "crq_1", status: "received", duplicateOf: null, demand: 1 });
    expect(events).toHaveLength(1);
  });

  it("returns the first answer for a repeated idempotency key", async () => {
    const { service } = makeService();
    const first = await service.submit("user_a", request({ idempotencyKey: "same" }));
    const again = await service.submit("user_a", request({ idempotencyKey: "same", title: "Different" }));
    expect(again).toEqual(first);
    const other = await service.submit("user_b", request({ idempotencyKey: "same" }));
    expect(other.requestId).not.toBe(first.requestId);
  });

  it("refuses a caller with no principal", async () => {
    const { service } = makeService();
    expect(await reason(service.submit(null, request()))).toBe("unauthenticated");
  });

  it("refuses kinds the server did not advertise", async () => {
    const { service } = makeService({ kinds: ["bug"] });
    expect(await reason(service.submit("user_a", request()))).toBe("kind_unsupported");
  });

  it("refuses acceptance tests when the server does not take them", async () => {
    const { service } = makeService({ acceptanceTests: false });
    const tests = [{ call: { method: "tools/call", params: { name: "list_things" } } }];
    expect(await reason(service.submit("user_a", request({ acceptanceTests: tests })))).toBe("tests_unsupported");
  });

  it("enforces the field limits from the spec", async () => {
    const { service } = makeService();
    const cases: Record<string, unknown>[] = [
      { title: "x".repeat(121) },
      { description: "x".repeat(4001) },
      { target: { type: "tool" } },
      { context: { cause: "x".repeat(501) } },
      { context: { attempts: [{}, {}, {}, {}, {}, {}] } },
      { acceptanceTests: Array.from({ length: 11 }, () => ({ call: { method: "tools/call" } })) },
      { acceptanceTests: [{ call: { method: "tools/list" } }] },
      { acceptanceTests: [{ call: { method: "tools/call" }, expect: { textContains: ["a", "b", "c", "d", "e", "f"] } }] },
      { impact: { severity: "extreme" } },
    ];
    for (const c of cases) expect(await reason(service.submit("user_a", request(c)))).toBe("invalid_params");
  });

  it("stores an unrecognized failure mode unchanged", async () => {
    const { service, store } = makeService();
    const { requestId } = await service.submit("user_a", request({ failureMode: "com.example/quota_reset" }));
    expect((await store.get(requestId))?.failureMode).toBe("com.example/quota_reset");
  });

  it("caps submissions per principal per day", async () => {
    const { service, advance } = makeService({ dailyCap: 2 });
    await service.submit("user_a", request());
    advance(60_000);
    await service.submit("user_a", request());
    try {
      await service.submit("user_a", request());
      expect.unreachable();
    } catch (e) {
      expect((e as ChangeRequestError).reason).toBe("rate_limited");
      expect((e as ChangeRequestError).retryAfterMs).toBe(24 * 60 * 60 * 1000 - 60_000);
    }
    await service.submit("user_b", request());
  });

  it("marks requests about the change request tools as about the spec", async () => {
    const { service, store } = makeService();
    const spec = await service.submit("user_a", request({ target: { type: "tool", name: "change_requests_list" } }));
    const app = await service.submit("user_a", request());
    const told = await service.submit("user_a", request({ about: "spec", target: { type: "server" } }));
    expect((await store.get(spec.requestId))?.about).toBe("spec");
    expect((await store.get(app.requestId))?.about).toBe("app");
    expect((await store.get(told.requestId))?.about).toBe("spec");
  });
});

describe("inbox", () => {
  it("shows a principal only its own requests", async () => {
    const { service } = makeService();
    const mine = await service.submit("user_a", request());
    await service.submit("user_b", request());
    const page = await service.list("user_a");
    expect(page.items.map((r) => r.requestId)).toEqual([mine.requestId]);
    expect(await reason(service.get("user_b", mine.requestId))).toBe("not_found");
  });

  it("counts an update until the requester reads it", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    expect(await service.pendingUpdates("user_a")).toBe(0);
    await service.transition(requestId, { status: "planned" });
    expect(await service.pendingUpdates("user_a")).toBe(1);
    expect(await service.pendingUpdates("user_b")).toBe(0);
    await service.list("user_a");
    expect(await service.pendingUpdates("user_a")).toBe(0);
    await service.transition(requestId, { status: "shipped", resolution: shippedResolution, version: "1.2.0" });
    const status = await service.get("user_a", requestId);
    expect(status).toMatchObject({ status: "shipped", version: "1.2.0", resolution: shippedResolution });
    expect(await service.pendingUpdates("user_a")).toBe(0);
  });

  it("gives a shared credential no notice and no inbox", async () => {
    const { service } = makeService({ isSharedCredential: (p) => p === "shared_key" });
    const { requestId } = await service.submit("shared_key", request());
    await service.transition(requestId, { status: "planned" });
    expect(await service.pendingUpdates("shared_key")).toBe(0);
    expect(await reason(service.list("shared_key"))).toBe("shared_credential");
  });

  it("filters the inbox by about", async () => {
    const { service } = makeService();
    await service.submit("user_a", request({ about: "spec" }));
    await service.submit("user_a", request());
    expect((await service.list("user_a", { about: "spec" })).items).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("never moves a request out of a final status", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    await service.transition(requestId, { status: "declined", message: "Out of scope." });
    expect(await reason(service.transition(requestId, { status: "planned" }))).toBe("terminal_status");
  });

  it("allows skipping ahead but not going back", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    await service.transition(requestId, { status: "building" });
    expect(await reason(service.transition(requestId, { status: "triaged" }))).toBe("invalid_transition");
  });

  it("requires a resolution to ship and a message to decline or ask for info", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    expect(await reason(service.transition(requestId, { status: "shipped" }))).toBe("invalid_params");
    expect(await reason(service.transition(requestId, { status: "declined" }))).toBe("invalid_params");
    expect(await reason(service.transition(requestId, { status: "needs_info" }))).toBe("invalid_params");
  });

  it("lets only the submitter withdraw, and only before a final status", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    expect(await reason(service.withdraw("user_b", requestId))).toBe("not_found");
    expect((await service.withdraw("user_a", requestId)).status).toBe("withdrawn");
    expect(await reason(service.withdraw("user_a", requestId))).toBe("terminal_status");
    expect(await reason(service.transition(requestId, { status: "planned" }))).toBe("terminal_status");
  });

  it("counts demand by distinct principal when merging duplicates", async () => {
    const { service } = makeService();
    const a = await service.submit("user_a", request());
    const b = await service.submit("user_b", request());
    const a2 = await service.submit("user_a", request());
    await service.transition(b.requestId, { status: "duplicate", duplicateOf: a.requestId });
    await service.transition(a2.requestId, { status: "duplicate", duplicateOf: a.requestId });
    expect((await service.get("user_a", a.requestId)).demand).toBe(2);
    const dup = await service.get("user_b", b.requestId);
    expect(dup.duplicateOf).toBe(a.requestId);
    expect(dup.title).not.toContain("user_a");
  });
});

describe("confirm", () => {
  it("only confirms a shipped request, and only for its submitter", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    expect(await reason(service.confirm("user_a", { requestId, outcome: "pass" }))).toBe("not_shipped");
    await service.transition(requestId, { status: "shipped", resolution: shippedResolution });
    expect(await reason(service.confirm("user_b", { requestId, outcome: "pass" }))).toBe("not_found");
  });

  it("keeps the latest confirmation and the earlier ones, and records adoption", async () => {
    const { service, store, advance } = makeService();
    const tests = [{ call: { method: "tools/call", params: { name: "list_things", arguments: { owner: "o_1" } } } }];
    const { requestId } = await service.submit("user_a", request({ acceptanceTests: tests }));
    await service.transition(requestId, { status: "shipped", resolution: shippedResolution });
    await service.confirm("user_a", { requestId, outcome: "fail", tests: [{ index: 0, outcome: "fail" }] });
    advance(3_600_000);
    const status = await service.confirm("user_a", { requestId, outcome: "pass", adopted: true });
    expect(status.confirmation).toMatchObject({ outcome: "pass", adopted: true });
    const record = await store.get(requestId);
    expect(record?.confirmations.map((c) => c.outcome)).toEqual(["fail", "pass"]);
    expect(record?.stages.adopted).toBeDefined();
    expect(await reason(service.confirm("user_a", { requestId, outcome: "pass", tests: [{ index: 3, outcome: "pass" }] }))).toBe(
      "invalid_params",
    );
  });
});

describe("recordStage", () => {
  it("records build stages without raising an update", async () => {
    const { service, store } = makeService();
    const { requestId } = await service.submit("user_a", request());
    await service.recordStage(requestId, "approved", "2026-01-05T13:00:00.000Z", { approximate: true });
    await service.recordStage(requestId, "built", "2026-01-05T14:00:00.000Z");
    const record = await store.get(requestId);
    expect(record?.stages).toMatchObject({ approved: "2026-01-05T13:00:00.000Z", built: "2026-01-05T14:00:00.000Z" });
    expect(record?.approximate).toEqual(["approved"]);
    expect(await service.pendingUpdates("user_a")).toBe(0);
  });
});

describe("concurrency and edge cases", () => {
  it("returns the first answer for a repeated key even after the request moves on", async () => {
    const { service } = makeService();
    const first = await service.submit("user_a", request({ idempotencyKey: "k" }));
    await service.transition(first.requestId, { status: "triaged" });
    expect(await service.submit("user_a", request({ idempotencyKey: "k" }))).toEqual(first);
  });

  it("keeps a status change made between another writer's read and write", async () => {
    const { service, store } = makeService();
    const { requestId } = await service.submit("user_a", request());
    await service.transition(requestId, { status: "shipped", resolution: shippedResolution });
    // A stale copy, read before the update was seen, cannot overwrite the newer record.
    const stale = await store.get(requestId);
    await service.list("user_a", {});
    expect(await store.update({ ...stale!, unread: true, revision: stale!.revision + 1 }, stale!.revision)).toBe(false);
    const after = await store.get(requestId);
    expect(after?.unread).toBe(false);
    expect(after?.pickedUp).toBe(true);
    expect(after?.status).toBe("shipped");
  });

  it("sets updatedAt to now even when a stage is back-dated", async () => {
    const { service, store, advance, nowIso } = makeService();
    const { requestId } = await service.submit("user_a", request());
    advance(60_000);
    await service.transition(requestId, {
      status: "shipped",
      resolution: shippedResolution,
      at: "2026-01-01T00:00:00.000Z",
    });
    const record = await store.get(requestId);
    expect(record?.updatedAt).toBe(nowIso());
    expect(record?.stages.live).toBe("2026-01-01T00:00:00.000Z");
  });

  it("refuses a transition time that is not a date", async () => {
    const { service } = makeService();
    const { requestId } = await service.submit("user_a", request());
    expect(await reason(service.transition(requestId, { status: "triaged", at: "soon" }))).toBe("invalid_params");
  });

  it("gives a shared credential no scorecard, withdraw, or confirm", async () => {
    const { service } = makeService({ isSharedCredential: (p) => p === "shared" });
    const { requestId } = await service.submit("shared", request());
    expect(await reason(service.scorecard("shared"))).toBe("shared_credential");
    expect(await reason(service.withdraw("shared", requestId))).toBe("shared_credential");
    expect(await reason(service.confirm("shared", { requestId, outcome: "pass" }))).toBe("shared_credential");
  });

  it("follows a duplicate chain to the open request and refuses a closed one", async () => {
    const { service, store } = makeService();
    const a = await service.submit("user_a", request());
    const b = await service.submit("user_b", request());
    const c = await service.submit("user_c", request());
    await service.transition(b.requestId, { status: "duplicate", duplicateOf: a.requestId });
    await service.transition(c.requestId, { status: "duplicate", duplicateOf: b.requestId });
    expect((await store.get(c.requestId))?.duplicateOf).toBe(a.requestId);
    expect((await store.get(a.requestId))?.demandFrom).toEqual(["user_a", "user_b", "user_c"]);

    const d = await service.submit("user_d", request());
    const e = await service.submit("user_e", request());
    await service.transition(d.requestId, { status: "declined", message: "Out of scope." });
    expect(await reason(service.transition(e.requestId, { status: "duplicate", duplicateOf: d.requestId }))).toBe(
      "terminal_status",
    );
  });

  it("only marks a received request as a duplicate", async () => {
    const { service } = makeService();
    const a = await service.submit("user_a", request());
    const b = await service.submit("user_b", request());
    await service.transition(b.requestId, { status: "triaged" });
    expect(await reason(service.transition(b.requestId, { status: "duplicate", duplicateOf: a.requestId }))).toBe(
      "invalid_transition",
    );
  });
});
