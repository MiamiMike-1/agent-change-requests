import { describe, expect, it } from "vitest";
import { ANONYMOUS_PRINCIPAL } from "../src/service.js";
import { makeService, request, shippedResolution } from "./helpers.js";

const reason = (p: Promise<unknown>) => p.then(() => "ok", (e: { reason?: string }) => e.reason ?? String(e));

describe("anonymous callers (SEP section 3)", () => {
  it("are refused unless the server turns them on", async () => {
    const { service } = makeService();
    expect(service.anonymous).toBe(false);
    expect(await reason(service.submit(null, request()))).toBe("unauthenticated");
  });

  it("get a ticket that reads that one request, and nothing else", async () => {
    const { service } = makeService({ anonymous: true });
    const filed = await service.submit(null, request());
    expect(filed).toMatchObject({ status: "received", demand: 1 });
    expect(filed.ticket).toMatch(/^crt_[0-9a-f]{32}$/);

    expect(await service.get(null, filed.requestId, filed.ticket)).toMatchObject({ requestId: filed.requestId, status: "received" });
    // The ticket is a bearer credential: it works whoever holds it.
    expect(await service.get("user_b", filed.requestId, filed.ticket)).toMatchObject({ requestId: filed.requestId });

    const other = await service.submit(null, request());
    expect(await reason(service.get(null, other.requestId, filed.ticket!))).toBe("not_found");
    expect(await reason(service.get(null, filed.requestId, "crt_wrong"))).toBe("not_found");
    expect(await reason(service.get(null, filed.requestId))).toBe("unauthenticated");
  });

  it("never get a ticket when authenticated, and a ticket never opens an authenticated request", async () => {
    const { service } = makeService({ anonymous: true });
    const mine = await service.submit("user_a", request());
    expect(mine.ticket).toBeUndefined();
    expect(await reason(service.get(null, mine.requestId, "crt_anything"))).toBe("not_found");
  });

  it("get the same answer, ticket included, for a repeated idempotency key", async () => {
    const { service } = makeService({ anonymous: true });
    const first = await service.submit(null, request({ idempotencyKey: "same" }));
    expect(await service.submit(null, request({ idempotencyKey: "same" }))).toEqual(first);
  });

  it("have no inbox, cannot withdraw or confirm, and get no notice", async () => {
    const { service } = makeService({ anonymous: true });
    const filed = await service.submit(null, request());
    await service.transition(filed.requestId, { status: "shipped", resolution: shippedResolution });
    expect(await reason(service.list(null))).toBe("unauthenticated");
    expect(await reason(service.withdraw(null, filed.requestId))).toBe("unauthenticated");
    expect(await reason(service.confirm(null, { requestId: filed.requestId, outcome: "pass" }))).toBe("unauthenticated");
    expect(await service.notices(null)).toEqual({ updates: 0, changes: 0 });
    expect(await service.pendingUpdates(ANONYMOUS_PRINCIPAL)).toBe(0);
    // The shipped status still reads through the ticket.
    expect((await service.get(null, filed.requestId, filed.ticket)).status).toBe("shipped");
  });

  it("share one daily cap and count as one principal toward demand", async () => {
    const { service } = makeService({ anonymous: true, anonymousDailyCap: 2 });
    const survivor = await service.submit("user_a", request());
    const one = await service.submit(null, request());
    const two = await service.submit(null, request());
    expect(await reason(service.submit(null, request()))).toBe("rate_limited");
    await service.transition(one.requestId, { status: "duplicate", duplicateOf: survivor.requestId });
    await service.transition(two.requestId, { status: "duplicate", duplicateOf: survivor.requestId });
    expect((await service.get("user_a", survivor.requestId)).demand).toBe(2);
  });

  it("cannot be impersonated by a principal named like the anonymous one", async () => {
    const { service } = makeService({ anonymous: true });
    expect(await reason(service.submit(ANONYMOUS_PRINCIPAL, request()))).toBe("unauthenticated");
    expect(await reason(service.list(ANONYMOUS_PRINCIPAL))).toBe("unauthenticated");
  });
});
