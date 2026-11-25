import { randomBytes, timingSafeEqual } from "node:crypto";
import { ChangeRequestError } from "./errors.js";
import { canTransition, isTerminal } from "./lifecycle.js";
import { computeScorecard, type Scorecard, type ScorecardOptions } from "./scorecard.js";
import { decodeCursor, encodeCursor, isChangeFeedStore, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type ChangeFeedStore, type ChangeRequestStore } from "./store.js";
import { LIMITS, validateChange, validateConfirmTests, validateSubmit } from "./validate.js";
import { compareVersions as defaultCompareVersions, type CompareVersions } from "./versions.js";
import {
  KINDS,
  type About,
  type ChangeEntry,
  type ChangeEvent,
  type ChangeRecord,
  type ChangesPage,
  type ChangesQuery,
  type ChangeType,
  type ChangeRequestRecord,
  type Kind,
  type ListQuery,
  type Page,
  type Resolution,
  type Stage,
  type Status,
  type StatusObject,
  type SubmitResult,
  type Target,
  type UpstreamLink,
} from "./types.js";

/** The tool names this package registers. A request that targets one is about the spec. */
export const EXTENSION_TOOL_NAMES = [
  "change_requests_submit",
  "change_requests_list",
  "change_requests_get",
  "change_requests_withdraw",
  "change_requests_confirm",
  "change_requests_scorecard",
  "whats_new",
] as const;

/**
 * The principal stored on requests from anonymous callers. They share it, so the
 * daily cap is shared and demand counts all anonymous callers as one. A real
 * principal with this value is refused.
 */
export const ANONYMOUS_PRINCIPAL = "acr:anonymous";

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
  /**
   * Accept requests from callers with no authenticated principal (SEP section 3).
   * Each gets a ticket that reads that one request. No inbox, no notice, no
   * confirmation. Default false: leave it off unless you have another abuse control.
   */
  anonymous?: boolean;
  /** Most requests all anonymous callers together may submit in 24 hours. Default 50. 0 turns the cap off. */
  anonymousDailyCap?: number;
  /**
   * Where the changes feed (SEP section 12) is kept. Default: the store, when it
   * implements ChangeFeedStore (MemoryStore and SqliteStore do).
   */
  feed?: ChangeFeedStore;
  /** Set false to turn the changes feed off even when the store supports it. */
  changes?: boolean;
  /** The server's current version, returned by changes(). Default: the newest version in the feed. */
  currentVersion?: string | (() => string);
  /** Orders versions for sinceVersion. Default: semantic versions. */
  compareVersions?: CompareVersions;
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

function newTicket(): string {
  return `crt_${randomBytes(16).toString("hex")}`;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Input for publishChange: one entry of the changes feed. */
export interface PublishChangeInput {
  version: string;
  type: ChangeType;
  summary: string;
  /** Required true for a change that can break a call that worked before. Always true for removed. */
  breaking?: boolean;
  changed?: ChangeEntry["changed"];
  changelogUri?: string;
  /** For deprecated entries: the earliest date (YYYY-MM-DD) the target may be removed. */
  removeAfter?: string;
  /** Default now. */
  publishedAt?: string;
  /**
   * all (default): every caller sees it. requester: only the owners of
   * changeRequestIds and the principals in releasedTo see it.
   */
  availability?: "all" | "requester";
  releasedTo?: string[];
  /** Requests this change resolved. Each owner sees its own ids, and no one else's. */
  changeRequestIds?: string[];
}

/** Counts for the notice: unread request updates, and unread breaking or deprecated changes. */
export interface NoticeCounts {
  updates: number;
  changes: number;
}

/**
 * The extension's server side, independent of transport. The MCP adapter in "./mcp"
 * calls the caller-facing methods. The builder side (triage, CI, release scripts)
 * calls transition and recordStage.
 */
export class ChangeRequestService {
  readonly kinds: readonly Kind[];
  readonly acceptanceTests: boolean;
  /** Whether callers without an authenticated principal may submit. */
  readonly anonymous: boolean;
  private readonly store: ChangeRequestStore;
  private readonly feed: ChangeFeedStore | undefined;
  private readonly anonymousDailyCap: number;
  private readonly currentVersionOption: ServiceOptions["currentVersion"];
  private readonly compare: CompareVersions;
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
    this.anonymous = options.anonymous ?? false;
    this.anonymousDailyCap = options.anonymousDailyCap ?? 50;
    if (options.changes !== false) {
      const feed = options.feed ?? (isChangeFeedStore(options.store) ? options.store : undefined);
      if (feed) this.feed = feed;
    }
    this.currentVersionOption = options.currentVersion;
    this.compare = options.compareVersions ?? defaultCompareVersions;
    this.isShared = options.isSharedCredential ?? (() => false);
    if (options.onEvent) this.onEvent = options.onEvent;
    this.specTargets = new Set([...EXTENSION_TOOL_NAMES, ...(options.specTargets ?? [])]);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  // ---- Caller side -------------------------------------------------------

  /** Whether this service answers changes() (SEP section 12). */
  get changesEnabled(): boolean {
    return this.feed !== undefined;
  }

  async submit(principal: string | null | undefined, input: unknown): Promise<SubmitResult> {
    const anonymous = !principal && this.anonymous;
    const who = anonymous ? ANONYMOUS_PRINCIPAL : this.requirePrincipal(principal);
    const params = validateSubmit(input, { kinds: this.kinds, acceptanceTests: this.acceptanceTests });

    const existing = await this.store.findByIdempotencyKey(who, params.idempotencyKey);
    if (existing) return { ...existing.firstResult };

    const now = this.now();
    const cap = anonymous ? this.anonymousDailyCap : this.dailyCap;
    if (cap > 0) {
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      const count = await this.store.countSubmittedSince(who, since);
      if (count >= cap) {
        const oldest = await this.store.oldestSubmittedSince(who, since);
        const retryAfterMs = oldest ? Math.max(Date.parse(oldest) + DAY_MS - now.getTime(), 0) : DAY_MS;
        throw new ChangeRequestError(
          "rate_limited",
          `At most ${cap} change requests a day${anonymous ? " from anonymous callers" : ""}. Try again later.`,
          { retryAfterMs },
        );
      }
    }

    const at = now.toISOString();
    const requestId = this.newId();
    const firstResult: SubmitResult = { requestId, status: "received", duplicateOf: null, demand: 1 };
    const ticket = anonymous ? newTicket() : undefined;
    if (ticket) firstResult.ticket = ticket;
    const record: ChangeRequestRecord = {
      requestId,
      principal: who,
      idempotencyKey: params.idempotencyKey,
      kind: params.kind,
      title: params.title,
      description: params.description,
      origin: params.origin ?? "agent",
      about: params.about ?? this.inferAbout(params.target),
      status: "received",
      demandFrom: [who],
      confirmations: [],
      stages: { requested: at },
      approximate: [],
      unread: false,
      pickedUp: false,
      firstResult,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    if (params.target) record.target = params.target;
    if (params.context) record.context = params.context;
    if (params.failureMode !== undefined) record.failureMode = params.failureMode;
    if (params.impact) record.impact = params.impact;
    if (params.acceptanceTests) record.acceptanceTests = params.acceptanceTests;
    if (ticket) {
      record.anonymous = true;
      record.ticket = ticket;
    }

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

  /**
   * Reads one of the caller's own requests and clears its update. With a ticket, reads
   * the one anonymous request the ticket was issued for, whoever calls.
   */
  async get(principal: string | null | undefined, requestId: string, ticket?: string): Promise<StatusObject> {
    if (ticket !== undefined) return this.getByTicket(requestId, ticket);
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

  /** How many of this principal's requests have an unread update. 0 for a shared credential or an anonymous caller. */
  async pendingUpdates(principal: string | null | undefined): Promise<number> {
    if (!this.hasInbox(principal)) return 0;
    return this.store.countUnread(principal);
  }

  /**
   * How many breaking or deprecated changes this principal has not read (SEP section 12).
   * 0 for anonymous callers, shared credentials, and principals who turned the notice off.
   * The first time a principal is seen, everything already published counts as read,
   * so a new caller is not told about old deprecations.
   */
  async pendingChanges(principal: string | null | undefined): Promise<number> {
    if (!this.feed || !this.hasInbox(principal)) return 0;
    const reader = await this.feed.getReader(principal);
    if (!reader) {
      const newest = (await this.feed.listChanges())[0]?.seq ?? 0;
      await this.feed.putReader({ principal, seenSeq: newest, muted: false });
      return 0;
    }
    if (reader.muted) return 0;
    const unread = await this.feed.listChanges(reader.seenSeq);
    return unread.filter((c) => this.visibleTo(c, principal) && (c.breaking || c.type === "deprecated")).length;
  }

  /** Both notice counts at once. */
  async notices(principal: string | null | undefined): Promise<NoticeCounts> {
    return { updates: await this.pendingUpdates(principal), changes: await this.pendingChanges(principal) };
  }

  /**
   * Turns the changes notice on or off for one principal (SEP section 12: the principal
   * can turn it off). The feed itself stays readable.
   */
  async setChangeNotice(principal: string | null | undefined, enabled: boolean): Promise<void> {
    if (!this.feed) throw new ChangeRequestError("invalid_params", "This server has no changes feed.");
    const who = this.requireInbox(principal);
    const reader = (await this.feed.getReader(who)) ?? { principal: who, seenSeq: 0, muted: false };
    await this.feed.putReader({ ...reader, muted: !enabled });
  }

  /**
   * The changes feed (SEP section 12): what shipped after sinceVersion or since, newest
   * first. Needs no authenticated principal. A principal sees changes for everyone plus
   * those released to it alone, and only its own changeRequestIds. Reading marks the
   * feed as read for the changes notice.
   */
  async changes(principal: string | null | undefined, query: ChangesQuery = {}): Promise<ChangesPage> {
    if (!this.feed) throw new ChangeRequestError("invalid_params", "This server has no changes feed.");
    if (query.sinceVersion !== undefined && query.since !== undefined) {
      throw new ChangeRequestError("invalid_params", "Pass sinceVersion or since, not both.");
    }
    if (query.sinceVersion !== undefined && (typeof query.sinceVersion !== "string" || query.sinceVersion === "")) {
      throw new ChangeRequestError("invalid_params", "sinceVersion must be a version string.");
    }
    if (query.since !== undefined && (typeof query.since !== "string" || Number.isNaN(Date.parse(query.since)))) {
      throw new ChangeRequestError("invalid_params", "since must be an ISO 8601 time.");
    }
    if (query.cursor !== undefined && typeof query.cursor !== "string") {
      throw new ChangeRequestError("invalid_params", "cursor must be a string.");
    }
    if (query.limit !== undefined && (typeof query.limit !== "number" || !Number.isInteger(query.limit))) {
      throw new ChangeRequestError("invalid_params", "limit must be an integer.");
    }
    // Shared credentials and anonymous callers see only what everyone sees.
    const who = this.hasInbox(principal) ? principal : null;
    const all = await this.feed.listChanges();
    const sinceMs = query.since !== undefined ? Date.parse(query.since) : undefined;
    const matching = all
      .filter((c) => this.visibleTo(c, who))
      .filter((c) => query.sinceVersion === undefined || this.compare(c.version, query.sinceVersion) > 0)
      .filter((c) => sinceMs === undefined || Date.parse(c.publishedAt) > sinceMs)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.seq - a.seq);

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = decodeCursor(query.cursor);
    const page: ChangesPage = {
      currentVersion: this.currentVersion(all),
      changes: matching.slice(offset, offset + limit).map((c) => this.toEntry(c, who)),
    };
    if (offset + limit < matching.length) page.nextCursor = encodeCursor(offset + limit);

    if (who) {
      const newest = all[0]?.seq ?? 0;
      const reader = (await this.feed.getReader(who)) ?? { principal: who, seenSeq: 0, muted: false };
      if (newest > reader.seenSeq) await this.feed.putReader({ ...reader, seenSeq: newest });
    }
    return page;
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

  /**
   * Adds an entry to the changes feed (SEP section 12). Call it from the release
   * script for every change a caller can observe, whether or not anyone asked for it.
   */
  async publishChange(input: PublishChangeInput): Promise<ChangeRecord> {
    if (!this.feed) throw new ChangeRequestError("invalid_params", "This server has no changes feed.");
    validateChange(input);
    const resolves: { requestId: string; principal: string }[] = [];
    for (const requestId of input.changeRequestIds ?? []) {
      const record = await this.store.get(requestId);
      if (!record) throw new ChangeRequestError("not_found", `changeRequestIds names no request: ${requestId}.`);
      // An anonymous request has no one to show its id to.
      if (!record.anonymous) resolves.push({ requestId, principal: record.principal });
    }
    const availability = input.availability ?? "all";
    const change: Omit<ChangeRecord, "seq"> = {
      changeId: `chg_${randomBytes(8).toString("hex")}`,
      version: input.version,
      publishedAt: input.publishedAt ?? this.now().toISOString(),
      type: input.type,
      breaking: input.type === "removed" ? true : input.breaking ?? false,
      summary: input.summary,
      availability,
    };
    if (input.changed) change.changed = input.changed;
    if (input.changelogUri) change.changelogUri = input.changelogUri;
    if (input.removeAfter) change.removeAfter = input.removeAfter;
    if (resolves.length) change.resolves = resolves;
    if (availability === "requester") {
      const to = new Set([...(input.releasedTo ?? []), ...resolves.map((r) => r.principal)]);
      if (to.size === 0) {
        throw new ChangeRequestError("invalid_params", "A requester-only change needs releasedTo or changeRequestIds.");
      }
      change.releasedTo = [...to];
    }
    return this.feed.appendChange(change);
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

  /**
   * Records where a request was relayed upstream. Does not change status or raise an
   * update. UpstreamRelay calls it; a builder with its own relay can too.
   */
  async setUpstream(requestId: string, link: UpstreamLink): Promise<ChangeRequestRecord> {
    if (typeof link?.ref !== "string" || link.ref.length === 0) {
      throw new ChangeRequestError("invalid_params", "An upstream link needs a ref.");
    }
    return this.mutate(requestId, (r) => {
      r.upstream = { ...link };
    });
  }

  /** The stored record, for the builder side. Checks no owner and does not clear the update. */
  async recordOf(requestId: string): Promise<ChangeRequestRecord> {
    const record = typeof requestId === "string" ? await this.store.get(requestId) : null;
    if (!record) throw new ChangeRequestError("not_found", "No such request.");
    return record;
  }

  // ---- Helpers -----------------------------------------------------------

  /**
   * A request is about the spec when it targets one of this package's tools, a name in
   * specTargets, or the change requests extension itself under any vendor prefix.
   */
  private inferAbout(target: Target | undefined): About {
    const name = target?.name;
    if (name === undefined) return "app";
    if (this.specTargets.has(name)) return "spec";
    if (target?.type === "extension" && (name === "change-requests" || name.endsWith("/change-requests"))) return "spec";
    return "app";
  }

  private requirePrincipal(principal: string | null | undefined): string {
    if (!principal || principal === ANONYMOUS_PRINCIPAL) {
      throw new ChangeRequestError("unauthenticated", "Change requests need an authenticated caller.");
    }
    return principal;
  }

  /** A principal that may have an inbox and notices: authenticated, not anonymous, not shared. */
  private hasInbox(principal: string | null | undefined): principal is string {
    return Boolean(principal) && principal !== ANONYMOUS_PRINCIPAL && !this.isShared(principal as string);
  }

  private async getByTicket(requestId: string, ticket: string): Promise<StatusObject> {
    const record = typeof requestId === "string" ? await this.store.get(requestId) : null;
    // A wrong ticket and an unknown id look the same, so tickets cannot be probed.
    if (!record || !record.anonymous || !record.ticket || typeof ticket !== "string" || !sameSecret(record.ticket, ticket)) {
      throw new ChangeRequestError("not_found", "No such request.");
    }
    return this.toStatus(record);
  }

  private visibleTo(change: ChangeRecord, principal: string | null): boolean {
    if (change.availability === "all") return true;
    return principal !== null && (change.releasedTo ?? []).includes(principal);
  }

  private toEntry(change: ChangeRecord, principal: string | null): ChangeEntry {
    const entry: ChangeEntry = {
      version: change.version,
      publishedAt: change.publishedAt,
      type: change.type,
      breaking: change.breaking,
      summary: change.summary,
    };
    if (change.changed) entry.changed = change.changed;
    if (change.changelogUri) entry.changelogUri = change.changelogUri;
    if (change.removeAfter) entry.removeAfter = change.removeAfter;
    const own = principal ? (change.resolves ?? []).filter((r) => r.principal === principal).map((r) => r.requestId) : [];
    if (own.length) entry.changeRequestIds = own;
    return entry;
  }

  private currentVersion(feed: ChangeRecord[]): string {
    const option = this.currentVersionOption;
    const fromOption = typeof option === "function" ? option() : option;
    if (fromOption) return fromOption;
    const versions = feed.map((c) => c.version).sort((a, b) => this.compare(b, a));
    return versions[0] ?? "0.0.0";
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
