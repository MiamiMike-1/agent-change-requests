import type { ChangeRequestRecord, Gap, ListQuery, Page } from "./types.js";

/**
 * Where an app keeps its change requests. Implement this once per database.
 * migrations/postgres.sql has a schema that fits it. Run the conformance suite in
 * "@agent-change-requests/server/testing" against your implementation.
 */
export interface ChangeRequestStore {
  /** Store a new record. Must fail if (principal, idempotencyKey) already exists. */
  insert(record: ChangeRequestRecord): Promise<void>;
  /** Replace a stored record by requestId. */
  update(record: ChangeRequestRecord): Promise<void>;
  get(requestId: string): Promise<ChangeRequestRecord | null>;
  findByIdempotencyKey(principal: string, idempotencyKey: string): Promise<ChangeRequestRecord | null>;
  /**
   * The given principal's records, newest updatedAt first (ties by requestId),
   * or every principal's records when principal is null (for the builder side).
   */
  list(principal: string | null, query: ListQuery): Promise<Page<ChangeRequestRecord>>;
  /** How many requests this principal submitted at or after the given time. */
  countSubmittedSince(principal: string, since: string): Promise<number>;
  /** createdAt of this principal's oldest request at or after the given time, if any. */
  oldestSubmittedSince(principal: string, since: string): Promise<string | null>;
  countUnread(principal: string): Promise<number>;
  insertGap(gap: Gap): Promise<void>;
  listGaps(principal: string | null, since?: string): Promise<Gap[]>;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 50;

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    return typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

/** An in-memory store, for tests and demos. Not for production. */
export class MemoryStore implements ChangeRequestStore {
  private readonly records = new Map<string, ChangeRequestRecord>();
  private readonly gaps: Gap[] = [];

  async insert(record: ChangeRequestRecord): Promise<void> {
    if (this.records.has(record.requestId)) throw new Error("requestId already exists");
    if (await this.findByIdempotencyKey(record.principal, record.idempotencyKey)) {
      throw new Error("idempotencyKey already exists for this principal");
    }
    this.records.set(record.requestId, structuredClone(record));
  }

  async update(record: ChangeRequestRecord): Promise<void> {
    if (!this.records.has(record.requestId)) throw new Error("requestId not found");
    this.records.set(record.requestId, structuredClone(record));
  }

  async get(requestId: string): Promise<ChangeRequestRecord | null> {
    const found = this.records.get(requestId);
    return found ? structuredClone(found) : null;
  }

  async findByIdempotencyKey(principal: string, idempotencyKey: string): Promise<ChangeRequestRecord | null> {
    for (const r of this.records.values()) {
      if (r.principal === principal && r.idempotencyKey === idempotencyKey) return structuredClone(r);
    }
    return null;
  }

  async list(principal: string | null, query: ListQuery): Promise<Page<ChangeRequestRecord>> {
    const since = query.updatedSince ? Date.parse(query.updatedSince) : undefined;
    const matching = [...this.records.values()]
      .filter((r) => principal === null || r.principal === principal)
      .filter((r) => !query.status || query.status.includes(r.status))
      .filter((r) => !query.about || r.about === query.about)
      .filter((r) => since === undefined || Date.parse(r.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.requestId.localeCompare(b.requestId));
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = decodeCursor(query.cursor);
    const items = matching.slice(offset, offset + limit).map((r) => structuredClone(r));
    const next = offset + limit;
    return next < matching.length ? { items, nextCursor: encodeCursor(next) } : { items };
  }

  async countSubmittedSince(principal: string, since: string): Promise<number> {
    const t = Date.parse(since);
    return [...this.records.values()].filter((r) => r.principal === principal && Date.parse(r.createdAt) >= t).length;
  }

  async oldestSubmittedSince(principal: string, since: string): Promise<string | null> {
    const t = Date.parse(since);
    const times = [...this.records.values()]
      .filter((r) => r.principal === principal && Date.parse(r.createdAt) >= t)
      .map((r) => r.createdAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    return times[0] ?? null;
  }

  async countUnread(principal: string): Promise<number> {
    return [...this.records.values()].filter((r) => r.principal === principal && r.unread).length;
  }

  async insertGap(gap: Gap): Promise<void> {
    this.gaps.push({ ...gap });
  }

  async listGaps(principal: string | null, since?: string): Promise<Gap[]> {
    const t = since ? Date.parse(since) : undefined;
    return this.gaps
      .filter((g) => principal === null || g.principal === principal)
      .filter((g) => t === undefined || Date.parse(g.at) >= t)
      .map((g) => ({ ...g }));
  }
}
