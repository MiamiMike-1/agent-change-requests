/**
 * Relays requests about an extension itself (SEP section 3, target type extension)
 * to that extension's maintainers, and carries their answer back into the requester's
 * inbox. A server receives these requests like any other; the relay is what gets them
 * one level up, to the people who can change the standard or its SDKs.
 */
import { ChangeRequestError } from "./errors.js";
import { isTerminal } from "./lifecycle.js";
import type { ChangeRequestService } from "./service.js";
import type { ChangeEvent, ChangeRequestRecord, Impact, Kind, Target, UpstreamLink } from "./types.js";

/**
 * What the relay sends upstream. It is deliberately smaller than the stored record:
 * no principal, no context (goal, workaround, attempts), and no acceptance tests,
 * because those can carry details of the requester's own work. See SEP section 9.
 */
export interface UpstreamRequest {
  requestId: string;
  kind: Kind;
  title: string;
  description: string;
  target?: Target;
  failureMode?: string;
  impact?: Impact;
  /** The relaying server's name, so maintainers can see where requests come from. */
  server?: string;
  submittedAt: string;
}

/** The maintainers' answer, as the sink reads it. */
export type UpstreamState =
  | { state: "open" }
  | { state: "shipped"; url?: string; at?: string }
  | { state: "declined"; reason: string; url?: string };

/** Somewhere a relayed request lands, such as an issue tracker. */
export interface UpstreamSink {
  forward(request: UpstreamRequest): Promise<{ ref: string; url?: string }>;
  poll(ref: string): Promise<UpstreamState>;
}

export interface UpstreamRelayOptions {
  service: ChangeRequestService;
  /**
   * Where each extension's maintainers accept requests, keyed by extension identifier,
   * for example { "io.modelcontextprotocol/change-requests": sink }. A request with
   * target type extension goes to the sink for its target.name. Extensions with no
   * entry are not relayed.
   */
  sinks: Record<string, UpstreamSink>;
  /**
   * The identifier this server uses for the change requests extension. When set, a
   * request marked about "spec" that does not use an extension target (for example one
   * that targets a change_requests tool) goes to that extension's sink.
   */
  extensionId?: string;
  /** Shown to maintainers as the relaying server. */
  serverName?: string;
  /**
   * Most requests to forward in 24 hours, across all principals. Default 20. Requests
   * over the cap stay on this server, and forward() can send them later. 0 turns it off.
   */
  maxPerDay?: number;
  /** Called when a forward or a sync step fails. The relay never fails a submit. */
  onError?: (error: unknown, requestId: string) => void;
  now?: () => Date;
}

export interface SyncReport {
  checked: number;
  shipped: string[];
  declined: string[];
}

export function upstreamRequest(record: ChangeRequestRecord, serverName?: string): UpstreamRequest {
  const out: UpstreamRequest = {
    requestId: record.requestId,
    kind: record.kind,
    title: record.title,
    description: record.description,
    submittedAt: record.createdAt,
  };
  if (record.target) out.target = { ...record.target };
  if (record.failureMode !== undefined) out.failureMode = record.failureMode;
  if (record.impact) out.impact = { ...record.impact };
  if (serverName) out.server = serverName;
  return out;
}

export class UpstreamRelay {
  private readonly service: ChangeRequestService;
  private readonly sinks: Record<string, UpstreamSink>;
  private readonly extensionId: string | undefined;
  private readonly serverName: string | undefined;
  private readonly onError: (error: unknown, requestId: string) => void;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<UpstreamLink | null>>();
  private readonly maxPerDay: number;
  private sentAt: number[] = [];

  constructor(options: UpstreamRelayOptions) {
    this.service = options.service;
    this.sinks = { ...options.sinks };
    this.extensionId = options.extensionId;
    this.serverName = options.serverName;
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.maxPerDay = options.maxPerDay ?? 20;
  }

  /**
   * Forwards each new matching request as it is submitted. Returns a function that
   * stops. Forwarding runs after submit has answered, so a slow or failing sink never
   * delays or fails the requester.
   */
  attach(): () => void {
    return this.service.subscribe((event: ChangeEvent) => {
      if (event.type !== "submitted") return;
      void this.forward(event.requestId).catch((error) => this.onError(error, event.requestId));
    });
  }

  /**
   * Forwards one request if it matches and was not forwarded yet. Returns the link,
   * or null when the request does not match. Safe to call again: it forwards once.
   */
  async forward(requestId: string): Promise<UpstreamLink | null> {
    const pending = this.inFlight.get(requestId);
    if (pending) return pending;
    const work = this.forwardOnce(requestId).finally(() => this.inFlight.delete(requestId));
    this.inFlight.set(requestId, work);
    return work;
  }

  /**
   * Reads the maintainers' answer for every relayed request that is still open, and
   * moves the request to shipped or declined to match. Run it on a schedule. The
   * requester sees the change as an ordinary inbox update.
   */
  async sync(): Promise<SyncReport> {
    const report: SyncReport = { checked: 0, shipped: [], declined: [] };
    let cursor: string | undefined;
    const open: ChangeRequestRecord[] = [];
    do {
      const page = await this.service.listAll(cursor ? { cursor } : {});
      for (const r of page.items) if (r.upstream && !isTerminal(r.status)) open.push(r);
      cursor = page.nextCursor;
    } while (cursor);

    for (const record of open) {
      const link = record.upstream as UpstreamLink;
      const sink = this.sinks[link.extension];
      if (!sink) continue;
      report.checked += 1;
      try {
        const state = await sink.poll(link.ref);
        if (state.state === "shipped") {
          const resolution: { availability: "all"; changelogUri?: string } = { availability: "all" };
          const uri = state.url ?? link.url;
          if (uri) resolution.changelogUri = uri;
          const input: Parameters<ChangeRequestService["transition"]>[1] = {
            status: "shipped",
            message: "The extension's maintainers shipped this change.",
            resolution,
          };
          if (state.at) input.at = state.at;
          await this.service.transition(record.requestId, input);
          report.shipped.push(record.requestId);
        } else if (state.state === "declined") {
          await this.service.transition(record.requestId, {
            status: "declined",
            message: `The extension's maintainers declined this: ${state.reason}`.slice(0, 1000),
          });
          report.declined.push(record.requestId);
        }
      } catch (error) {
        this.onError(error, record.requestId);
      }
    }
    return report;
  }

  /**
   * Forwards every open request that should have been relayed and was not, for example
   * because the sink was down or a cap was reached. Run it with sync(). It stops at the
   * first failure, so a cap that is still in force is not hit again and again.
   */
  async forwardPending(): Promise<string[]> {
    const pending: ChangeRequestRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.service.listAll(cursor ? { cursor } : {});
      for (const r of page.items) {
        const extension = this.extensionFor(r);
        if (!r.upstream && !isTerminal(r.status) && extension !== undefined && this.sinks[extension]) pending.push(r);
      }
      cursor = page.nextCursor;
    } while (cursor);
    const forwarded: string[] = [];
    for (const record of pending.reverse()) {
      try {
        if (await this.forward(record.requestId)) forwarded.push(record.requestId);
      } catch (error) {
        this.onError(error, record.requestId);
        break;
      }
    }
    return forwarded;
  }

  private async forwardOnce(requestId: string): Promise<UpstreamLink | null> {
    const record = await this.service.recordOf(requestId);
    if (record.upstream) return record.upstream;
    const extension = this.extensionFor(record);
    const sink = extension === undefined ? undefined : this.sinks[extension];
    if (isTerminal(record.status) || extension === undefined || !sink) return null;
    const nowMs = this.now().getTime();
    this.sentAt = this.sentAt.filter((t) => nowMs - t < 24 * 60 * 60 * 1000);
    if (this.maxPerDay > 0 && this.sentAt.length >= this.maxPerDay) {
      throw new Error(`The relay forwards at most ${this.maxPerDay} requests a day.`);
    }
    this.sentAt.push(nowMs);

    const sent = await sink.forward(upstreamRequest(record, this.serverName));
    const link: UpstreamLink = { extension, ref: sent.ref, forwardedAt: this.now().toISOString() };
    if (sent.url) link.url = sent.url;
    await this.service.setUpstream(requestId, link);

    // Tell the requester where it went. Only a received request moves; if a builder
    // already triaged it, the link is still on the record for the builder side.
    if (record.status === "received") {
      const where = link.url ? `: ${link.url}` : ".";
      try {
        await this.service.transition(requestId, {
          status: "triaged",
          message: `Relayed to the extension's maintainers${where}`.slice(0, 1000),
        });
      } catch (error) {
        if (!(error instanceof ChangeRequestError)) throw error;
        // Someone moved it in the meantime. The link is recorded either way.
      }
    }
    return link;
  }

  /** The extension a request is about, if any. */
  private extensionFor(record: ChangeRequestRecord): string | undefined {
    if (record.target?.type === "extension") return record.target.name;
    if (record.about === "spec") return this.extensionId;
    return undefined;
  }
}

// ---- Change requests endpoint sink ---------------------------------------

/**
 * Sends one MCP request to the maintainers' endpoint and returns its result.
 * endpointCaller in "./endpoint" builds one from a URL.
 */
export type UpstreamCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ChangeRequestsEndpointSinkOptions {
  /** Reaches the endpoint the extension's maintainers named for relayed requests. */
  call: UpstreamCall;
}

/**
 * Relays to an endpoint that itself speaks this extension and accepts anonymous
 * callers (SEP section 3). The relaying server needs no account or credential there:
 * it submits anonymously, keeps the ticket, and reads the answer with it.
 */
export class ChangeRequestsEndpointSink implements UpstreamSink {
  private readonly call: UpstreamCall;

  constructor(options: ChangeRequestsEndpointSinkOptions) {
    if (typeof options?.call !== "function") throw new Error("ChangeRequestsEndpointSink needs a call function.");
    this.call = options.call;
  }

  async forward(request: UpstreamRequest): Promise<{ ref: string; url?: string }> {
    const params: Record<string, unknown> = {
      kind: request.kind,
      title: request.title,
      description: request.description,
      // The same request always carries the same key, so a retried forward files once.
      idempotencyKey: `relay:${request.server ?? ""}:${request.requestId}:${request.submittedAt}`.slice(0, 200),
    };
    if (request.target) params.target = request.target;
    if (request.failureMode !== undefined) params.failureMode = request.failureMode;
    if (request.impact) params.impact = request.impact;
    const result = await this.call("changeRequests/submit", params);
    const { requestId, ticket } = result;
    if (typeof requestId !== "string" || typeof ticket !== "string" || /\s/.test(requestId)) {
      throw new Error("The endpoint returned no ticket. It must accept anonymous callers.");
    }
    // The ticket is a credential. The ref stays on the stored record, which callers never see.
    return { ref: `${requestId} ${ticket}` };
  }

  async poll(ref: string): Promise<UpstreamState> {
    const space = ref.indexOf(" ");
    if (space <= 0) throw new Error("Not an endpoint ref.");
    const status = await this.call("changeRequests/get", { requestId: ref.slice(0, space), ticket: ref.slice(space + 1) });
    const message = typeof status.message === "string" ? status.message : undefined;
    switch (status.status) {
      case "shipped": {
        const shipped: UpstreamState = { state: "shipped" };
        const uri = (status.resolution as { changelogUri?: unknown } | undefined)?.changelogUri;
        if (typeof uri === "string") shipped.url = uri;
        return shipped;
      }
      case "declined":
        return { state: "declined", reason: message ?? "no reason given" };
      case "duplicate":
        return { state: "declined", reason: "it duplicates a request the maintainers already have" };
      case "withdrawn":
        return { state: "declined", reason: "it was withdrawn" };
      default:
        return { state: "open" };
    }
  }
}

// ---- GitHub Issues sink --------------------------------------------------

export interface GitHubIssueSinkOptions {
  /** owner/name: the repository where the extension's maintainers accept requests. */
  repo: string;
  /** A token that can create issues in repo. Supplied by the server operator. */
  token: string;
  /** Labels for new issues. Default ["agent-change-request"]. */
  labels?: string[];
  /** For GitHub Enterprise. Default https://api.github.com. */
  apiBase?: string;
  fetch?: typeof fetch;
}

/** Stops agent text from pinging people or teams in the maintainers' tracker. */
function neutralize(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@​");
}

function quote(text: string): string {
  return neutralize(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function issueBody(request: UpstreamRequest): string {
  const facts: string[] = [`- Kind: \`${request.kind}\``];
  if (request.target) {
    const t = request.target;
    const parts = [t.type, t.name, t.component].filter((p): p is string => typeof p === "string" && p.length > 0);
    facts.push(`- Target: \`${neutralize(parts.join(" / "))}\``);
  }
  if (request.failureMode) facts.push(`- Failure mode: \`${neutralize(request.failureMode)}\``);
  if (request.impact) {
    const i = request.impact;
    const bits = [
      i.blocked !== undefined ? `blocked ${i.blocked}` : null,
      i.frequency ?? null,
      i.severity ? `severity ${i.severity}` : null,
      i.detectability ? `detectability ${i.detectability}` : null,
    ].filter(Boolean);
    if (bits.length) facts.push(`- Impact: ${bits.join(", ")}`);
  }
  if (request.server) facts.push(`- Relayed by: ${neutralize(request.server)}`);
  facts.push(`- Request: \`${request.requestId}\`, submitted ${request.submittedAt}`);
  return [
    "An agent filed this change request about the extension itself. The relaying server sent only the fields below: no requester identity, task context, or acceptance tests.",
    "",
    quote(request.description),
    "",
    ...facts,
    "",
    "Close this issue as completed when the change ships, or as not planned to decline it. The relaying server reads that state and tells the requester.",
  ].join("\n");
}

interface IssueResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  state_reason?: string | null;
  closed_at?: string | null;
}

/**
 * Files each relayed request as a GitHub issue and reads its state back. Closed as
 * completed means shipped. Closed as not planned or duplicate means declined.
 */
export class GitHubIssueSink implements UpstreamSink {
  private readonly repo: string;
  private readonly token: string;
  private readonly labels: string[];
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubIssueSinkOptions) {
    if (!options.token) throw new Error("GitHubIssueSink needs a token.");
    this.repo = options.repo;
    if (typeof this.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(this.repo)) throw new Error("repo must be owner/name.");
    this.token = options.token;
    this.labels = options.labels ?? ["agent-change-request"];
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async forward(request: UpstreamRequest): Promise<{ ref: string; url?: string }> {
    const issue = await this.call<IssueResponse>("POST", `/repos/${this.repo}/issues`, {
      title: neutralize(request.title).slice(0, 256),
      body: issueBody(request),
      labels: this.labels,
    });
    return { ref: `${this.repo}#${issue.number}`, url: issue.html_url };
  }

  async poll(ref: string): Promise<UpstreamState> {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
    if (!match) throw new Error(`Not a GitHub issue ref: ${ref}`);
    const issue = await this.call<IssueResponse>("GET", `/repos/${match[1]}/issues/${match[2]}`);
    if (issue.state === "open") return { state: "open" };
    if (issue.state_reason === "not_planned" || issue.state_reason === "duplicate") {
      const reason = issue.state_reason === "duplicate" ? "it duplicates another issue" : "it is not planned";
      return { state: "declined", reason: `${reason} (${issue.html_url})`, url: issue.html_url };
    }
    const shipped: UpstreamState = { state: "shipped", url: issue.html_url };
    if (issue.closed_at) shipped.at = issue.closed_at;
    return shipped;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-change-requests-relay",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(`${this.apiBase}${path}`, init);
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed with ${res.status}.`);
    return (await res.json()) as T;
  }
}
