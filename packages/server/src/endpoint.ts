/**
 * Reaches a change requests endpoint over Streamable HTTP, for ChangeRequestsEndpointSink.
 * Kept apart from "./upstream" so that file needs no MCP SDK.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamCall } from "./upstream.js";

export interface EndpointCallerOptions {
  /** The identifier the endpoint uses for the change requests extension. */
  extensionId: string;
  /** How this server names itself to the endpoint. Default "change-requests-relay". */
  clientName?: string;
  clientVersion?: string;
}

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/**
 * Returns a function that sends one request to the endpoint at url. It connects on the
 * first call, sends no credential, and connects again after a failure.
 */
export function endpointCaller(url: string | URL, options: EndpointCallerOptions): UpstreamCall {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    throw new Error("The endpoint must use https.");
  }
  let connected: Promise<Client> | undefined;
  const connect = () => {
    connected ??= (async () => {
      const client = new Client({ name: options.clientName ?? "change-requests-relay", version: options.clientVersion ?? "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(target));
      return client;
    })();
    return connected;
  };
  return async (method, params) => {
    try {
      const client = await connect();
      const withMeta = { ...params, _meta: { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [options.extensionId]: {} } } } };
      return (await client.request({ method, params: withMeta } as never, ResultSchema)) as Record<string, unknown>;
    } catch (error) {
      connected = undefined;
      throw error;
    }
  };
}
