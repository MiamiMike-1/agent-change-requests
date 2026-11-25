import { ChangeRequestError } from "./errors.js";
import { CHANGE_TYPES, type AcceptanceTest, type Kind, type SubmitInput } from "./types.js";

export const LIMITS = {
  title: 120,
  description: 4000,
  cause: 500,
  attempts: 5,
  acceptanceTests: 10,
  textContains: 5,
  note: 1000,
  message: 1000,
  summary: 500,
} as const;

const TARGET_TYPES = ["tool", "resource", "prompt", "server"];
const TEST_METHODS = ["tools/call", "resources/read", "prompts/get"];
const FREQUENCIES = ["once", "recurring"];
const SEVERITIES = ["low", "medium", "high"];
const DETECTABILITIES = ["immediate", "eventual", "hidden"];

function fail(message: string): never {
  throw new ChangeRequestError("invalid_params", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} is required.`);
  if (value.length > max) fail(`${field} must be at most ${max} characters.`);
  return value;
}

function optionalString(value: unknown, field: string, max?: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") fail(`${field} must be a string.`);
  if (max !== undefined && value.length > max) fail(`${field} must be at most ${max} characters.`);
}

function optionalEnum(value: unknown, field: string, allowed: readonly string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(`${field} must be one of ${allowed.join(", ")}.`);
  }
}

function validateTest(test: unknown, index: number): void {
  const at = `acceptanceTests[${index}]`;
  if (!isObject(test)) fail(`${at} must be an object.`);
  optionalString(test.description, `${at}.description`);
  if (!isObject(test.call)) fail(`${at}.call is required.`);
  if (typeof test.call.method !== "string" || !TEST_METHODS.includes(test.call.method)) {
    fail(`${at}.call.method must be one of ${TEST_METHODS.join(", ")}.`);
  }
  if (test.call.params !== undefined && !isObject(test.call.params)) fail(`${at}.call.params must be an object.`);
  if (test.expect === undefined) return;
  if (!isObject(test.expect)) fail(`${at}.expect must be an object.`);
  const expect = test.expect;
  if (expect.isError !== undefined && typeof expect.isError !== "boolean") fail(`${at}.expect.isError must be a boolean.`);
  if (expect.structuredContentSchema !== undefined && !isObject(expect.structuredContentSchema)) {
    fail(`${at}.expect.structuredContentSchema must be an object.`);
  }
  if (expect.textContains !== undefined) {
    if (!Array.isArray(expect.textContains) || expect.textContains.some((s) => typeof s !== "string")) {
      fail(`${at}.expect.textContains must be an array of strings.`);
    }
    if (expect.textContains.length > LIMITS.textContains) {
      fail(`${at}.expect.textContains holds at most ${LIMITS.textContains} strings.`);
    }
  }
}

export interface ValidateOptions {
  kinds: readonly Kind[];
  acceptanceTests: boolean;
}

/**
 * Checks a submission against SEP section 3. Throws ChangeRequestError on the first problem.
 * An unrecognized failureMode is accepted and stored unchanged, as the spec requires.
 */
export function validateSubmit(input: unknown, options: ValidateOptions): SubmitInput {
  if (!isObject(input)) fail("The request must be an object.");

  if (typeof input.kind !== "string" || !(options.kinds as readonly string[]).includes(input.kind)) {
    throw new ChangeRequestError(
      "kind_unsupported",
      `kind must be one of ${options.kinds.join(", ")}.`,
    );
  }
  requireString(input.title, "title", LIMITS.title);
  requireString(input.description, "description", LIMITS.description);
  requireString(input.idempotencyKey, "idempotencyKey", 200);

  if (input.target !== undefined) {
    if (!isObject(input.target)) fail("target must be an object.");
    optionalEnum(input.target.type, "target.type", TARGET_TYPES);
    if (input.target.type === undefined) fail("target.type is required.");
    if (input.target.type !== "server") requireString(input.target.name, "target.name", 200);
    else optionalString(input.target.name, "target.name", 200);
  }

  if (input.context !== undefined) {
    if (!isObject(input.context)) fail("context must be an object.");
    optionalString(input.context.goal, "context.goal", LIMITS.description);
    optionalString(input.context.workaround, "context.workaround", LIMITS.description);
    optionalString(input.context.cause, "context.cause", LIMITS.cause);
    if (input.context.attempts !== undefined) {
      if (!Array.isArray(input.context.attempts)) fail("context.attempts must be an array.");
      if (input.context.attempts.length > LIMITS.attempts) fail(`context.attempts holds at most ${LIMITS.attempts} calls.`);
      if (input.context.attempts.some((a) => !isObject(a))) fail("Each of context.attempts must be an object.");
    }
  }

  optionalString(input.failureMode, "failureMode", 200);

  if (input.impact !== undefined) {
    if (!isObject(input.impact)) fail("impact must be an object.");
    if (input.impact.blocked !== undefined && typeof input.impact.blocked !== "boolean") fail("impact.blocked must be a boolean.");
    optionalEnum(input.impact.frequency, "impact.frequency", FREQUENCIES);
    optionalEnum(input.impact.severity, "impact.severity", SEVERITIES);
    optionalEnum(input.impact.detectability, "impact.detectability", DETECTABILITIES);
  }

  if (input.acceptanceTests !== undefined) {
    if (!options.acceptanceTests) {
      throw new ChangeRequestError("tests_unsupported", "This server does not accept acceptance tests.");
    }
    if (!Array.isArray(input.acceptanceTests)) fail("acceptanceTests must be an array.");
    if (input.acceptanceTests.length > LIMITS.acceptanceTests) {
      fail(`acceptanceTests holds at most ${LIMITS.acceptanceTests} tests.`);
    }
    input.acceptanceTests.forEach(validateTest);
  }

  optionalEnum(input.origin, "origin", ["agent", "principal"]);
  optionalEnum(input.about, "about", ["app", "spec"]);

  return input as unknown as SubmitInput;
}

export function validateConfirmTests(tests: unknown, submitted: AcceptanceTest[] | undefined): void {
  if (tests === undefined) return;
  if (!Array.isArray(tests)) fail("tests must be an array.");
  const count = submitted?.length ?? 0;
  for (const t of tests) {
    if (!isObject(t) || typeof t.index !== "number" || !Number.isInteger(t.index)) fail("Each test needs an integer index.");
    if (t.index < 0 || t.index >= count) fail(`Test index ${t.index} does not match a submitted acceptance test.`);
    if (t.outcome !== "pass" && t.outcome !== "fail") fail("Each test outcome must be pass or fail.");
  }
}

/** Checks an entry for the changes feed against SEP section 12. */
export function validateChange(input: unknown): void {
  if (!isObject(input)) fail("The change must be an object.");
  requireString(input.version, "version", 100);
  if (typeof input.type !== "string" || !(CHANGE_TYPES as readonly string[]).includes(input.type)) {
    fail(`type must be one of ${CHANGE_TYPES.join(", ")}.`);
  }
  requireString(input.summary, "summary", LIMITS.summary);
  if (input.breaking !== undefined && typeof input.breaking !== "boolean") fail("breaking must be a boolean.");
  if (input.type === "removed" && input.breaking === false) fail("A removed entry is always breaking.");
  if (input.changed !== undefined) {
    if (!Array.isArray(input.changed)) fail("changed must be an array.");
    for (const t of input.changed) {
      if (!isObject(t) || typeof t.type !== "string" || !TARGET_TYPES.includes(t.type)) {
        fail(`Each of changed needs a type: ${TARGET_TYPES.join(", ")}.`);
      }
      if (t.type !== "server") requireString(t.name, "changed[].name", 200);
    }
  }
  optionalString(input.changelogUri, "changelogUri", 2000);
  if (input.removeAfter !== undefined) {
    if (typeof input.removeAfter !== "string" || Number.isNaN(Date.parse(input.removeAfter))) {
      fail("removeAfter must be a date such as 2027-02-01.");
    }
  }
  if (input.publishedAt !== undefined && (typeof input.publishedAt !== "string" || Number.isNaN(Date.parse(input.publishedAt)))) {
    fail("publishedAt must be an ISO 8601 time.");
  }
  optionalEnum(input.availability, "availability", ["all", "requester"]);
  for (const field of ["releasedTo", "changeRequestIds"] as const) {
    const value = input[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === ""))) {
      fail(`${field} must be an array of strings.`);
    }
  }
}
