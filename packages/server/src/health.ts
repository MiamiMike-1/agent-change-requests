/**
 * A health check that needs no credential: is the server up, and can it reach
 * the store its change requests live in?
 *
 * Without it, the only way to learn that a deployed server cannot reach its
 * database is to sign in and call a tool. This is meant for the one route a
 * server leaves open, so the answer is a fixed shape: never a record, a count,
 * or the text of an error, because anyone can ask.
 */
import type { ChangeRequestStore } from "./store.js";

export type StoreHealth = "reachable" | "unreachable";

export interface HealthReport {
  /** True only when the store answered. */
  ok: boolean;
  store: StoreHealth;
  /** The extension identifier, when the server gave one. */
  extension?: string;
  /** The server's own version, when the server gave one. */
  version?: string;
}

export interface HealthOptions {
  store: ChangeRequestStore;
  extensionId?: string;
  /** The server's version. Leave it out to keep the version private. */
  version?: string;
  /** How long to wait for the store. Default 3000 ms. */
  timeoutMs?: number;
  /** Told why the store did not answer. The reason never goes in the report. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_HEALTH_TIMEOUT_MS = 3000;
/** An id no real request has. Reading it proves the store answers and returns nothing. */
export const HEALTH_PROBE_REQUEST_ID = "health-probe";

/** Asks the store one question that returns no data, and reports whether it answered in time. */
export async function checkHealth(options: HealthOptions): Promise<HealthReport> {
  const { store } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  let state: StoreHealth = "reachable";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // An async wrapper, so a store that throws synchronously is caught as well.
      (async () => (store.ping ? store.ping() : store.get(HEALTH_PROBE_REQUEST_ID)))(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`store did not answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    state = "unreachable";
    try {
      options.onError?.(error);
    } catch {
      // A failing logger must not change the report.
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const report: HealthReport = { ok: state === "reachable", store: state };
  if (options.extensionId) report.extension = options.extensionId;
  if (options.version) report.version = options.version;
  return report;
}

/**
 * True for GET or HEAD on a path ending in /health. Use it to send that one
 * route to healthResponse() before the server checks credentials.
 */
export function isHealthRequest(request: { method: string; url: string }, path = "/health"): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    return false;
  }
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === path || trimmed.endsWith(path);
}

/**
 * The report as a web-standard Response: 200 when the store answered, 503 when
 * it did not, so an uptime checker can go by the status alone.
 */
export async function healthResponse(options: HealthOptions & { method?: string }): Promise<Response> {
  const report = await checkHealth(options);
  return new Response(options.method === "HEAD" ? null : JSON.stringify(report), {
    status: report.ok ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
