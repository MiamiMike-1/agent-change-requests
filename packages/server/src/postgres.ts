/**
 * A ChangeRequestStore and ChangeFeedStore on Postgres (Supabase included), for the
 * tables in migrations/postgres.sql. It is driver-agnostic: pass a function that runs
 * one parameterized query and returns its rows.
 */
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, decodeCursor, encodeCursor, type ChangeFeedStore, type ChangeRequestStore } from "./store.js";
import type { ChangeRecord, ChangeRequestRecord, FeedReader, Gap, ListQuery, Page } from "./types.js";

/**
 * Runs one query with $1-style parameters and returns its rows.
 * With node-postgres: (text, params) => pool.query(text, params).then((r) => r.rows).
 * With postgres.js: (text, params) => sql.unsafe(text, params).
 */
export type PgQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

function iso(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`Not an ISO 8601 time: ${value}`);
  return value;
}

/** Drivers return jsonb parsed or as text, depending on their type settings. */
function parse<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export class PostgresStore implements ChangeRequestStore, ChangeFeedStore {
  private readonly query: PgQuery;

  constructor(query: PgQuery) {
    if (typeof query !== "function") throw new Error("PostgresStore needs a query function.");
    this.query = query;
  }

  async insert(record: ChangeRequestRecord): Promise<void> {
    await this.query(
      `insert into acr_change_requests
         (request_id, principal, idempotency_key, status, about, unread, revision, created_at, updated_at, record)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb)`,
      [
        record.requestId,
        record.principal,
        record.idempotencyKey,
        record.status,
        record.about,
        record.unread,
        record.revision,
        iso(record.createdAt),
        iso(record.updatedAt),
        JSON.stringify(record),
      ],
    );
  }

  async update(record: ChangeRequestRecord, expectedRevision: number): Promise<boolean> {
    const changed = await this.query(
      `update acr_change_requests
          set status = $1, about = $2, unread = $3, revision = $4, updated_at = $5::timestamptz, record = $6::jsonb
        where request_id = $7 and revision = $8
        returning request_id`,
      [
        record.status,
        record.about,
        record.unread,
        record.revision,
        iso(record.updatedAt),
        JSON.stringify(record),
        record.requestId,
        expectedRevision,
      ],
    );
    if (changed.length === 1) return true;
    const exists = await this.query("select 1 as found from acr_change_requests where request_id = $1", [record.requestId]);
    if (exists.length === 0) throw new Error("requestId not found");
    return false;
  }

  async get(requestId: string): Promise<ChangeRequestRecord | null> {
    const rows = await this.query("select record from acr_change_requests where request_id = $1", [requestId]);
    return rows[0] ? parse<ChangeRequestRecord>(rows[0].record) : null;
  }

  async findByIdempotencyKey(principal: string, idempotencyKey: string): Promise<ChangeRequestRecord | null> {
    const rows = await this.query(
      "select record from acr_change_requests where principal = $1 and idempotency_key = $2",
      [principal, idempotencyKey],
    );
    return rows[0] ? parse<ChangeRequestRecord>(rows[0].record) : null;
  }

  async list(principal: string | null, query: ListQuery): Promise<Page<ChangeRequestRecord>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(clause(params.length));
    };
    if (principal !== null) add((n) => `principal = $${n}`, principal);
    if (query.status) {
      if (query.status.length === 0) return { items: [] };
      // One placeholder per status: drivers disagree on how to send an array parameter.
      const first = params.length + 1;
      params.push(...query.status);
      where.push(`status in (${query.status.map((_, i) => `$${first + i}`).join(", ")})`);
    }
    if (query.about) add((n) => `about = $${n}`, query.about);
    if (query.updatedSince) add((n) => `updated_at >= $${n}::timestamptz`, iso(query.updatedSince));
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = decodeCursor(query.cursor);
    params.push(limit + 1, offset);
    const rows = await this.query(
      `select record from acr_change_requests
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by updated_at desc, request_id asc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit).map((r) => parse<ChangeRequestRecord>(r.record));
    return rows.length > limit ? { items, nextCursor: encodeCursor(offset + limit) } : { items };
  }

  async countSubmittedSince(principal: string, since: string): Promise<number> {
    const rows = await this.query(
      "select count(*)::int as n from acr_change_requests where principal = $1 and created_at >= $2::timestamptz",
      [principal, iso(since)],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async oldestSubmittedSince(principal: string, since: string): Promise<string | null> {
    const rows = await this.query(
      `select record->>'createdAt' as created_at from acr_change_requests
        where principal = $1 and created_at >= $2::timestamptz
        order by created_at asc limit 1`,
      [principal, iso(since)],
    );
    return rows[0] ? String(rows[0].created_at) : null;
  }

  async countUnread(principal: string): Promise<number> {
    const rows = await this.query(
      "select count(*)::int as n from acr_change_requests where principal = $1 and unread",
      [principal],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async insertGap(gap: Gap): Promise<void> {
    await this.query("insert into acr_gaps (principal, target, reason, at) values ($1, $2, $3, $4::timestamptz)", [
      gap.principal,
      gap.target,
      gap.reason,
      iso(gap.at),
    ]);
  }

  async listGaps(principal: string | null, since?: string): Promise<Gap[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (principal !== null) {
      params.push(principal);
      where.push(`principal = $${params.length}`);
    }
    if (since) {
      params.push(iso(since));
      where.push(`at >= $${params.length}::timestamptz`);
    }
    const rows = await this.query(
      `select principal, target, reason,
              to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
         from acr_gaps
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by id asc`,
      params,
    );
    return rows.map((g) => ({
      principal: String(g.principal),
      target: String(g.target),
      reason: String(g.reason),
      at: String(g.at),
    }));
  }

  async ping(): Promise<void> {
    await this.query("select 1 as ok from acr_change_requests limit 0", []);
  }

  async appendChange(change: Omit<ChangeRecord, "seq">): Promise<ChangeRecord> {
    const rows = await this.query(
      "insert into acr_change_feed (change_id, record) values ($1, $2::jsonb) returning seq",
      [change.changeId, JSON.stringify(change)],
    );
    return { ...change, seq: Number(rows[0]?.seq) };
  }

  async listChanges(afterSeq = 0): Promise<ChangeRecord[]> {
    const rows = await this.query("select seq, record from acr_change_feed where seq > $1 order by seq desc", [afterSeq]);
    return rows.map((r) => ({ ...parse<Omit<ChangeRecord, "seq">>(r.record), seq: Number(r.seq) }));
  }

  async getReader(principal: string): Promise<FeedReader | null> {
    const rows = await this.query(
      "select principal, seen_seq, muted from acr_change_feed_readers where principal = $1",
      [principal],
    );
    const row = rows[0];
    return row ? { principal: String(row.principal), seenSeq: Number(row.seen_seq), muted: row.muted === true } : null;
  }

  async putReader(reader: FeedReader): Promise<void> {
    await this.query(
      `insert into acr_change_feed_readers (principal, seen_seq, muted) values ($1, $2, $3)
       on conflict (principal) do update set seen_seq = excluded.seen_seq, muted = excluded.muted`,
      [reader.principal, reader.seenSeq, reader.muted],
    );
  }
}
