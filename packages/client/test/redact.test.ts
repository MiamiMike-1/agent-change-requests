import { describe, expect, it } from "vitest";
import { Redactor, redactSubmission } from "../src/redact.js";

describe("redaction", () => {
  const r = new Redactor({ sensitiveValues: ["Acme Corp", "prod_billing"], foreignNames: ["send_slack_message"] });
  const clean = (s: string) => r.text(s);

  it.each([
    ["key sk-live_abcdefghijklmnop1234 used", "key <secret> used"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123", "token <secret>"],
    ["Authorization: Bearer abc.def.ghi-123456", "Authorization: Bearer <token>"],
    ["password=hunter22 then", "password=<secret> then"],
    ["write to jane.doe@example.com", "write to <email>"],
    ["call (305) 555-0100 now", "call <phone> now"],
    ["host 10.0.12.7 refused", "host <ip> refused"],
    ["read /Users/jane/projects/acme/.env", "read <path>"],
    ["saved in ~/Documents/report.pdf", "saved in <path>"],
    ["C:\\Users\\jane\\notes.txt was empty", "<path> was empty"],
    ["postgres://admin:s3cret@db.internal:5432/x", "postgres://<credentials>@db.internal:5432/x"],
    ["for Acme Corp in prod_billing", "for <redacted> in <redacted>"],
    ["then I called send_slack_message", "then I called <other-server>"],
  ])("%s", (input, output) => {
    expect(clean(input)).toBe(output);
  });

  it("leaves ordinary tool talk alone", () => {
    const text = "list_invoices via tools/call returned 4,200 rows on 2026-11-25 for cus_123; changeRequests/submit worked.";
    expect(clean(text)).toBe(text);
  });

  it("redacts every field of a submission but the fixed ones, and reports paths only", () => {
    const { params, findings } = redactSubmission(
      {
        kind: "bug",
        title: "Fails for jane@example.com",
        description: "See /var/log/app/error.log",
        idempotencyKey: "abc",
        target: { type: "tool", name: "list_invoices" },
        context: { attempts: [{ arguments: { email: "bob@example.com" }, outcome: "error" }] },
        acceptanceTests: [{ call: { method: "tools/call", params: { name: "find", arguments: { q: "bob@example.com" } } } }],
      },
      {},
    );
    expect(params.title).toBe("Fails for <email>");
    expect(params.description).toBe("See <path>");
    expect(params.idempotencyKey).toBe("abc");
    expect((params.context as any).attempts[0].arguments.email).toBe("<email>");
    expect((params.acceptanceTests as any)[0].call).toEqual({ method: "tools/call", params: { name: "find", arguments: { q: "<email>" } } });
    expect(findings.map((f) => f.path)).toEqual([
      "title",
      "description",
      "context.attempts[0].arguments.email",
      "acceptanceTests[0].call.params.arguments.q",
    ]);
    expect(JSON.stringify(findings)).not.toContain("example.com");
  });
});
