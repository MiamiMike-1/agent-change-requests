import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDemo } from "../src/run.js";

it("runs the loop end to end, from the gap to a confirmed shipped change", async () => {
  const result = await runDemo(mkdtempSync(join(tmpdir(), "acr-demo-")));
  expect(result).toMatchObject({ callsWithWorkaround: 5, callsAfterFix: 1, testBeforeFix: "fail", confirmation: "pass" });
  expect(result.transcript).toContain("Note from Invoices: 1 of your change requests has an update.");
  expect(result.transcript).toContain("Totalling one customer's unpaid invoices for <redacted>");
  expect(result.transcript).not.toMatch(/receives[^\n]*Acme Corp/);
  expect(result.changesSeen).toEqual([{ version: "1.1.0", type: "added", changeRequestIds: [result.requestId] }]);
});
