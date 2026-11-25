/**
 * Re-runs an acceptance test against the server, under the client's own
 * authorization (SEP section 11), and checks the expected result.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { AcceptanceTest } from "./types.js";

export interface TestRun {
  outcome: "pass" | "fail";
  /** Why a test failed, for the confirmation note. Never includes result content. */
  reasons: string[];
}

interface ContentLike {
  type?: string;
  text?: string;
  resource?: { text?: string };
  content?: { type?: string; text?: string };
}

function textOf(items: ContentLike[] | undefined): string {
  return (items ?? [])
    .map((c) => c.text ?? c.resource?.text ?? c.content?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

const validator = new AjvJsonSchemaValidator();

export async function runAcceptanceTest(client: Client, test: AcceptanceTest): Promise<TestRun> {
  const reasons: string[] = [];
  let isError = false;
  let text = "";
  let structured: unknown;

  try {
    const params = (test.call.params ?? {}) as Record<string, unknown>;
    if (test.call.method === "tools/call") {
      const result = (await client.callTool(params as { name: string; arguments?: Record<string, unknown> })) as {
        isError?: boolean;
        content?: ContentLike[];
        structuredContent?: unknown;
      };
      isError = result.isError === true;
      text = textOf(result.content);
      structured = result.structuredContent;
    } else if (test.call.method === "resources/read") {
      const result = await client.readResource(params as { uri: string });
      text = textOf(result.contents as ContentLike[]);
    } else {
      const result = await client.getPrompt(params as { name: string; arguments?: Record<string, string> });
      text = textOf(result.messages.map((m) => m.content as ContentLike));
    }
  } catch {
    // A protocol error counts as an error result.
    isError = true;
  }

  const expect = test.expect ?? {};
  const wantError = expect.isError ?? false;
  if (isError !== wantError) reasons.push(wantError ? "expected an error, got a result" : "the call returned an error");
  for (const needle of expect.textContains ?? []) {
    if (!text.includes(needle)) reasons.push("the text did not contain an expected string");
  }
  if (expect.structuredContentSchema) {
    if (structured === undefined) {
      reasons.push("no structured result");
    } else {
      const check = validator.getValidator(expect.structuredContentSchema as never)(structured);
      if (!check.valid) reasons.push("the structured result did not match the expected schema");
    }
  }
  return { outcome: reasons.length === 0 ? "pass" : "fail", reasons };
}
