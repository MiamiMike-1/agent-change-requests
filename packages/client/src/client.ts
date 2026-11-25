/**
 * Client support for the Agent Change Requests extension, on top of Client from
 * @modelcontextprotocol/sdk.
 *
 * - Advertises the extension, only with consent and never from an ephemeral session.
 * - Gives the model one submission tool whose description the client writes.
 * - Redacts every model-written field, applies a daily cap, and skips gaps it already filed.
 * - Reads the inbox when a response carries an update count, and records what shipped.
 * - Re-runs its own acceptance tests and confirms the result.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { runAcceptanceTest } from "./acceptance.js";
import { CHANGES_NOTICE_LINE } from "./changes.js";
import { MemoryLedger, type Ledger, type LedgerData, type LedgerEntry } from "./ledger.js";
import { redactSubmission, type RedactOptions, type RedactionFinding } from "./redact.js";
import {
  TERMINAL_STATUSES,
  type ConfirmParams,
  type ServerSettings,
  type Status,
  type StatusObject,
  type SubmitParams,
  type SubmitResult,
} from "./types.js";

export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

export interface ConsentOptions {
  /** True only when the user or operator turned the extension on for this server. */
  consent: boolean | (() => boolean);
  /** An ephemeral or incognito session. Nothing overrides it: no advertising, no submissions. */
  ephemeral?: boolean;
}

export interface ChangeRequestsClientOptions extends ConsentOptions {
  /** The identifier the server advertises, e.g. "com.example/change-requests". */
  extensionId: string;
  /** A name for the server in the tool description the model sees. */
  serverName?: string;
  /** Most submissions to this server per UTC day. Default 5. */
  dailyCap?: number;
  redaction?: RedactOptions;
  /**
   * Called before each submission with the redacted request and where redaction fired.
   * Return false to cancel, or a revised request. Use it to let the user review.
   * Called on every submission when reviewAll is true, otherwise only when a rule fired.
   */
  review?: (draft: SubmitParams, findings: RedactionFinding[]) => boolean | SubmitParams | Promise<boolean | SubmitParams>;
  reviewAll?: boolean;
  /** Where requests are remembered between sessions. Default: in memory. */
  ledger?: Ledger;
  /** Called once per newly shipped request whose workaround is now obsolete. */
  onShipped?: (status: StatusObject, entry: LedgerEntry) => void | Promise<void>;
  /** Name of the model-facing submission tool. Default file_change_request. */
  toolName?: string;
  /**
   * The inbox tool a client-built notice line names (SEP section 7). It must be a tool the
   * model can call. Default: the server's change_requests_list, used only when the server
   * lists it. Set it when the host gives the model its own inbox tool.
   */
  inboxToolName?: string;
  /**
   * The changes tool a client-built changes line names (SEP section 12). Default: the
   * server's whats_new, used only when the server lists it.
   */
  whatsNewToolName?: string;
  now?: () => Date;
}

export type SubmitOutcome =
  | { submitted: true; result: SubmitResult; findings: RedactionFinding[] }
  | { submitted: false; reason: "already_filed"; requestId: string; status: Status }
  | { submitted: false; reason: "cancelled" | "daily_cap" | "not_enabled" | "kind_unsupported" };

export interface InboxCheck {
  /** Requests whose status changed since the last check. */
  updated: StatusObject[];
  /** Of those, the ones that shipped with workaroundObsolete true. */
  shipped: StatusObject[];
}

export interface Inspection<R> {
  /** The update count the server announced, 0 when none. */
  updates: number;
  /** The result, with the notice line removed when this client must not act on it. */
  result: R;
  /** Present when the client read its inbox because of the notice. */
  inbox?: InboxCheck;
  /** The notice line the model should see, or null (SEP section 7). */
  notice: string | null;
  /** The unread changes count the server announced, 0 when none (SEP section 12). */
  changes: number;
  /** The changes line the model should see, or null (SEP section 12). */
  changesNotice: string | null;
  /** What to show the model for this result. See ChangeRequestsClient.modelContent(). */
  modelContent: { type: "text"; text: string }[];
}

/** A tool result as a client receives it. */
export interface ToolResultLike {
  content?: unknown[];
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The text line servers add while updates wait. Matches any wording that carries the count. */
const NOTICE_LINE = /\b(\d+) of your change requests (?:has|have) an update\b/;

/** The server's default inbox tool (SEP section 7 example). */
const DEFAULT_INBOX_TOOL = "change_requests_list";

/** The fixed line a client adds from the _meta count. It carries no request content. */
export function updateNoticeLine(count: number, inboxTool: string): string {
  const verb = count === 1 ? "has" : "have";
  return `${count} of your change requests ${verb} an update. Call ${inboxTool} to see them.`;
}

/** The server's default changes tool (SEP section 12 example). */
const DEFAULT_CHANGES_TOOL = "whats_new";

/** The fixed changes line a client adds from the _meta count. It carries no change content. */
export function changesNoticeLine(count: number, changesTool: string): string {
  const noun = count === 1 ? "change" : "changes";
  return `${count} ${noun} may affect your use of this server. Call ${changesTool} to see them.`;
}

function isTextMatching(c: unknown, pattern: RegExp): boolean {
  const text = (c as { type?: string; text?: string }).text;
  return (c as { type?: string }).type === "text" && typeof text === "string" && pattern.test(text);
}

function isUpdateBlock(c: unknown): boolean {
  return isTextMatching(c, NOTICE_LINE);
}

function isChangesBlock(c: unknown): boolean {
  return isTextMatching(c, CHANGES_NOTICE_LINE);
}

/** Either notice line: the update line (section 7) or the changes line (section 12). */
function isNoticeBlock(c: unknown): boolean {
  return isUpdateBlock(c) || isChangesBlock(c);
}

function textBlocks(content: unknown[]): { type: "text"; text: string }[] {
  return content
    .filter((c) => (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => ({ type: "text" as const, text: (c as { text: string }).text }));
}

/** The capabilities to pass to new Client(): the extension is advertised only when allowed. */
export function changeRequestsCapabilities(
  extensionId: string,
  consent: ConsentOptions,
  base: ClientCapabilities = {},
): ClientCapabilities {
  if (!allowed(consent)) return base;
  const extensions = { ...((base as { extensions?: Record<string, object> }).extensions ?? {}), [extensionId]: {} };
  return { ...base, extensions } as ClientCapabilities;
}

function allowed(consent: ConsentOptions): boolean {
  if (consent.ephemeral) return false;
  return typeof consent.consent === "function" ? consent.consent() === true : consent.consent === true;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sameTarget(a: SubmitParams["target"], b: LedgerEntry["target"]): boolean {
  if (!a || !b) return false;
  return a.type === b.type && (a.name ?? "") === (b.name ?? "");
}

export class ChangeRequestsClient {
  readonly extensionId: string;
  private readonly client: Client;
  private readonly options: ChangeRequestsClientOptions;
  private readonly ledger: Ledger;
  private readonly now: () => Date;
  private serverToolNames: Promise<Set<string>> | null = null;

  constructor(client: Client, options: ChangeRequestsClientOptions) {
    this.client = client;
    this.options = options;
    this.extensionId = options.extensionId;
    this.ledger = options.ledger ?? new MemoryLedger();
    this.now = options.now ?? (() => new Date());
  }

  /** The server's settings for the extension, or null when it does not advertise it. */
  settings(): ServerSettings | null {
    const extensions = (this.client.getServerCapabilities() as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    const settings = extensions?.[this.extensionId] as ServerSettings | undefined;
    return settings && Array.isArray(settings.kinds) ? settings : null;
  }

  /** Consent given, not ephemeral, and the server supports the extension. */
  enabled(): boolean {
    return allowed(this.options) && this.settings() !== null;
  }

  // ---- The model-facing tool ----------------------------------------------

  /** The one submission tool to show the model. Its description is the client's, not the server's. */
  submissionTool(): { name: string; description: string; inputSchema: Record<string, unknown> } {
    const settings = this.settings();
    const server = this.options.serverName ?? "this server";
    const kinds = settings?.kinds ?? ["bug", "friction", "missing_capability", "feature_request"];
    const properties: Record<string, unknown> = {
      kind: { type: "string", enum: kinds, description: "bug: it is broken. friction: it works but costs extra work. missing_capability: it cannot be done. feature_request: a new idea." },
      title: { type: "string", maxLength: 120, description: "One line." },
      description: { type: "string", maxLength: 4000, description: "What is broken or missing and what would have helped. Plain text." },
      target: {
        type: "object",
        properties: { type: { type: "string", enum: ["tool", "resource", "prompt", "server"] }, name: { type: "string" } },
        required: ["type"],
        description: `Which of ${server}'s tools, resources, or prompts this is about.`,
      },
      context: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What you were trying to get done, in general terms." },
          workaround: { type: "string", description: "What you did instead." },
          cause: { type: "string", maxLength: 500, description: "Your guess at why the gap exists. It is read as a guess." },
          attempts: { type: "array", maxItems: 5, items: { type: "object" }, description: "Up to 5 calls you tried and what happened. Made-up example values only." },
        },
      },
      failureMode: { type: "string", description: "capability_missing, interface_cost, data_gap, discoverability, scope_not_honored, or silent_failure." },
      impact: {
        type: "object",
        properties: {
          blocked: { type: "boolean" },
          frequency: { type: "string", enum: ["once", "recurring"] },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          detectability: { type: "string", enum: ["immediate", "eventual", "hidden"] },
        },
      },
    };
    if (settings?.acceptanceTests) {
      properties.acceptanceTests = {
        type: "array",
        maxItems: 10,
        description: "The exact call you wanted and the result you expected. Made-up example values only.",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            call: {
              type: "object",
              properties: { method: { type: "string", enum: ["tools/call", "resources/read", "prompts/get"] }, params: { type: "object" } },
              required: ["method"],
            },
            expect: {
              type: "object",
              properties: {
                isError: { type: "boolean" },
                structuredContentSchema: { type: "object" },
                textContains: { type: "array", items: { type: "string" }, maxItems: 5 },
              },
            },
          },
          required: ["call"],
        },
      };
    }
    return {
      name: this.options.toolName ?? "file_change_request",
      description: [
        `Tell ${server}'s maintainers about a gap you hit in its tools, and get an answer when it is fixed.`,
        "Use it only when the gap blocked your task, has come up more than once, or the user asked. Do not file one-off edge cases you worked around cheaply.",
        settings?.acceptanceTests ? "Include an acceptance test: the call you wanted and the result you expected." : "",
        "Write in general terms. Never include credentials, personal data, the user's words, file contents, file paths, or anything about other servers. Use made-up example values.",
      ]
        .filter(Boolean)
        .join(" "),
      inputSchema: { type: "object", properties, required: ["kind", "title", "description"] },
    };
  }

  /** Runs the submission tool for the model and returns a tool result for it. */
  async callSubmissionTool(args: Record<string, unknown>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });
    try {
      const outcome = await this.submit(args as SubmitParams);
      if (outcome.submitted) {
        return text(`Filed as ${outcome.result.requestId} (${outcome.result.status}). You will hear back through the inbox when it changes.`);
      }
      switch (outcome.reason) {
        case "already_filed":
          return text(`You already filed this gap as ${outcome.requestId}, which is ${outcome.status}. Keep your workaround for now.`);
        case "daily_cap":
          return text("The daily limit for change requests to this server is reached. Tell the user instead.", true);
        case "cancelled":
          return text("The user did not send this request.", true);
        case "kind_unsupported":
          return text("This server does not accept that kind of request.", true);
        default:
          return text("Change requests are not turned on for this server.", true);
      }
    } catch (error) {
      return text(`The server refused the request: ${error instanceof Error ? error.message : "unknown error"}`, true);
    }
  }

  // ---- Protocol methods ---------------------------------------------------

  /**
   * Submits a request after the client-side checks: consent, kind, daily cap,
   * not already filed for the same target, redaction, and review.
   */
  async submit(input: SubmitParams): Promise<SubmitOutcome> {
    if (!this.enabled()) return { submitted: false, reason: "not_enabled" };
    const settings = this.settings()!;
    if (!settings.kinds.includes(input.kind)) return { submitted: false, reason: "kind_unsupported" };

    const data = this.ledger.load();
    const day = utcDay(this.now());
    const cap = this.options.dailyCap ?? 5;
    if (cap > 0 && (data.submissions[day] ?? 0) >= cap) return { submitted: false, reason: "daily_cap" };

    if (input.target) {
      const open = await this.findOpen(input.target, data);
      if (open) return { submitted: false, reason: "already_filed", requestId: open.requestId, status: open.status };
    }

    const { acceptanceTests, idempotencyKey, ...rest } = input;
    const draft: SubmitParams = { ...rest };
    if (acceptanceTests && settings.acceptanceTests) draft.acceptanceTests = acceptanceTests;

    let { params, findings } = redactSubmission(draft, this.options.redaction);
    if (this.options.review && (this.options.reviewAll || findings.length > 0)) {
      const verdict = await this.options.review(params, findings);
      if (verdict === false) return { submitted: false, reason: "cancelled" };
      if (verdict !== true) ({ params, findings } = redactSubmission(verdict, this.options.redaction));
    }
    params.idempotencyKey = idempotencyKey ?? randomUUID();

    const result = (await this.call("changeRequests/submit", params)) as unknown as SubmitResult;

    const at = this.now().toISOString();
    const fresh = this.ledger.load();
    fresh.submissions[day] = (fresh.submissions[day] ?? 0) + 1;
    const entry: LedgerEntry = { requestId: result.requestId, title: params.title, status: result.status, submittedAt: at, updatedAt: at };
    if (params.target) entry.target = params.target;
    // Keep the tests as sent, so the client re-runs exactly what the server stored.
    if (params.acceptanceTests) entry.acceptanceTests = params.acceptanceTests;
    // Anonymous submissions: the ticket is the only way back to the request (SEP section 3).
    if (typeof result.ticket === "string") entry.ticket = result.ticket;
    if (input.context?.workaround) entry.workaround = input.context.workaround;
    fresh.requests[result.requestId] = entry;
    this.ledger.save(fresh);
    return { submitted: true, result, findings };
  }

  /** Reads one request. Passes the ledger's ticket for a request filed anonymously. */
  async get(requestId: string): Promise<StatusObject> {
    const ticket = this.ledger.load().requests[requestId]?.ticket;
    const params: Record<string, unknown> = ticket ? { requestId, ticket } : { requestId };
    const status = (await this.call("changeRequests/get", params)) as unknown as StatusObject;
    this.remember([status]);
    return status;
  }

  /**
   * For requests filed anonymously, which have no inbox: reads each open one by its
   * ticket and returns what changed, like checkInbox(). Shipped requests with an obsolete
   * workaround are marked in the ledger and passed to onShipped.
   */
  async checkTickets(): Promise<InboxCheck> {
    const before = this.ledger.load();
    const updated: StatusObject[] = [];
    for (const entry of Object.values(before.requests)) {
      if (!entry.ticket || TERMINAL_STATUSES.includes(entry.status)) continue;
      const status = await this.get(entry.requestId);
      if (status.status !== entry.status || status.updatedAt !== entry.updatedAt) updated.push(status);
    }
    const shipped = updated.filter((s) => s.status === "shipped" && s.resolution?.workaroundObsolete === true);
    const after = this.ledger.load();
    for (const status of shipped) {
      const entry = after.requests[status.requestId];
      if (entry) await this.options.onShipped?.(status, entry);
    }
    return { updated, shipped };
  }

  async list(query: { status?: Status[]; updatedSince?: string; cursor?: string } = {}): Promise<{ requests: StatusObject[]; nextCursor?: string }> {
    const page = (await this.call("changeRequests/list", query)) as unknown as { requests: StatusObject[]; nextCursor?: string };
    this.remember(page.requests);
    return page;
  }

  async withdraw(requestId: string): Promise<StatusObject> {
    const status = (await this.call("changeRequests/withdraw", { requestId })) as unknown as StatusObject;
    this.remember([status]);
    return status;
  }

  async confirm(params: ConfirmParams): Promise<StatusObject> {
    const status = (await this.call("changeRequests/confirm", params)) as unknown as StatusObject;
    const data = this.ledger.load();
    const entry = data.requests[params.requestId];
    if (entry) {
      entry.confirmed = params.outcome;
      this.ledger.save(data);
    }
    return status;
  }

  // ---- Inbox and confirmation ----------------------------------------------

  /**
   * Looks at any result from this server. When it announces updates and the client may
   * act on them, reads the inbox. When the client must not act (no consent, ephemeral),
   * removes the notice line so the model never sees it (SEP section 9). Also returns the
   * notice line and the content to show the model, as modelContent() does.
   */
  async inspect<R extends ToolResultLike>(result: R): Promise<Inspection<R>> {
    const updates = this.announced(result);
    // Work out the line before reading the inbox: reading it clears the server's count.
    const notice = await this.noticeLine(result);
    const changesNotice = await this.changesNoticeLine(result);
    const modelContent = this.render(result, [notice, changesNotice]);
    if (!allowed(this.options)) {
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        updates: 0,
        changes: 0,
        result: { ...result, content: content.filter((c) => !isNoticeBlock(c)) },
        notice,
        changesNotice,
        modelContent,
      };
    }
    const changes = this.announcedChanges(result);
    if (updates > 0 && this.enabled()) {
      return { updates, changes, result, inbox: await this.checkInbox(), notice, changesNotice, modelContent };
    }
    return { updates, changes, result, notice, changesNotice, modelContent };
  }

  /**
   * The update notice line the model should see for this result, or null (SEP section 7).
   * Null when the client must withhold the notice (no consent, ephemeral: section 9) or no
   * update is announced. Reuses the server's own line when the text carries one. Otherwise
   * builds the fixed line from the _meta count, naming inboxToolName, or the server's
   * change_requests_list when the server lists it. The line never carries request content.
   */
  async noticeLine(result: ToolResultLike): Promise<string | null> {
    if (!allowed(this.options)) return null;
    const content = Array.isArray(result.content) ? result.content : [];
    const serverLine = content.find(isUpdateBlock) as { text: string } | undefined;
    if (serverLine) return serverLine.text;
    const count = this.announced(result);
    if (count <= 0) return null;
    const tool = this.options.inboxToolName ?? ((await this.serverHasTool(DEFAULT_INBOX_TOOL)) ? DEFAULT_INBOX_TOOL : null);
    return tool ? updateNoticeLine(count, tool) : null;
  }

  /**
   * What a host should show the model for a tool result. A host that shows the model a
   * tool's structuredContent in place of its text drops the server's notice line, so the
   * duty to carry it falls on the client (SEP section 7). This returns the structured
   * content as JSON text followed by the notice line, or, for a result without structured
   * content, its text with the notice line removed when the client must withhold it.
   */
  async modelContent(result: ToolResultLike): Promise<{ type: "text"; text: string }[]> {
    return this.render(result, [await this.noticeLine(result), await this.changesNoticeLine(result)]);
  }

  /**
   * The changes line the model should see for this result, or null (SEP section 12). It
   * follows the rules for the update line: withheld without consent or in an ephemeral
   * session, the server's own line when present, otherwise built from _meta.changes
   * naming whatsNewToolName or the server's whats_new when the server lists it.
   */
  async changesNoticeLine(result: ToolResultLike): Promise<string | null> {
    if (!allowed(this.options)) return null;
    const content = Array.isArray(result.content) ? result.content : [];
    const serverLine = content.find(isChangesBlock) as { text: string } | undefined;
    if (serverLine) return serverLine.text;
    const count = this.announcedChanges(result);
    if (count <= 0) return null;
    const tool = this.options.whatsNewToolName ?? ((await this.serverHasTool(DEFAULT_CHANGES_TOOL)) ? DEFAULT_CHANGES_TOOL : null);
    return tool ? changesNoticeLine(count, tool) : null;
  }

  private render(result: ToolResultLike, notices: (string | null)[]): { type: "text"; text: string }[] {
    const content = Array.isArray(result.content) ? result.content : [];
    const lines = notices.filter((n): n is string => Boolean(n)).map((text) => ({ type: "text" as const, text }));
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
      return [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }, ...lines];
    }
    return [...textBlocks(content.filter((c) => !isNoticeBlock(c))), ...lines];
  }

  /** The unread changes count a result announces, from _meta or else from the text line. */
  private announcedChanges(result: ToolResultLike): number {
    const fromMeta = (result._meta?.[this.extensionId] as { changes?: unknown } | undefined)?.changes;
    if (typeof fromMeta === "number" && fromMeta > 0) return fromMeta;
    const content = Array.isArray(result.content) ? result.content : [];
    const line = content.find(isChangesBlock) as { text: string } | undefined;
    const match = line ? CHANGES_NOTICE_LINE.exec(line.text) : null;
    return match ? Number(match[1]) : 0;
  }

  /** The update count a result announces, from _meta or else from the text line. */
  private announced(result: ToolResultLike): number {
    const fromMeta = (result._meta?.[this.extensionId] as { updates?: unknown } | undefined)?.updates;
    if (typeof fromMeta === "number" && fromMeta > 0) return fromMeta;
    const content = Array.isArray(result.content) ? result.content : [];
    const line = content.find(isUpdateBlock) as { text: string } | undefined;
    const match = line ? NOTICE_LINE.exec(line.text) : null;
    return match ? Number(match[1]) : 0;
  }

  private async serverHasTool(name: string): Promise<boolean> {
    if (!this.client.getServerCapabilities()?.tools) return false;
    this.serverToolNames ??= (async () => {
      const names = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) names.add(tool.name);
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    })().catch(() => {
      this.serverToolNames = null;
      return new Set<string>();
    });
    return (await this.serverToolNames).has(name);
  }

  /**
   * Reads the inbox and returns what changed since the client last looked. Shipped
   * requests with an obsolete workaround are marked in the ledger and passed to onShipped.
   */
  async checkInbox(): Promise<InboxCheck> {
    const before = this.ledger.load();
    const updated: StatusObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(cursor ? { cursor } : {});
      for (const status of page.requests) {
        const known = before.requests[status.requestId];
        if (!known || known.status !== status.status || known.updatedAt !== status.updatedAt) updated.push(status);
      }
      cursor = page.nextCursor;
    } while (cursor);

    const shipped = updated.filter((s) => s.status === "shipped" && s.resolution?.workaroundObsolete === true);
    const after = this.ledger.load();
    for (const status of shipped) {
      const entry = after.requests[status.requestId];
      if (!entry || before.requests[status.requestId]?.workaroundObsolete) continue;
      await this.options.onShipped?.(status, entry);
    }
    return { updated, shipped };
  }

  /**
   * Re-runs the acceptance tests this client sent with a shipped request, under its own
   * authorization, and confirms with the per-test outcomes.
   */
  async retestAndConfirm(requestId: string, note?: string): Promise<{ outcome: "pass" | "fail"; status: StatusObject }> {
    const entry = this.ledger.load().requests[requestId];
    const tests = entry?.acceptanceTests ?? [];
    if (tests.length === 0) throw new Error("No acceptance tests recorded for this request. Call confirm() with your own outcome.");
    const runs = [];
    for (const test of tests) runs.push(await runAcceptanceTest(this.client, test));
    const outcome = runs.every((r) => r.outcome === "pass") ? "pass" : "fail";
    const reasons = runs.flatMap((r, i) => r.reasons.map((reason) => `test ${i}: ${reason}`));
    const params: ConfirmParams = { requestId, outcome, tests: runs.map((r, index) => ({ index, outcome: r.outcome })) };
    const text = note ?? (reasons.length ? reasons.join("; ") : undefined);
    if (text) params.note = text.slice(0, 1000);
    return { outcome, status: await this.confirm(params) };
  }

  /** What the ledger knows, for showing the user or a later session. */
  entries(): LedgerEntry[] {
    return Object.values(this.ledger.load().requests);
  }

  // ---- Helpers --------------------------------------------------------------

  private async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.enabled()) throw new Error("Change requests are not enabled for this server.");
    const withMeta = { ...params, _meta: { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [this.extensionId]: {} } } } };
    return (await this.client.request({ method, params: withMeta } as never, ResultSchema)) as Record<string, unknown>;
  }

  /** An open request of this client's for the same target, checked against the server. */
  private async findOpen(target: NonNullable<SubmitParams["target"]>, data: LedgerData): Promise<StatusObject | null> {
    const isOpen = (s: Status) => !TERMINAL_STATUSES.includes(s);
    const candidates = Object.values(data.requests).filter((e) => sameTarget(target, e.target) && isOpen(e.status));
    for (const candidate of candidates) {
      try {
        const status = await this.get(candidate.requestId);
        if (isOpen(status.status)) return status;
      } catch {
        // Gone from the server: not a reason to skip filing.
      }
    }
    return null;
  }

  private remember(statuses: StatusObject[]): void {
    const data = this.ledger.load();
    let changed = false;
    for (const status of statuses) {
      const entry = data.requests[status.requestId];
      if (!entry) continue;
      entry.status = status.status;
      entry.updatedAt = status.updatedAt;
      if (status.status === "shipped" && status.resolution?.workaroundObsolete) entry.workaroundObsolete = true;
      changed = true;
    }
    if (changed) this.ledger.save(data);
  }
}
