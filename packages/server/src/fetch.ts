/**
 * The extension as one web-standard request handler: (Request) => Promise<Response>.
 * It runs wherever fetch handlers do, such as Deno, Supabase Edge Functions,
 * Cloudflare Workers, Bun, and Node 18 or later, with no process to keep alive.
 * Each request gets its own server and a stateless transport, so all state is in the store.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { installChangeRequests, type ChangeRequestsOptions, type InstalledChangeRequests } from "./middleware.js";
import { ChangeRequestService } from "./service.js";
import type { ChangeRequestStore } from "./store.js";

export interface ChangeRequestsFetchOptions extends Omit<ChangeRequestsOptions, "store" | "service"> {
  /** Where requests are kept. A database store, since nothing in memory outlives a request. */
  store: ChangeRequestStore;
  /** The MCP server's name and version. Default: appName and "1.0.0". */
  serverInfo?: { name: string; version: string };
  /** Register the app's own tools on each request's server, after the extension is installed. */
  configure?: (server: McpServer, installed: InstalledChangeRequests) => void;
  /** The largest request body accepted, in bytes. Default 65536. Larger bodies get 413. */
  maxBodyBytes?: number;
  /**
   * Called before anything else. Return false to refuse the request with 429.
   * Use it for a per-address limit, which matters most when anonymous is on: the
   * shared anonymous cap bounds volume, but one caller can use it all. See rateLimiter.
   */
  allow?: (request: Request) => boolean | Promise<boolean>;
}

function refuse(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RateLimiterOptions {
  /** Most requests one key may make per window. */
  limit: number;
  /** Window length in milliseconds. Default 60000. */
  windowMs?: number;
  /**
   * What to count by. Default: the first address in x-forwarded-for. Only trust that
   * header when your host sets it; otherwise pass your own key function.
   */
  key?: (request: Request) => string;
  now?: () => number;
}

/**
 * A fixed-window limiter kept in memory, for the allow option. On hosts that start
 * a fresh instance per request it limits little, so keep the store's caps as the backstop.
 */
export function rateLimiter(options: RateLimiterOptions): (request: Request) => boolean {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const key = options.key ?? ((r: Request) => r.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown");
  const seen = new Map<string, { start: number; count: number }>();
  return (request) => {
    const t = now();
    if (seen.size > 10_000) for (const [k, v] of seen) if (t - v.start >= windowMs) seen.delete(k);
    const k = key(request);
    const entry = seen.get(k);
    if (!entry || t - entry.start >= windowMs) {
      seen.set(k, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= options.limit;
  };
}

/**
 * Returns the handler and the one service behind it. Use the service for the builder
 * side: listAll, transition, publishChange, and an UpstreamRelay.
 */
export function changeRequestsFetchHandler(options: ChangeRequestsFetchOptions): {
  handler: (request: Request) => Promise<Response>;
  service: ChangeRequestService;
} {
  const { store, serverInfo, configure, maxBodyBytes = 65_536, allow, ...rest } = options;
  const info = serverInfo ?? { name: options.appName, version: "1.0.0" };
  const service = new ChangeRequestService({ ...rest, store, currentVersion: rest.currentVersion ?? info.version });

  const handler = async (incoming: Request): Promise<Response> => {
    if (allow && !(await allow(incoming))) return refuse(429, "Too many requests. Try again later.");
    let request = incoming;
    if (incoming.method === "POST") {
      const declared = Number(incoming.headers.get("content-length") ?? 0);
      if (declared > maxBodyBytes) return refuse(413, "Request body too large.");
      const body = await incoming.arrayBuffer();
      if (body.byteLength > maxBodyBytes) return refuse(413, "Request body too large.");
      request = new Request(incoming.url, { method: "POST", headers: incoming.headers, body });
    }
    const server = new McpServer(info);
    const installed = installChangeRequests(server, { ...rest, service });
    configure?.(server, installed);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
  return { handler, service };
}
