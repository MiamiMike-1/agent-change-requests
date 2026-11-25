/**
 * What the client remembers about its own requests, so a later session can find
 * them (SEP sections 7 and 11): the acceptance tests it sent (the server never returns
 * them), the workaround it is relying on, the last status it saw, and the daily count
 * behind the submission cap. Nothing in it is sent to the server.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AcceptanceTest, Status, Target } from "./types.js";

export interface LedgerEntry {
  requestId: string;
  title: string;
  target?: Target;
  acceptanceTests?: AcceptanceTest[];
  /** The workaround this client uses until the request ships. */
  workaround?: string;
  status: Status;
  submittedAt: string;
  updatedAt: string;
  /** Set when the server says the change shipped and the workaround is no longer needed. */
  workaroundObsolete?: boolean;
  /** For a request filed without a signed-in principal: the ticket that reads it. A credential; never shown to the model. */
  ticket?: string;
  /** The client's own verdict, once it has re-run its tests. */
  confirmed?: "pass" | "fail";
}

export interface LedgerData {
  requests: Record<string, LedgerEntry>;
  /** Submissions per UTC day, for the client-side cap. */
  submissions: Record<string, number>;
}

export interface Ledger {
  load(): LedgerData;
  save(data: LedgerData): void;
}

function empty(): LedgerData {
  return { requests: {}, submissions: {} };
}

export class MemoryLedger implements Ledger {
  private data: LedgerData = empty();
  load(): LedgerData {
    return structuredClone(this.data);
  }
  save(data: LedgerData): void {
    this.data = structuredClone(data);
  }
}

/** A ledger in one JSON file per server, for clients whose sessions come and go. */
export class FileLedger implements Ledger {
  constructor(private readonly path: string) {}

  load(): LedgerData {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LedgerData>;
      return { requests: parsed.requests ?? {}, submissions: parsed.submissions ?? {} };
    } catch {
      return empty();
    }
  }

  save(data: LedgerData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
