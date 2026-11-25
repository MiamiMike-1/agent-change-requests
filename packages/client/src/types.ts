/** Wire types from SEP-0000, as a client sees them. */

export type Kind = "bug" | "friction" | "missing_capability" | "feature_request";

export type Status =
  | "received"
  | "needs_info"
  | "triaged"
  | "planned"
  | "building"
  | "shipped"
  | "declined"
  | "duplicate"
  | "withdrawn";

export const TERMINAL_STATUSES: readonly Status[] = ["shipped", "declined", "duplicate", "withdrawn"];

export interface Target {
  type: "tool" | "resource" | "prompt" | "server" | "extension";
  /** The tool, resource, or prompt name, or for type extension the extension identifier. */
  name?: string;
  /** For type extension only: spec, server-sdk, or client-sdk for this extension. */
  component?: string;
}

export interface AcceptanceTest {
  description?: string;
  call: { method: "tools/call" | "resources/read" | "prompts/get"; params?: Record<string, unknown> };
  expect?: {
    isError?: boolean;
    structuredContentSchema?: Record<string, unknown>;
    textContains?: string[];
  };
}

/** changeRequests/submit params. idempotencyKey is optional here: the client makes one. */
export interface SubmitParams {
  kind: Kind;
  title: string;
  description: string;
  target?: Target;
  context?: {
    goal?: string;
    workaround?: string;
    cause?: string;
    attempts?: Record<string, unknown>[];
  };
  failureMode?: string;
  impact?: {
    blocked?: boolean;
    frequency?: "once" | "recurring";
    severity?: "low" | "medium" | "high";
    detectability?: "immediate" | "eventual" | "hidden";
  };
  acceptanceTests?: AcceptanceTest[];
  idempotencyKey?: string;
  [key: string]: unknown;
}

export interface SubmitResult {
  requestId: string;
  status: Status;
  duplicateOf: string | null;
  demand: number;
  ticket?: string;
}

export interface Resolution {
  availability: "requester" | "all";
  changed?: Target[];
  changelogUri?: string;
  workaroundObsolete?: boolean;
  tests?: { index: number; outcome: "pass" | "fail" | "not_evaluated" }[];
}

export interface StatusObject {
  requestId: string;
  status: Status;
  updatedAt: string;
  demand: number;
  title?: string;
  message?: string;
  resolution?: Resolution;
  duplicateOf?: string;
  version?: string;
  confirmation?: { outcome: "pass" | "fail"; confirmedAt: string };
  [key: string]: unknown;
}

/** The server settings object from SEP section 1. */
export interface ServerSettings {
  kinds: Kind[];
  acceptanceTests?: boolean;
  events?: boolean;
  anonymous?: boolean;
  policyUri?: string;
  changelogUri?: string;
  changes?: boolean;
}

export interface ConfirmParams {
  requestId: string;
  outcome: "pass" | "fail";
  tests?: { index: number; outcome: "pass" | "fail" }[];
  note?: string;
  [key: string]: unknown;
}

/** One entry of the changes feed (SEP section 12). */
export interface ChangeEntry {
  version: string;
  publishedAt: string;
  type: "added" | "changed" | "deprecated" | "removed" | "fixed";
  breaking: boolean;
  summary: string;
  changed?: Target[];
  changelogUri?: string;
  removeAfter?: string;
  /** The caller's own requests this change resolved. */
  changeRequestIds?: string[];
  [key: string]: unknown;
}

/** changeRequests/changes params. Pass sinceVersion or since, not both. */
export interface ChangesQuery {
  sinceVersion?: string;
  since?: string;
  cursor?: string;
  limit?: number;
}

/** changeRequests/changes result. */
export interface ChangesPage {
  currentVersion: string;
  changes: ChangeEntry[];
  nextCursor?: string;
}
