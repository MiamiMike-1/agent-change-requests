/**
 * Client support for the changes feed (SEP section 12).
 *
 * - Reads changeRequests/changes from the version this client last saw.
 * - Records breaking and deprecated entries where a later session will find them, and
 *   hands them to onChange so the client can tell the user. Additions and fixes are kept
 *   out of that path, so they never interrupt.
 * - Gives the model one whats_new tool whose input matches the method's parameters.
 *
 * Reading the feed sends nothing about the user, so it does not need submission consent.
 * The extension is advertised on the call only when consent allows it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ChangeEntry, ChangesPage, ChangesQuery, ServerSettings } from "./types.js";

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** The changes line servers add while breaking or deprecated entries are unread. */
export const CHANGES_NOTICE_LINE = /\b(\d+) changes? may affect your use of this server\b/;

export interface ChangesLedgerData {
  /** currentVersion at the last check. The next check asks for what came after it. */
  lastVersion?: string;
  /** Breaking and deprecated entries seen so far, newest first. */
  notices: ChangeEntry[];
}

export interface ChangesLedger {
  load(): ChangesLedgerData;
  save(data: ChangesLedgerData): void;
}

export class MemoryChangesLedger implements ChangesLedger {
  private data: ChangesLedgerData = { notices: [] };
  load(): ChangesLedgerData {
    return structuredClone(this.data);
  }
  save(data: ChangesLedgerData): void {
    this.data = structuredClone(data);
  }
}

/** One JSON file per server, kept next to the request ledger. */
export class FileChangesLedger implements ChangesLedger {
  constructor(private readonly path: string) {}
  load(): ChangesLedgerData {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ChangesLedgerData>;
      const data: ChangesLedgerData = { notices: parsed.notices ?? [] };
      if (parsed.lastVersion) data.lastVersion = parsed.lastVersion;
      return data;
    } catch {
      return { notices: [] };
    }
  }
  save(data: ChangesLedgerData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

export interface ChangesFeedOptions {
  /** The identifier the server advertises, e.g. "com.example/change-requests". */
  extensionId: string;
  /** Whether the user or operator enabled the extension for this server. Only decides whether the call advertises it. */
  consent?: boolean | (() => boolean);
  ephemeral?: boolean;
  serverName?: string;
  ledger?: ChangesLedger;
  /**
   * The tools, resources, or prompts this client uses. When given, only breaking and
   * deprecated entries that name one of them (or name no target) are surfaced.
   */
  targets?: string[] | (() => string[]);
  /** Called once per newly seen breaking or deprecated entry. Tell the user here. */
  onChange?: (entry: ChangeEntry) => void | Promise<void>;
  /** Name of the model-facing tool. Default whats_new. */
  toolName?: string;
}

export interface ChangesCheck {
  currentVersion: string;
  /** Everything after the last version this client saw. */
  changes: ChangeEntry[];
  /** Of those, the breaking and deprecated entries that affect this client's targets. */
  notable: ChangeEntry[];
}

/** Whether an entry is one a client should surface to the user. */
export function isNotable(entry: ChangeEntry): boolean {
  return entry.breaking || entry.type === "deprecated" || entry.type === "removed";
}

/** The unread changes count a result carries, in _meta or in the text line. 0 when none. */
export function changesCount(result: { content?: unknown[]; _meta?: Record<string, unknown> }, extensionId: string): number {
  const fromMeta = (result._meta?.[extensionId] as { changes?: unknown } | undefined)?.changes;
  if (typeof fromMeta === "number") return fromMeta;
  for (const c of result.content ?? []) {
    const text = (c as { type?: string; text?: unknown }).text;
    if ((c as { type?: string }).type !== "text" || typeof text !== "string") continue;
    const match = CHANGES_NOTICE_LINE.exec(text);
    if (match) return Number(match[1]);
  }
  return 0;
}

export class ChangesFeed {
  private readonly client: Client;
  private readonly options: ChangesFeedOptions;
  private readonly ledger: ChangesLedger;

  constructor(client: Client, options: ChangesFeedOptions) {
    this.client = client;
    this.options = options;
    this.ledger = options.ledger ?? new MemoryChangesLedger();
  }

  /** True when the server advertises the extension with changes: true. */
  available(): boolean {
    const extensions = (this.client.getServerCapabilities() as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    const settings = extensions?.[this.options.extensionId] as ServerSettings | undefined;
    return Boolean(settings && Array.isArray(settings.kinds) && settings.changes === true);
  }

  /** One page of changeRequests/changes. */
  async read(query: ChangesQuery = {}): Promise<ChangesPage> {
    if (!this.available()) throw new Error("This server does not offer the changes feed.");
    const params: Record<string, unknown> = { ...query };
    if (this.advertise()) {
      params._meta = { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [this.options.extensionId]: {} } } };
    }
    return (await this.client.request({ method: "changeRequests/changes", params } as never, ResultSchema)) as unknown as ChangesPage;
  }

  /**
   * Reads everything after the last version this client saw, records the notable
   * entries in the ledger, calls onChange for each, and moves lastVersion forward.
   */
  async check(): Promise<ChangesCheck> {
    const before = this.ledger.load();
    const changes: ChangeEntry[] = [];
    let currentVersion = before.lastVersion ?? "";
    let cursor: string | undefined;
    do {
      const query: ChangesQuery = before.lastVersion ? { sinceVersion: before.lastVersion } : {};
      if (cursor) query.cursor = cursor;
      const page = await this.read(query);
      changes.push(...page.changes);
      currentVersion = page.currentVersion;
      cursor = page.nextCursor;
    } while (cursor);

    const watched = this.targets();
    const affects = (e: ChangeEntry) =>
      !watched || !e.changed?.length || e.changed.some((t) => t.type === "server" || (t.name !== undefined && watched.includes(t.name)));
    const key = (e: ChangeEntry) => `${e.version}|${e.type}|${e.summary}`;
    const known = new Set(before.notices.map(key));
    const notable = changes.filter((e) => isNotable(e) && affects(e) && !known.has(key(e)));

    const after = this.ledger.load();
    after.notices = [...notable, ...after.notices];
    if (currentVersion) after.lastVersion = currentVersion;
    this.ledger.save(after);
    for (const entry of notable) await this.options.onChange?.(entry);
    return { currentVersion, changes, notable };
  }

  /** Breaking and deprecated entries recorded so far, for the user or a later session. */
  notices(): ChangeEntry[] {
    return this.ledger.load().notices;
  }

  /** Looks at any result; when it announces unread changes, runs check(). */
  async inspect(result: { content?: unknown[]; _meta?: Record<string, unknown> }): Promise<ChangesCheck | null> {
    if (!this.available() || changesCount(result, this.options.extensionId) === 0) return null;
    return this.check();
  }

  /** The one tool to show the model. Its description is the client's. */
  tool(): { name: string; description: string; inputSchema: Record<string, unknown> } {
    const server = this.options.serverName ?? "this server";
    return {
      name: this.options.toolName ?? "whats_new",
      description: `What ${server} has shipped since a version or time: additions, changed behavior, deprecations, and removals, newest first. Entries marked breaking can make a call that worked before fail.`,
      inputSchema: {
        type: "object",
        properties: {
          sinceVersion: { type: "string", description: "Only changes after this version." },
          since: { type: "string", description: "Only changes after this ISO 8601 time." },
          cursor: { type: "string", description: "nextCursor from the previous page." },
        },
      },
    };
  }

  /** Runs the tool for the model. Server text is passed through as data. */
  async callTool(args: Record<string, unknown>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    try {
      const query: ChangesQuery = {};
      if (typeof args.sinceVersion === "string") query.sinceVersion = args.sinceVersion;
      if (typeof args.since === "string") query.since = args.since;
      if (typeof args.cursor === "string") query.cursor = args.cursor;
      const page = await this.read(query);
      const lines = [`Current version: ${page.currentVersion}.`];
      for (const c of page.changes) {
        const flags = [c.breaking ? "breaking" : "", c.removeAfter ? `removal after ${c.removeAfter}` : ""].filter(Boolean).join(", ");
        lines.push(`- ${c.version} ${c.type}${flags ? ` (${flags})` : ""}: ${c.summary}`);
      }
      if (page.changes.length === 0) lines.push("No changes listed.");
      if (page.nextCursor) lines.push(`More after cursor ${page.nextCursor}.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Could not read the changes: ${error instanceof Error ? error.message : "unknown error"}` }], isError: true };
    }
  }

  private advertise(): boolean {
    if (this.options.ephemeral) return false;
    const c = this.options.consent;
    return typeof c === "function" ? c() === true : c === true;
  }

  private targets(): string[] | undefined {
    const t = this.options.targets;
    return typeof t === "function" ? t() : t;
  }
}
