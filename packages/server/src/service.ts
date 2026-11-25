import { randomBytes } from "node:crypto";
import { ChangeRequestError } from "./errors.js";
import { canTransition, isTerminal } from "./lifecycle.js";
import { computeScorecard, type Scorecard, type ScorecardOptions } from "./scorecard.js";
import type { ChangeRequestStore } from "./store.js";
import { LIMITS, validateConfirmTests, validateSubmit } from "./validate.js";
import {
  KINDS,
  type About,
  type ChangeEvent,
  type ChangeRequestRecord,
  type Kind,
  type ListQuery,
  type Page,
  type Resolution,
  type Stage,
  type Status,
  type StatusObject,
  type SubmitResult,
} from "./types.js";

/** The tool names this package registers. A request that targets one is about the spec. */
export const EXTENSION_TOOL_NAMES = [
  "change_requests_submit",
  "change_requests_list",
  "change_requests_get",
  "change_requests_withdraw",
  "change_requests_confirm",
  "change_requests_scorecard",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ServiceOptions {
  store: ChangeRequestStore;
  /** Kinds this server accepts. Default: all four. */
  kinds?: readonly Kind[];
  /** Whether the server stores acceptance tests. Default true. */
  acceptanceTests?: boolean;
  /** Most requests one principal may submit in 24 hours. Default 20. 0 turns the cap off. */
  dailyCap?: number;
  /**
   * Return true for a principal that the server knows is shared by unrelated users
   * (for example one API key used by many agents). Such a principal gets no update
   * notice and no inbox, as SEP section 7 requires.
   */
  isSharedCredential?: (principal: string) => boolean;
  /** Called after every change, for notifications or MCP Events. Errors are swallowed. */
  onEvent?: (event: ChangeEvent) => void | Promise<void>;
  /** Extra target names that mark a request as about the spec. */
  specTargets?: readonly string[];
  /** Clock and id hooks, for tests. */
  now?: () => Date;
  newId?: () => string;
}

export interface TransitionInput {
  status: Status;
  message?: string;
  resolution?: Resolution;
  duplicateOf?: string;
  /** Server version the change is live in. Recommended when shipping. */
  version?: string;
  /** When the change happened, if not now. */
  at?: string;
}

export interface ConfirmInput {
  requestId: string;
  outcome: "pass" | "fail";
  tests?: { index: number; outcome: "pass" | "fail" }[];
  note?: string;
  adopted?: boolean;
}

function defaultId(): string {
  return `crq_${randomBytes(8).toString("hex")}`;
}

/**
 * The extension's server side, independent of transport. The MCP adapter in "./mcp"
 * calls the caller-facing methods. The builder side (triage, CI, release scripts)
 * calls transition and recordStage.
 */
export class ChangeRequestService {
  readonly kinds: readonly Kind[];
  readonly acceptanceTests: boolean;
  private readonly store: ChangeRequestStore;
  private readonly dailyCap: number;
  private readonly isShared: (principal: string) => boolean;
  private readonly onEvent?: (event: ChangeEvent) => void | Promise<void>;
  private readonly listeners = new Set<(event: ChangeEvent) => void | Promise<void>>();
  private readonly specTargets: Set<string>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.kinds = options.kinds ?? KINDS;
    if (this.kinds.length === 0) throw new Error("A server must accept at least one kind.");
    this.acceptanceTests = options.acceptanceTests ?? true;
    this.dailyCap = options.dailyCap ?? 20;
    this.isShared = options.isSharedCredential ?? (() => false);
    if (options.onEvent) this.onEvent = options.onEvent;
    this.specTargets = new Set([...EXTENSION_TOOL_NAMES, ...(options.specTargets ?? [])]);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  // ---- Caller side -------------------------------------------------------

  async submit(principal: string | null | undefined, input: unknown): Promise<SubmitResult> {
    const who = this.requirePrincipal(principal);
    const params = validateSubmit(input, { kinds: this.kinds, acceptanceTests: this.acceptanceTests });

    const existing = await this.store.findByIdempotencyKey(who, params.idempotencyKey);
    if (existing) return { ...existing.firstResult };

    const now = this.now();
    if (this.dailyCap > 0) {
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      const count = await this.store.countSubmittedSince(who, since);
      if (count >= this.dailyCap) {
        const oldest = await this.store.oldestSubmittedSince(who, since);
        const retryAfterMs = oldest ? Math.max(Date.parse(oldest) + DAY_MS - now.getTime(), 0) : DAY_MS;
        throw new ChangeRequestError(
          "rate_limited",
          `At most ${this.dailyCap} change requests a day. Try again later.`,
          { retryAfterMs },
        );
      }
    }

    const at = now.toISOString();
    const requestId = this.newId();
    const record: ChangeRequestRecord = {
      requestId,
      principal: who,
      idempotencyKey: params.idempotencyKey,
      kind: params.kind,
      title: params.title,
      description: params.description,
      origin: params.origin ?? "agent",
      about: params.about ?? this.inferAbout(params.target?.name),
      status: "received",
      demandFrom: [who],
      confirmations: [],
      stages: { requested: at },
      approximate: [],
      unread: false,
      pickedUp: false,
      firstResult: { requestId, status: "received", duplicateOf: null, demand: 1 },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (params.target) record.target = params.target;
    if (params.context) record.context = params.context;
    if (params.failureMode !== undefined) record.failureMode = params.failureMode;
    if (params.impact) record.impact = params.impact;
    if (params.acceptanceTests) record.acceptanceTests = params.acceptanceTests;

    try {
      await this.store.insert(record);
    } catch (error) {
      // A concurrent submit with the same key won the race: return its answer.
      const raced = await this.store.findByIdempotencyKey(who, params.idempotencyKey);
      if (raced) return { ...raced.firstResult };
      throw error;
    }
    await this.emit({ type: "submitted", requestId, principal: who, status: "received", at });
    return { ...record.firstResult };
  }

  /** Reads one of the caller's own requests and clears its update. */
  async get(principal: string | null | undefined, requestId: string): Promise<StatusObject> {
    const who = this.requireInbox(principal);
    const record = await this.ownRecord(who, requestId);
    await this.markSeen([record]);
    return this.toStatus(record);
  }

  /** The caller's inbox. Reading a page clears the updates of the requests on it. */
  async list(principal: string | null | undefined, query: ListQuery = {}): Promise<Page<StatusObject>> {
    const who = this.requireInbox(principal);
    const page = await this.store.list(who, query);
    await this.markSeen(page.items);
    const result: Page<StatusObject> = { items: page.items.map((r) => this.toStatus(r)) };
    if (page.nextCursor) result.nextCursor = page.nextCursor;
    return result;
  }

  async withdraw(principal: string | null | undefined, requestId: string): Promise<StatusObject> {
    const who = this.requireInbox(principal);
    const at = this.now().toISOString();
    const record = await this.mutate(requestId, (r) => {
      this.assertOwner(who, r);
      if (isTerminal(r.status)) {
        throw new ChangeRequestError("terminal_status", `This request is already ${r.status}.`);
      }
      r.status = "withdrawn";
      r.updatedAt = at;
      r.unread = false;
    });
    await this.emit({ type: "withdrawn", requestId, principal: who, status: "withdrawn", at });
    return this.toStatus(record);
  }

  async confirm(principal: string | null | undefined, input: ConfirmInput): Promise<StatusObject> {
    const who = this.requireInbox(principal);
    if (input.outcome !== "pass" && input.outcome !== "fail") {
      throw new ChangeRequestError("invalid_params", "outcome must be pass or fail.");
    }
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > LIMITS.note)) {
      throw new ChangeRequestError("invalid_params", `note must be a string of at most ${LIMITS.note} characters.`);
    }
    if (input.adopted !== undefined && typeof input.adopted !== "boolean") {
      throw new ChangeRequestError("invalid_params", "adopted must be a boolean.");
    }

    const at = this.now().toISOString();
    const record = await this.mutate(input.requestId, (r) => {
      this.assertOwner(who, r);
      if (r.status !== "shipped") {
        throw new ChangeRequestError("not_shipped", "Only a shipped request can be confirmed.");
      }
      validateConfirmTests(input.tests, r.acceptanceTests);
      const confirmation: ChangeRequestRecord["confirmations"][number] = { outcome: input.outcome, confirmedAt: at };
      if (input.tests) confirmation.tests = input.tests;
      if (input.note !== undefined) confirmation.note = input.note;
      if (input.adopted !== undefined) confirmation.adopted = input.adopted;
      r.confirmations.push(confirmation);
      if (!r.stages.confirmed) r.stages.confirmed = at;
      if (input.adopted && !r.stages.adopted) r.stages.adopted = at;
      r.pickedUp = true;
      r.updatedAt = at;
    });
    await this.emit({ type: "confirmed", requestId: record.requestId, principal: who, status: record.status, at });
    return this.toStatus(record);
  }

  /** How many of this principal's requests have an unread update. 0 for a shared credential. */
  async pendingUpdates(principal: string | null | undefined): Promise<number> {
    if (!principal || this.isShared(principal)) return 0;
    return this.store.countUnread(principal);
  }

  /**
   * Logs that a caller hit a gap (for example a validation error or an empty result)
   * so the scorecard can show how often gaps lead to a request.
   */
  async recordGap(principal: string | null | undefined, target: string, reason: string): Promise<void> {
    if (!principal) return;
    await this.store.insertGap({ principal, target, reason, at: this.now().toISOString() });
  }

  /** The caller's own scorecard. Pass null for every principal (builder side). */
  async scorecard(principal: string | null | undefined, options: ScorecardOptions = {}): Promise<Scorecard> {
    if (principal !== null) this.requireInbox(principal);
    const who = principal ?? null;
    const records: ChangeRequestRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(who, cursor ? { cursor } : {});
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const gaps = await this.store.listGaps(who);
    return computeScorecard(records, gaps, options);
  }

  // ---- Builder side ------------------------------------------------------

  /**
   * Adds a listener for every change, alongside onEvent. The protocol middleware uses
   * it to publish status events. Returns a function that removes the listener.
   */
  subscribe(listener: (event: ChangeEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The status object (SEP section 6) of any request, for the builder side and for
   * status events. Unlike get, it checks no owner and does not clear the update.
   */
  async statusOf(requestId: string): Promise<StatusObject> {
    const record = typeof requestId === "string" ? await this.store.get(requestId) : null;
    if (!record) throw new ChangeRequestError("not_found", "No such request.");
    return this.toStatus(record);
  }

  /** Every principal's requests, for triage and the weekly roll-up. Does not clear updates. */
  async listAll(query: ListQuery = {}): Promise<Page<ChangeRequestRecord>> {
    return this.store.list(null, query);
  }

  /** Moves a request to a new status. The submitter sees an update the next time it calls in. */
  async transition(requestId: string, input: TransitionInput): Promise<ChangeRequestRecord> {
    if (input.message !== undefined && input.message.length > LIMITS.message) {
      throw new ChangeRequestError("invalid_params", `message must be at most ${LIMITS.message} characters.`);
    }
    if ((input.status === "declined" || input.status === "needs_info") && !input.message) {
      throw new ChangeRequestError("invalid_params", `A ${input.status} request needs a message.`);
    }
    if (input.status === "shipped" && !input.resolution) {
      throw new ChangeRequestError("invalid_params", "A shipped request needs a resolution.");
    }
    if (input.at !== undefined && Number.isNaN(Date.parse(input.at))) {
      throw new ChangeRequestError("invalid_params", "at must be an ISO 8601 time.");
    }

    // updatedAt is always the time of this write, so agents polling with updatedSince
    // see it. `at` only dates the stage, for the scorecard.
    const now = this.now().toISOString();
    const stageAt = input.at ?? now;

    let survivorId: string | undefined;
    if (input.status === "duplicate") {
      if (!input.duplicateOf || input.duplicateOf === requestId) {
        throw new ChangeRequestError("invalid_params", "A duplicate needs duplicateOf naming another request.");
      }
      survivorId = await this.resolveSurvivor(input.duplicateOf, requestId);
    }

    const record = await this.mutate(requestId, (r) => {
      if (isTerminal(r.status)) {
        throw new ChangeRequestError("terminal_status", `This request is already ${r.status}.`);
      }
      if (!canTransition(r.status, input.status)) {
        throw new ChangeRequestError("invalid_transition", `Cannot move from ${r.status} to ${input.status}.`);
      }
      r.status = input.status;
      if (input.message !== undefined) r.message = input.message;
      else delete r.message;
      if (input.resolution) r.resolution = input.resolution;
      if (input.version) r.version = input.version;
      if (survivorId) r.duplicateOf = survivorId;
      if (input.status === "shipped" && !r.stages.live) r.stages.live = stageAt;
      r.unread = true;
      r.updatedAt = now;
    });

    if (survivorId) {
      // Demand counts distinct principals, never submissions.
      await this.mutate(survivorId, (s) => {
        for (const p of record.demandFrom) if (!s.demandFrom.includes(p)) s.demandFrom.push(p);
      });
    }
    await this.emit({ type: "status_changed", requestId, principal: record.principal, status: record.status, at: now });
    return record;
  }

  /**
   * Records when a build stage happened, for the scorecard: approved (the owner said yes),
   * built (a pull request opened), merged, published, or live. Set approximate when the
   * time was recovered after the fact. Does not change status or raise an update.
   */
  async recordStage(
    requestId: string,
    stage: Exclude<Stage, "requested" | "confirmed" | "adopted">,
    at: string,
    options: { approximate?: boolean } = {},
  ): Promise<ChangeRequestRecord> {
    if (Number.isNaN(Date.parse(at))) throw new ChangeRequestError("invalid_params", "at must be an ISO 8601 time.");
    const record = await this.mutate(requestId, (r) => {
      r.stages[stage] = at;
      r.approximate = r.approximate.filter((s) => s !== stage);
      if (options.approximate) r.approximate.push(stage);
    });
    await this.emit({ type: "stage_recorded", requestId, principal: record.principal, status: record.status, stage, at });
    return record;
  }

  // ---- Helpers -----------------------------------------------------------

  private inferAbout(targetName: string | undefined): About {
    return targetName !== undefined && this.specTargets.has(targetName) ? "spec" : "app";
  }

  private requirePrincipal(principal: string | null | undefined): string {
    if (!principal) {
      throw new ChangeRequestError("unauthenticated", "Change requests need an authenticated caller.");
    }
    return principal;
  }

  private requireInbox(principal: string | null | undefined): string {
    const who = this.requirePrincipal(principal);
    if (this.isShared(who)) {
      throw new ChangeRequestError("shared_credential", "This credential is shared, so it has no inbox.");
    }
    return who;
  }

  /** Another principal's request reads as not found, so nothing about it leaks. */
  private assertOwner(principal: string, record: ChangeRequestRecord): void {
    if (record.principal !== principal) throw new ChangeRequestError("not_found", "No such request.");
  }

  private async ownRecord(principal: string, requestId: string): Promise<ChangeRequestRecord> {
    const record = typeof requestId === "string" ? await this.store.get(requestId) : null;
    if (!record) throw new ChangeRequestError("not_found", "No such request.");
    this.assertOwner(principal, record);
    return record;
  }

  /**
   * Reads a record, applies a change, and writes it back only if nobody wrote it in
   * between. On a conflict it reads again and reapplies, so no write is lost.
   */
  private async mutate(
    requestId: string,
    change: (record: ChangeRequestRecord) => void,
  ): Promise<ChangeRequestRecord> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const record = typeof requestId === "string" ? await this.store.get(requestId) : null;
      if (!record) throw new ChangeRequestError("not_found", "No such request.");
      const expected = record.revision;
      change(record);
      record.revision = expected + 1;
      if (await this.store.update(record, expected)) return record;
    }
    throw new Error("The request kept changing while it was being updated. Try again.");
  }

  /** Follows duplicateOf to the open (or shipped) request that will carry the demand. */
  private async resolveSurvivor(startId: string, requestId: string): Promise<string> {
    let id = startId;
    for (let hops = 0; hops < 10; hops += 1) {
      if (id === requestId) throw new ChangeRequestError("invalid_params", "A request cannot be a duplicate of itself.");
      const survivor = await this.store.get(id);
      if (!survivor) throw new ChangeRequestError("not_found", "duplicateOf names no request.");
      if (survivor.status === "duplicate" && survivor.duplicateOf) {
        id = survivor.duplicateOf;
        continue;
      }
      if (survivor.status === "declined" || survivor.status === "withdrawn") {
        throw new ChangeRequestError("terminal_status", `duplicateOf names a ${survivor.status} request.`);
      }
      return id;
    }
    throw new ChangeRequestError("invalid_params", "duplicateOf leads through too many duplicates.");
  }

  private async markSeen(records: ChangeRequestRecord[]): Promise<void> {
    for (const seen of records) {
      if (!seen.unread && !(seen.status === "shipped" && !seen.pickedUp)) continue;
      const fresh = await this.mutate(seen.requestId, (r) => {
        r.unread = false;
        if (r.status === "shipped") r.pickedUp = true;
      });
      Object.assign(seen, fresh);
    }
  }

  private toStatus(record: ChangeRequestRecord): StatusObject {
    const status: StatusObject = {
      requestId: record.requestId,
      title: record.title,
      kind: record.kind,
      status: record.status,
      origin: record.origin,
      about: record.about,
      updatedAt: record.updatedAt,
      demand: record.demandFrom.length,
    };
    if (record.message !== undefined) status.message = record.message;
    if (record.resolution) status.resolution = record.resolution;
    if (record.duplicateOf) status.duplicateOf = record.duplicateOf;
    if (record.version) status.version = record.version;
    const latest = record.confirmations.at(-1);
    if (latest) {
      status.confirmation = { outcome: latest.outcome, confirmedAt: latest.confirmedAt };
      if (latest.adopted !== undefined) status.confirmation.adopted = latest.adopted;
    }
    return status;
  }

  private async emit(event: ChangeEvent): Promise<void> {
    for (const listener of [this.onEvent, ...this.listeners]) {
      if (!listener) continue;
      try {
        await listener(event);
      } catch {
        // A failed notification must never fail the request.
      }
    }
  }
}
