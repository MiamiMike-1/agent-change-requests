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

export type TargetType = "tool" | "resource" | "prompt" | "server" | "extension";

export interface Target {
  type: TargetType;
  /** The tool, resource, or prompt name, or for type extension the extension identifier. */
  name?: string;
  /**
   * For type extension only: which part of the extension, as its maintainers name them.
   * For this extension: spec, server-sdk, or client-sdk.
   */
  component?: string;
}

/** Where a request was relayed to, for one about an extension (see UpstreamRelay). */
export interface UpstreamLink {
  /** The sink's own reference, for example "owner/repo#12". */
  ref: string;
  /** A public link to the forwarded copy, when there is one. */
  url?: string;
  forwardedAt: string;
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
  /** What submit first returned, so a repeated idempotency key gets the same answer. */
  firstResult: SubmitResult;
  /** Set once the request was relayed to an extension's maintainers. */
  upstream?: UpstreamLink;
  /** True when the request came from a caller with no authenticated principal. */
  anonymous?: boolean;
  /** Anonymous requests only: the ticket that reads this one request. A credential. */
  ticket?: string;
  /** Bumped on every write. Stores use it to refuse a write based on a stale read. */
  revision: number;
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
  /** Only for anonymous callers: the bearer credential for changeRequests/get on this one request. */
  ticket?: string;
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

// ---- What's new (SEP section 12) --------------------------------------------

export const CHANGE_TYPES = ["added", "changed", "deprecated", "removed", "fixed"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** One entry of the changes feed, as callers see it (SEP section 12). */
export interface ChangeEntry {
  version: string;
  publishedAt: string;
  type: ChangeType;
  breaking: boolean;
  summary: string;
  changed?: Target[];
  changelogUri?: string;
  /** For deprecated entries: the earliest date the server may remove the target. */
  removeAfter?: string;
  /** The caller's own requests this change resolved. Never another principal's. */
  changeRequestIds?: string[];
}

/** The stored entry. Only the server sees all of it. */
export interface ChangeRecord extends Omit<ChangeEntry, "changeRequestIds"> {
  changeId: string;
  /** Increases with every published entry. Orders the feed and marks what a reader has seen. */
  seq: number;
  /** all: every caller sees it. requester: only the principals listed in releasedTo. */
  availability: "all" | "requester";
  releasedTo?: string[];
  /** The requests this change resolved, with the principal that owns each. */
  resolves?: { requestId: string; principal: string }[];
}

/** How far one principal has read the feed, and whether it wants the notice. */
export interface FeedReader {
  principal: string;
  /** The highest seq this principal has read. */
  seenSeq: number;
  /** True when the principal turned the changes notice off. */
  muted: boolean;
}

export interface ChangesQuery {
  sinceVersion?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

export interface ChangesPage {
  currentVersion: string;
  changes: ChangeEntry[];
  nextCursor?: string;
}
