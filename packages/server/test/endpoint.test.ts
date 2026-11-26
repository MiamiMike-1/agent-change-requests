import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { endpointCaller } from "../src/endpoint.js";
import { installChangeRequests } from "../src/middleware.js";
import { MemoryStore } from "../src/store.js";
import { ChangeRequestsEndpointSink } from "../src/upstream.js";

const EXT = "com.example/change-requests";
let http: Server | undefined;

afterEach(() => {
  http?.close();
  http = undefined;
});

/** A maintainers' endpoint over real HTTP: one stateless transport per request. */
async function listen() {
  const store = new MemoryStore();
  let service: ReturnType<typeof installChangeRequests>["service"] | undefined;
  http = createServer(async (req, res) => {
    const server = new McpServer({ name: "maintainers", version: "1.0.0" });
    service = installChangeRequests(server, { appName: "Maintainers", extensionId: EXT, getPrincipal: () => null, anonymous: true, store }).service;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, service: () => service! };
}

describe("endpointCaller", () => {
  it("submits to and reads from an endpoint over HTTP with no credential", async () => {
    const { url, service } = await listen();
    const sink = new ChangeRequestsEndpointSink({ call: endpointCaller(url, { extensionId: EXT }) });
    const sent = await sink.forward({ requestId: "crq_1", kind: "friction", title: "t", description: "d", submittedAt: "2026-01-01T00:00:00Z" });
    expect(await sink.poll(sent.ref)).toEqual({ state: "open" });
    const [record] = (await service().listAll()).items;
    await service().transition(record!.requestId, { status: "declined", message: "Not now." });
    expect(await sink.poll(sent.ref)).toEqual({ state: "declined", reason: "Not now." });
  });

  it("refuses a plain http endpoint that is not local", () => {
    expect(() => endpointCaller("http://example.com/mcp", { extensionId: EXT })).toThrow(/https/);
  });
});
