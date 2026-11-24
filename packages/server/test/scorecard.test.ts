import { describe, expect, it } from "vitest";
import { computeScorecard } from "../src/scorecard.js";
import { sampleRecord } from "../src/testing/conformance.js";

// Two of Tasker's real ledger rows, so the math matches the scorecard it already publishes.
const repeats = sampleRecord({
  requestId: "crq_seed_04",
  title: "Repeats and alarms through MCP",
  kind: "feature_request",
  status: "shipped",
  version: "1.2.0",
  pickedUp: true,
  stages: {
    requested: "2026-11-18T15:39:00+00:00",
    approved: "2026-11-18T16:12:00+00:00",
    built: "2026-11-19T04:06:57+00:00",
    merged: "2026-11-19T11:55:31+00:00",
    published: "2026-11-19T11:58:00+00:00",
    live: "2026-11-19T11:58:00+00:00",
    adopted: "2026-11-21T17:00:00+00:00",
  },
  approximate: ["approved", "adopted"],
  createdAt: "2026-11-18T15:39:00+00:00",
});

const refresh = sampleRecord({
  requestId: "crq_seed_08",
  idempotencyKey: "k8",
  title: "App refreshes after MCP writes",
  kind: "bug",
  origin: "principal",
  status: "shipped",
  version: "1.2.1",
  pickedUp: true,
  stages: {
    requested: "2026-11-21T09:55:00+00:00",
    approved: "2026-11-21T09:58:00+00:00",
    built: "2026-11-21T10:05:33+00:00",
    merged: "2026-11-21T10:55:01+00:00",
    published: "2026-11-21T11:06:13+00:00",
    live: "2026-11-21T11:06:13+00:00",
  },
  confirmations: [{ outcome: "fail", confirmedAt: "2026-11-21T12:00:00+00:00" }],
  createdAt: "2026-11-21T09:55:00+00:00",
});

const open = sampleRecord({
  requestId: "crq_open",
  idempotencyKey: "k9",
  about: "spec",
  stages: { requested: "2026-11-23T14:41:35+00:00" },
  createdAt: "2026-11-23T14:41:35+00:00",
});

describe("computeScorecard", () => {
  const card = computeScorecard([refresh, open, repeats], [], { timeZone: "America/New_York" });

  it("matches Tasker's hours for the same rows", () => {
    const [first, second] = card.ledger;
    expect(first?.requestId).toBe("crq_seed_04");
    expect(first?.hoursToLive).toBeCloseTo(20.3167, 3);
    expect(first?.buildHours).toBeCloseTo(11.9158, 3);
    expect(first?.humanHours).toBeCloseTo(8.4008, 3);
    expect(second?.hoursToLive).toBeCloseTo(1.1869, 3);
    expect(second?.humanHours).toBeCloseTo(1.0611, 3);
  });

  it("counts confirmations, adoption, failures, and spec requests", () => {
    const n = card.numbers;
    expect(n.requests).toMatchObject({ total: 3, byOrigin: { agent: 2, principal: 1 }, byAbout: { app: 2, spec: 1 } });
    expect(n.live).toEqual({ shipped: 2, of: 3 });
    expect(n.confirmedFixed).toEqual({ pass: 0, fail: 1, unconfirmed: 1, of: 2 });
    expect(n.adopted).toEqual({ count: 1, of: 2 });
    expect(n.contractFailures).toBe(1);
    expect(n.medianHoursToLive).toBe(10.8);
  });

  it("renders a markdown ledger in the chosen time zone", () => {
    expect(card.markdown).toContain("| 1 | Repeats and alarms through MCP | feature_request, agent | shipped 1.2.0 | Nov 18 | Nov 18~ |");
    expect(card.markdown).toContain("- About the spec: 1");
    expect(card.markdown).toContain("Dates are in America/New_York");
  });

  it("counts gaps by week and how many led to a request within 30 minutes", () => {
    const withGaps = computeScorecard(
      [open],
      [
        { principal: "user_a", target: "list_things", reason: "empty_result", at: "2026-11-23T14:20:00+00:00" },
        { principal: "user_a", target: "list_things", reason: "validation_error", at: "2026-11-23T10:00:00+00:00" },
      ],
    );
    expect(withGaps.numbers.gaps).toEqual({
      total: 2,
      byWeek: { "2026-11-23": { empty_result: 1, validation_error: 1 } },
      followedByRequestWithin30Min: 1,
    });
  });
});
