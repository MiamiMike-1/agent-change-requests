/**
 * Protocol middleware for McpServer from @modelcontextprotocol/sdk.
 *
 * installChangeRequests() adds the extension to an existing server in one call:
 * - advertises it under capabilities.extensions (SEP section 1),
 * - answers changeRequests/submit, /get, /list, /withdraw, /confirm, and /changes (section 2),
 * - accepts anonymous callers with tickets, when turned on (section 3),
 * - stores requests in SQLite (or any ChangeRequestStore), with idempotency keys,
 * - keeps the principal-scoped inbox and puts the update notice on every tool result (section 7),
 * - keeps the changes feed and its notice (section 12),
 * - publishes changeRequest.updated on every status change, through the server's
 *   Events implementation (section 8),
 * - keeps the change_requests_* tools for clients that do not implement the extension,
 *   and hides the submit tool from clients that do (Backward Compatibility).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isChangeRequestError } from "./errors.js";
import { registerChangeRequestTools, withUpdateNotice, type CallInfo, type McpAdapterOptions } from "./mcp.js";
import { noticeMeta } from "./notice.js";
import { ANONYMOUS_PRINCIPAL, ChangeRequestService, type ServiceOptions } from "./service.js";
import { SqliteStore } from "./sqlite.js";
import type { ChangeRequestStore } from "./store.js";
import { STATUSES, type Kind, type StatusObject } from "./types.js";

/** The per-request _meta key a client uses to advertise extensions (SEP section 1). */
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** The event type name from SEP section 8. */
export const CHANGE_REQUEST_UPDATED = "changeRequest.updated";

export const METHODS = {
  submit: "changeRequests/submit",
  get: "changeRequests/get",
  list: "changeRequests/list",
  withdraw: "changeRequests/withdraw",
  confirm: "changeRequests/confirm",
  changes: "changeRequests/changes",
} as const;

/** The server settings object from SEP section 1. */
export interface ServerExtensionSettings {
  kinds: Kind[];
  acceptanceTests: boolean;
  events: boolean;
  anonymous: boolean;
  policyUri?: string;
  changelogUri?: string;
  changes: boolean;
}

/** One changeRequest.updated event, for the server's Events implementation to deliver. */
export interface StatusEvent {
  type: typeof CHANGE_REQUEST_UPDATED;
  /** Deliver only to subscriptions this principal holds. */
  principal: string;
  requestId: string;
  /** The status object from SEP section 6. */
  payload: StatusObject;
  at: string;
}

/**
 * The event type to list in events/list (SEP-3415), with the status object as its
 * payload schema and an optional requestId filter.
 */
export const changeRequestUpdatedEventType = {
  name: CHANGE_REQUEST_UPDATED,
  description: "A change request you submitted changed status.",
  inputSchema: {
    type: "object",
    properties: { requestId: { type: "string", description: "Only this request." } },
  },
  payloadSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      status: { type: "string", enum: [...STATUSES] },
      updatedAt: { type: "string" },
      demand: { type: "integer" },
      message: { type: "string" },
      resolution: { type: "object" },
      confirmation: { type: "object" },
    },
    required: ["requestId", "status", "updatedAt", "demand"],
  },
} as const;

export interface ChangeRequestsOptions extends Omit<ServiceOptions, "store"> {
  /** The app's name, used in tool descriptions and the notice line. */
  appName: string;
  /** A vendor-prefixed identifier until the official one is approved, e.g. "com.example/change-requests". */
  extensionId: string;
  /** The authenticated user or account for a call, or null. Never a session id or an OAuth client id. */
  getPrincipal: McpAdapterOptions["getPrincipal"];
  /**
   * Where requests are kept: a SQLite file path, or any ChangeRequestStore.
   * Ignored when service is given.
   */
  store?: string | ChangeRequestStore;
  /** An existing service to use instead of building one from store. */
  service?: ChangeRequestService;
  policyUri?: string;
  /** A page listing shipped changes. Recommended when the changes feed is on (SEP section 12). */
  changelogUri?: string;
  /**
   * Hand status events to the server's Events extension. Setting this advertises
   * events: true, and the server must then list changeRequestUpdatedEventType in events/list.
   */
  publishEvent?: (event: StatusEvent) => void | Promise<void>;
  /** Register the change_requests_* tools for clients without the extension. Default true. */
  legacyTools?: boolean;
  /** Add the update notice to every tool registered after this call. Default true. */
  noticeOnAllTools?: boolean;
  /** Extra text for the legacy submit tool's description. */
  submitGuidance?: string;
  timeZone?: string;
}

export interface InstalledChangeRequests {
  service: ChangeRequestService;
  settings: ServerExtensionSettings;
  /** Wraps a tool handler so its results carry the update notice. Already applied when noticeOnAllTools is on. */
  withUpdateNotice: <A extends unknown[], R extends { content?: unknown[]; _meta?: Record<string, unknown> }>(
    handler: (...args: A) => Promise<R> | R,
  ) => (...args: A) => Promise<R>;
  /** Whether the connected client advertised the extension, at initialize or on this request. */
  clientSupports: (call?: { _meta?: Record<string, unknown> }) => boolean;
}

const paramsSchema = z.record(z.string(), z.unknown()).optional();
const requestSchema = <M extends string>(method: M) => z.object({ method: z.literal(method), params: paramsSchema });

function toMcpError(error: unknown): unknown {
  if (isChangeRequestError(error)) return new McpError(error.code, error.message, error.data);
  return error;
}

function withoutMeta(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const { _meta: _ignored, ...rest } = params ?? {};
  return rest;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value === "") {
    throw new McpError(-32602, `${name} is required.`, { reason: "invalid_params" });
  }
  return value;
}

/**
 * Adds the Agent Change Requests extension to an McpServer. Call it before
 * server.connect(), and before registering the app's own tools so their results
 * carry the update notice.
 */
export function installChangeRequests(server: McpServer, options: ChangeRequestsOptions): InstalledChangeRequests {
  const low = server.server;
  // The server's own version is the feed's currentVersion unless the app says otherwise.
  const serverVersion = (low as unknown as { _serverInfo?: { version?: string } })._serverInfo?.version;
  const service =
    options.service ??
    new ChangeRequestService({
      ...(serverVersion ? { currentVersion: serverVersion } : {}),
      ...options,
      store:
        options.store === undefined || typeof options.store === "string"
          ? SqliteStore.open(options.store ?? ":memory:")
          : options.store,
    });

  const settings: ServerExtensionSettings = {
    kinds: [...service.kinds],
    acceptanceTests: service.acceptanceTests,
    events: Boolean(options.publishEvent),
    anonymous: service.anonymous,
    changes: service.changesEnabled,
  };
  if (options.policyUri) settings.policyUri = options.policyUri;
  if (options.changelogUri) settings.changelogUri = options.changelogUri;

  low.registerCapabilities({ extensions: { [options.extensionId]: settings } } as never);

  const clientSupports = (call?: { _meta?: Record<string, unknown> }): boolean => {
    const fromInit = (low.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    if (fromInit?.[options.extensionId] !== undefined) return true;
    const perRequest = call?._meta?.[CLIENT_CAPABILITIES_META_KEY] as { extensions?: Record<string, unknown> } | undefined;
    return perRequest?.extensions?.[options.extensionId] !== undefined;
  };

  const adapter: McpAdapterOptions = {
    service,
    appName: options.appName,
    extensionId: options.extensionId,
    getPrincipal: options.getPrincipal,
  };
  if (options.submitGuidance) adapter.submitGuidance = options.submitGuidance;
  if (options.timeZone) adapter.timeZone = options.timeZone;
  // With no tools, there is nothing the notice lines could name: send only the _meta counts.
  if (options.legacyTools === false) adapter.metaOnly = true;

  // ---- Protocol methods ---------------------------------------------------

  const handle = <M extends string>(
    method: M,
    fn: (principal: string | null | undefined, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => {
    low.setRequestHandler(requestSchema(method), async (request, extra) => {
      try {
        const principal = await options.getPrincipal(extra as CallInfo);
        const result = await fn(principal, withoutMeta(request.params));
        const meta = noticeMeta(await service.notices(principal));
        return meta ? { ...result, _meta: { [options.extensionId]: meta } } : result;
      } catch (error) {
        throw toMcpError(error);
      }
    });
  };

  handle(METHODS.submit, async (principal, params) => ({ ...(await service.submit(principal, params)) }));
  handle(METHODS.get, async (principal, params) => {
    const ticket = params.ticket;
    if (ticket !== undefined && typeof ticket !== "string") {
      throw new McpError(-32602, "ticket must be a string.", { reason: "invalid_params" });
    }
    return { ...(await service.get(principal, stringParam(params, "requestId"), ticket)) };
  });
  handle(METHODS.list, async (principal, params) => {
    const page = await service.list(principal, params);
    return { requests: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });
  handle(METHODS.withdraw, async (principal, params) => ({
    ...(await service.withdraw(principal, stringParam(params, "requestId"))),
  }));
  handle(METHODS.confirm, async (principal, params) => ({
    ...(await service.confirm(principal, { ...params, requestId: stringParam(params, "requestId") } as never)),
  }));

  if (service.changesEnabled) {
    handle(METHODS.changes, async (principal, params) => ({ ...(await service.changes(principal, params)) }));
  }

  // ---- Status events --------------------------------------------------------

  if (options.publishEvent) {
    const publish = options.publishEvent;
    service.subscribe(async (event) => {
      if (event.type !== "status_changed" && event.type !== "withdrawn") return;
      // Anonymous requests have no principal to deliver to (SEP section 7).
      if (event.principal === ANONYMOUS_PRINCIPAL) return;
      await publish({
        type: CHANGE_REQUEST_UPDATED,
        principal: event.principal,
        requestId: event.requestId,
        payload: await service.statusOf(event.requestId),
        at: event.at,
      });
    });
  }

  // ---- Tools for clients without the extension ----------------------------

  if (options.legacyTools !== false) {
    const tools = registerChangeRequestTools(server, adapter);
    // A client with the extension shows the model its own submit tool, so the model
    // should see one way to submit. One McpServer serves one connection, so this is per client.
    const submitTool = tools["change_requests_submit"];
    const previous = low.oninitialized;
    low.oninitialized = () => {
      if (submitTool && clientSupports()) submitTool.disable();
      previous?.();
    };
  }

  if (options.noticeOnAllTools !== false) {
    const register = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => unknown) =>
      register(name, config as never, withUpdateNotice(adapter, callback as never) as never)) as typeof server.registerTool;
  }

  return {
    service,
    settings,
    withUpdateNotice: (handler) => withUpdateNotice(adapter, handler),
    clientSupports,
  };
}
