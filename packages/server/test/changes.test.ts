import { describe, expect, it } from "vitest";
import { compareVersions } from "../src/versions.js";
import { makeService, request, shippedResolution } from "./helpers.js";

const reason = (p: Promise<unknown>) => p.then(() => "ok", (e: { reason?: string }) => e.reason ?? String(e));
const DAY = 24 * 60 * 60 * 1000;

describe("compareVersions", () => {
  it("orders semantic versions, pre-releases before releases", () => {
    const sorted = ["1.10.0", "1.2.0", "1.2.0-beta.2", "1.2.0-beta.10", "v1.1", "2.0.0", "1.2.0-alpha"].sort(compareVersions);
    expect(sorted).toEqual(["v1.1", "1.2.0-alpha", "1.2.0-beta.2", "1.2.0-beta.10", "1.2.0", "1.10.0", "2.0.0"]);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("changes feed (SEP section 12)", () => {
  async function withFeed() {
    const t = makeService({ currentVersion: "1.7.0" });
    await t.service.publishChange({ version: "1.6.0", type: "added", summary: "export_report exists." });
    t.advance(DAY);
    await t.service.publishChange({
      version: "1.7.0",
      type: "added",
      summary: "list_invoices can now filter by customer.",
      changed: [{ type: "tool", name: "list_invoices" }],
      changelogUri: "https://example.com/changelog#1.7.0",
    });
    await t.service.publishChange({
      version: "1.7.0",
      type: "deprecated",
      summary: "export_csv is deprecated. Use export_report with format csv.",
      changed: [{ type: "tool", name: "export_csv" }],
      removeAfter: "2027-02-01",
    });
    return t;
  }

  it("lists changes after a version, newest first, with the current version", async () => {
    const { service } = await withFeed();
    const page = await service.changes(null, { sinceVersion: "1.6.0" });
    expect(page.currentVersion).toBe("1.7.0");
    expect(page.changes.map((c) => c.type)).toEqual(["deprecated", "added"]);
    expect(page.changes[0]).toEqual({
      version: "1.7.0",
      publishedAt: "2026-01-06T12:00:00.000Z",
      type: "deprecated",
      breaking: false,
      summary: "export_csv is deprecated. Use export_report with format csv.",
      changed: [{ type: "tool", name: "export_csv" }],
      removeAfter: "2027-02-01",
    });
    expect((await service.changes(null, { sinceVersion: "1.7.0" })).changes).toEqual([]);
    expect((await service.changes(null, { sinceVersion: "1.0.0" })).changes).toHaveLength(3);
    expect((await service.changes(null, {})).changes).toHaveLength(3);
  });

  it("lists changes after a time, and pages", async () => {
    const { service } = await withFeed();
    expect((await service.changes(null, { since: "2026-01-05T12:00:00.000Z" })).changes).toHaveLength(2);
    const first = await service.changes(null, { limit: 2 });
    expect(first.changes).toHaveLength(2);
    const second = await service.changes(null, { limit: 2, cursor: first.nextCursor! });
    expect(second.changes.map((c) => c.version)).toEqual(["1.6.0"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("refuses bad queries and bad entries", async () => {
    const { service } = await withFeed();
    expect(await reason(service.changes(null, { sinceVersion: "1.0.0", since: "2026-01-01T00:00:00Z" }))).toBe("invalid_params");
    expect(await reason(service.changes(null, { since: "yesterday" }))).toBe("invalid_params");
    expect(await reason(service.publishChange({ version: "2.0.0", type: "renamed" as never, summary: "x" }))).toBe("invalid_params");
    expect(await reason(service.publishChange({ version: "2.0.0", type: "added", summary: "x".repeat(501) }))).toBe("invalid_params");
    expect(await reason(service.publishChange({ version: "2.0.0", type: "removed", summary: "Gone.", breaking: false }))).toBe(
      "invalid_params",
    );
    expect(await reason(service.publishChange({ version: "2.0.0", type: "fixed", summary: "x", changeRequestIds: ["crq_none"] }))).toBe(
      "not_found",
    );
    expect(await reason(service.publishChange({ version: "2.0.0", type: "added", summary: "x", availability: "requester" }))).toBe(
      "invalid_params",
    );
  });

  it("marks a removed entry breaking", async () => {
    const { service } = makeService();
    const removed = await service.publishChange({ version: "2.0.0", type: "removed", summary: "export_csv is gone." });
    expect(removed.breaking).toBe(true);
  });

  it("shows each principal only its own changeRequestIds, and requester-only changes only to their owners", async () => {
    const { service } = makeService();
    const a = await service.submit("user_a", request());
    const b = await service.submit("user_b", request());
    await service.publishChange({
      version: "1.1.0",
      type: "added",
      summary: "list_things can filter by owner.",
      changeRequestIds: [a.requestId, b.requestId],
    });
    await service.publishChange({ version: "1.1.0", type: "changed", summary: "Early access for user_a.", availability: "requester", changeRequestIds: [a.requestId] });

    const forA = await service.changes("user_a");
    expect(forA.changes.map((c) => [c.summary, c.changeRequestIds])).toEqual([
      ["Early access for user_a.", [a.requestId]],
      ["list_things can filter by owner.", [a.requestId]],
    ]);
    const forB = await service.changes("user_b");
    expect(forB.changes.map((c) => [c.summary, c.changeRequestIds])).toEqual([["list_things can filter by owner.", [b.requestId]]]);
    const anon = await service.changes(null);
    expect(anon.changes).toHaveLength(1);
    expect(anon.changes[0]!.changeRequestIds).toBeUndefined();
  });

  it("counts unread breaking and deprecated changes, not additions, and clears them on reading", async () => {
    const t = makeService();
    const { service } = t;
    // First contact: what already shipped counts as read.
    await service.publishChange({ version: "1.0.0", type: "deprecated", summary: "Old." });
    expect(await service.pendingChanges("user_a")).toBe(0);

    await service.publishChange({ version: "1.1.0", type: "added", summary: "New tool." });
    await service.publishChange({ version: "1.1.0", type: "deprecated", summary: "export_csv is deprecated.", removeAfter: "2027-02-01" });
    await service.publishChange({ version: "1.1.0", type: "changed", breaking: true, summary: "list_things pages by 20." });
    expect(await service.notices("user_a")).toEqual({ updates: 0, changes: 2 });
    expect(await service.pendingChanges(null)).toBe(0);

    await service.changes("user_a", { sinceVersion: "1.1.0" });
    expect(await service.pendingChanges("user_a")).toBe(0);
  });

  it("lets a principal turn the changes notice off and on", async () => {
    const { service } = makeService();
    expect(await service.pendingChanges("user_a")).toBe(0);
    await service.setChangeNotice("user_a", false);
    await service.publishChange({ version: "2.0.0", type: "removed", summary: "export_csv is gone." });
    expect(await service.pendingChanges("user_a")).toBe(0);
    await service.setChangeNotice("user_a", true);
    expect(await service.pendingChanges("user_a")).toBe(1);
  });

  it("gives a shared credential the public feed and no notice", async () => {
    const { service } = makeService({ isSharedCredential: (p) => p === "shared_key" });
    expect(await service.pendingChanges("shared_key")).toBe(0);
    await service.publishChange({ version: "2.0.0", type: "removed", summary: "export_csv is gone." });
    expect(await service.pendingChanges("shared_key")).toBe(0);
    expect((await service.changes("shared_key")).changes).toHaveLength(1);
  });

  it("can be turned off", async () => {
    const { service } = makeService({ changes: false });
    expect(service.changesEnabled).toBe(false);
    expect(await reason(service.changes(null))).toBe("invalid_params");
    expect(await service.pendingChanges("user_a")).toBe(0);
  });

  it("defaults currentVersion to the newest version in the feed", async () => {
    const { service } = makeService();
    expect((await service.changes(null)).currentVersion).toBe("0.0.0");
    await service.publishChange({ version: "1.10.0", type: "added", summary: "b" });
    await service.publishChange({ version: "1.9.0", type: "fixed", summary: "a backport" });
    expect((await service.changes(null)).currentVersion).toBe("1.10.0");
  });

  it("names the caller's request for a shipped fix", async () => {
    const { service } = makeService();
    const a = await service.submit("user_a", request());
    await service.transition(a.requestId, { status: "shipped", resolution: shippedResolution, version: "1.1.0" });
    await service.publishChange({ version: "1.1.0", type: "added", summary: "Owner filter.", changeRequestIds: [a.requestId] });
    expect((await service.changes("user_a", { sinceVersion: "1.0.0" })).changes[0]!.changeRequestIds).toEqual([a.requestId]);
  });
});
