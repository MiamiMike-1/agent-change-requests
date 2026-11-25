/**
 * A ChangeRequestStore on SQLite.
 *
 * It takes any database handle with exec() and prepare(), which both node:sqlite
 * (built into Node 22.5 and later) and better-sqlite3 provide. SqliteStore.open(path)
 * opens a file with node:sqlite, so most servers need no extra dependency.
 */
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  type ChangeFeedStore,
  type ChangeRequestStore,
} from "./store.js";
import type { ChangeRecord, ChangeRequestRecord, FeedReader, Gap, ListQuery, Page } from "./types.js";

/** The part of a SQLite statement this store uses. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The part of a SQLite database handle this store uses. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS change_requests (
  request_id      TEXT PRIMARY KEY,
  principal       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL,
  about           TEXT NOT NULL,
  unread          INTEGER NOT NULL,
  revision        INTEGER NOT NULL,
  created_ms      INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_ms      INTEGER NOT NULL,
  record          TEXT NOT NULL,
  UNIQUE (principal, idempotency_key)
);
CREATE INDEX IF NOT EXISTS change_requests_inbox ON change_requests (principal, updated_ms DESC, request_id);
CREATE INDEX IF NOT EXISTS change_requests_unread ON change_requests (principal, unread);
CREATE TABLE IF NOT EXISTS change_request_gaps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  principal TEXT NOT NULL,
  target    TEXT NOT NULL,
  reason    TEXT NOT NULL,
  at        TEXT NOT NULL,
  at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS change_request_gaps_principal ON change_request_gaps (principal, at_ms);
CREATE TABLE IF NOT EXISTS change_feed (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  record    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_feed_readers (
  principal TEXT PRIMARY KEY,
  seen_seq  INTEGER NOT NULL,
  muted     INTEGER NOT NULL
);
`;

interface Row {
  record: string;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Not an ISO 8601 time: ${iso}`);
  return t;
}

export class SqliteStore implements ChangeRequestStore, ChangeFeedStore {
  private readonly db: SqliteDatabase;

  /** Wraps an open database and creates the tables if they are missing. */
  constructor(db: SqliteDatabase) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /**
   * Opens (or creates) a SQLite file with node:sqlite. Pass ":memory:" for a
   * throwaway database. Needs Node 22.5 or later.
   */
  static open(path: string): SqliteStore {
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | { DatabaseSync: new (path: string) => SqliteDatabase }
      | undefined;
    if (!sqlite) {
      throw new Error("node:sqlite needs Node 22.5 or later. Pass a better-sqlite3 database to new SqliteStore() instead.");
    }
    const db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    return new SqliteStore(db);
  }

  async insert(record: ChangeRequestRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO change_requests
          (request_id, principal, idempotency_key, status, about, unread, revision, created_ms, created_at, updated_ms, record)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.requestId,
        record.principal,
        record.idempotencyKey,
        record.status,
        record.about,
        record.unread ? 1 : 0,
        record.revision,
        ms(record.createdAt),
        record.createdAt,
        ms(record.updatedAt),
        JSON.stringify(record),
      );
  }

  async update(record: ChangeRequestRecord, expectedRevision: number): Promise<boolean> {
    const exists = this.db.prepare("SELECT 1 AS found FROM change_requests WHERE request_id = ?").get(record.requestId);
    if (!exists) throw new Error("requestId not found");
    const result = this.db
      .prepare(
        `UPDATE change_requests
            SET status = ?, about = ?, unread = ?, revision = ?, updated_ms = ?, record = ?
          WHERE request_id = ? AND revision = ?`,
      )
      .run(
        record.status,
        record.about,
        record.unread ? 1 : 0,
        record.revision,
        ms(record.updatedAt),
        JSON.stringify(record),
        record.requestId,
        expectedRevision,
      );
    return Number(result.changes) === 1;
  }

  async get(requestId: string): Promise<ChangeRequestRecord | null> {
    const row = this.db.prepare("SELECT record FROM change_requests WHERE request_id = ?").get(requestId) as Row | undefined;
    return row ? (JSON.parse(row.record) as ChangeRequestRecord) : null;
  }

  async findByIdempotencyKey(principal: string, idempotencyKey: string): Promise<ChangeRequestRecord | null> {
    const row = this.db
      .prepare("SELECT record FROM change_requests WHERE principal = ? AND idempotency_key = ?")
      .get(principal, idempotencyKey) as Row | undefined;
    return row ? (JSON.parse(row.record) as ChangeRequestRecord) : null;
  }

  async list(principal: string | null, query: ListQuery): Promise<Page<ChangeRequestRecord>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (principal !== null) {
      where.push("principal = ?");
      params.push(principal);
    }
    if (query.status) {
      if (query.status.length === 0) return { items: [] };
      where.push(`status IN (${query.status.map(() => "?").join(", ")})`);
      params.push(...query.status);
    }
    if (query.about) {
      where.push("about = ?");
      params.push(query.about);
    }
    if (query.updatedSince) {
      where.push("updated_ms >= ?");
      params.push(ms(query.updatedSince));
    }
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = decodeCursor(query.cursor);
    const rows = this.db
      .prepare(
        `SELECT record FROM change_requests
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY updated_ms DESC, request_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset) as Row[];
    const items = rows.slice(0, limit).map((r) => JSON.parse(r.record) as ChangeRequestRecord);
    return rows.length > limit ? { items, nextCursor: encodeCursor(offset + limit) } : { items };
  }

  async countSubmittedSince(principal: string, since: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM change_requests WHERE principal = ? AND created_ms >= ?")
      .get(principal, ms(since)) as { n: number | bigint };
    return Number(row.n);
  }

  async oldestSubmittedSince(principal: string, since: string): Promise<string | null> {
    const row = this.db
      .prepare(
        "SELECT created_at FROM change_requests WHERE principal = ? AND created_ms >= ? ORDER BY created_ms ASC LIMIT 1",
      )
      .get(principal, ms(since)) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  async countUnread(principal: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM change_requests WHERE principal = ? AND unread = 1")
      .get(principal) as { n: number | bigint };
    return Number(row.n);
  }

  async insertGap(gap: Gap): Promise<void> {
    this.db
      .prepare("INSERT INTO change_request_gaps (principal, target, reason, at, at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(gap.principal, gap.target, gap.reason, gap.at, ms(gap.at));
  }

  async listGaps(principal: string | null, since?: string): Promise<Gap[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (principal !== null) {
      where.push("principal = ?");
      params.push(principal);
    }
    if (since) {
      where.push("at_ms >= ?");
      params.push(ms(since));
    }
    const rows = this.db
      .prepare(
        `SELECT principal, target, reason, at FROM change_request_gaps
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY id ASC`,
      )
      .all(...params) as Gap[];
    return rows.map((g) => ({ principal: g.principal, target: g.target, reason: g.reason, at: g.at }));
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1 AS ok").get();
  }

  async appendChange(change: Omit<ChangeRecord, "seq">): Promise<ChangeRecord> {
    const result = this.db
      .prepare("INSERT INTO change_feed (change_id, record) VALUES (?, ?)")
      .run(change.changeId, JSON.stringify(change)) as { changes: number | bigint; lastInsertRowid?: number | bigint };
    let seq = result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid);
    if (seq === undefined) {
      const row = this.db.prepare("SELECT seq FROM change_feed WHERE change_id = ?").get(change.changeId) as { seq: number | bigint };
      seq = Number(row.seq);
    }
    return { ...change, seq };
  }

  async listChanges(afterSeq = 0): Promise<ChangeRecord[]> {
    const rows = this.db
      .prepare("SELECT seq, record FROM change_feed WHERE seq > ? ORDER BY seq DESC")
      .all(afterSeq) as { seq: number | bigint; record: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.record) as Omit<ChangeRecord, "seq">), seq: Number(r.seq) }));
  }

  async getReader(principal: string): Promise<FeedReader | null> {
    const row = this.db
      .prepare("SELECT principal, seen_seq, muted FROM change_feed_readers WHERE principal = ?")
      .get(principal) as { principal: string; seen_seq: number | bigint; muted: number | bigint } | undefined;
    return row ? { principal: row.principal, seenSeq: Number(row.seen_seq), muted: Number(row.muted) === 1 } : null;
  }

  async putReader(reader: FeedReader): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO change_feed_readers (principal, seen_seq, muted) VALUES (?, ?, ?)
         ON CONFLICT (principal) DO UPDATE SET seen_seq = excluded.seen_seq, muted = excluded.muted`,
      )
      .run(reader.principal, reader.seenSeq, reader.muted ? 1 : 0);
  }
}
