/**
 * Types for the Agent Change Requests extension.
 * Field names and limits follow SEP-0000 in the root of this repository.
 */

export const KINDS = ["bug", "friction", "missing_capability", "feature_request"] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = [
  "received",
  "needs_info",
  "triaged",
  "planned",
  "building",
  "shipped",
  "declined",
  "duplicate",
  "withdrawn",
] as const;
export type Status = (typeof STATUSES)[number];

export const TERMINAL_STATUSES: readonly Status[] = ["shipped", "declined", "duplicate", "withdrawn"];

export const BASE_FAILURE_MODES = [
  "capability_missing",
  "interface_cost",
  "data_gap",
  "discoverability",
  "scope_not_honored",
  "silent_failure",
] as const;

/** Who asked for the change: the agent found the gap itself, or its user asked for it. */
export type Origin = "agent" | "principal";

/**
 * What the request is about. "app" is the server's own tools and data.
 * "spec" is the change request tools or the Agent Change Requests standard itself,
 * so lessons about the standard can be gathered across every app that uses it.
 */
export type About = "app" | "spec";

export type TargetType = "tool" | "resource" | "prompt" | "server";

export interface Target {
  type: TargetType;
  name?: string;
}

export interface Attempt {
  [key: string]: unknown;
}

export interface RequestContext {
  goal?: string;
  workaround?: string;
  /** The requester's hypothesis about why the gap exists. Never a finding. */
  cause?: string;
  attempts?: Attempt[];
}

export interface Impact {
  blocked?: boolean;
  frequency?: "once" | "recurring";
  severity?: "low" | "medium" | "high";
  detectability?: "immediate" | "eventual" | "hidden";
}

export type TestMethod = "tools/call" | "resources/read" | "prompts/get";

export interface AcceptanceTest {
  description?: string;
  call: { method: TestMethod; params?: Record<string, unknown> };
  expect?: {
    isError?: boolean;
    structuredContentSchema?: Record<string, unknown>;
    textContains?: string[];
  };
}

export interface SubmitInput {
  kind: Kind;
  title: string;
  description: string;
  target?: Target;
  context?: RequestContext;
  failureMode?: string;
  impact?: Impact;
  acceptanceTests?: AcceptanceTest[];
  idempotencyKey: string;
  origin?: Origin;
  about?: About;
}

export type TestOutcome = "pass" | "fail" | "not_evaluated";

export interface Resolution {
  availability: "requester" | "all";
  changed?: Target[];
  changelogUri?: string;
  workaroundObsolete?: boolean;
  tests?: { index: number; outcome: TestOutcome }[];
}

export interface Confirmation {
  outcome: "pass" | "fail";
  tests?: { index: number; outcome: "pass" | "fail" }[];
  note?: string;
  adopted?: boolean;
  confirmedAt: string;
}

/** The stages the scorecard times. All are ISO 8601 strings. */
export const STAGES = [
  "requested",
  "approved",
  "built",
  "merged",
  "published",
  "live",
  "confirmed",
  "adopted",
] as const;
export type Stage = (typeof STAGES)[number];
export type Stages = { requested: string } & Partial<Record<Exclude<Stage, "requested">, string>>;

/** The stored record. Only the server and its builder see all of it. */
export interface ChangeRequestRecord {
  requestId: string;
  principal: string;
  idempotencyKey: string;
  kind: Kind;
  title: string;
  description: string;
  target?: Target;
  context?: RequestContext;
  failureMode?: string;
  impact?: Impact;
  acceptanceTests?: AcceptanceTest[];
  origin: Origin;
  about: About;
  status: Status;
  message?: string;
  resolution?: Resolution;
  duplicateOf?: string;
  /** Distinct principals counted toward demand, the submitter first. Never returned to callers. */
  demandFrom: string[];
  /** The server version the change went live in, when shipped. */
  version?: string;
  confirmations: Confirmation[];
  stages: Stages;
  /** Stages whose times were recovered after the fact. */
  approximate: Stage[];
  /** True while a status change has not been read by the submitter. */
  unread: boolean;
  /** True once the submitter has read the request after it shipped. */
  pickedUp: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What callers get back from get and list (SEP section 6, plus a few additions). */
export interface StatusObject {
  requestId: string;
  title: string;
  kind: Kind;
  status: Status;
  origin: Origin;
  about: About;
  updatedAt: string;
  demand: number;
  message?: string;
  resolution?: Resolution;
  duplicateOf?: string;
  version?: string;
  confirmation?: { outcome: "pass" | "fail"; confirmedAt: string; adopted?: boolean };
}

export interface SubmitResult {
  requestId: string;
  status: Status;
  duplicateOf: string | null;
  demand: number;
}

export interface Gap {
  principal: string;
  /** The tool, resource, or prompt where the requester hit a gap. */
  target: string;
  /** For example validation_error or empty_result. */
  reason: string;
  at: string;
}

export interface ListQuery {
  status?: Status[];
  updatedSince?: string;
  about?: About;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** A status change, for apps that want to notify someone or push an event. */
export interface ChangeEvent {
  type: "submitted" | "status_changed" | "stage_recorded" | "confirmed" | "withdrawn";
  requestId: string;
  principal: string;
  status: Status;
  stage?: Stage;
  at: string;
}
