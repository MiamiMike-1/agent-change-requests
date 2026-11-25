#!/usr/bin/env node
/**
 * Runs the demo server over stdio, so a real agent can use it.
 *
 *   DEMO_VERSION=1.0.0 node dist/stdio.js     the version with the gap
 *   node dist/ship.js                         the vendor ships the fix
 *   DEMO_VERSION=1.1.0 node dist/stdio.js     the fixed version
 *
 * DEMO_STORE sets the SQLite file (default demo-state/requests.db) and DEMO_PRINCIPAL
 * the user every call is made as (default demo-user).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInvoiceServer } from "./server.js";

const store = process.env.DEMO_STORE ?? "demo-state/requests.db";
mkdirSync(dirname(store), { recursive: true });
const { server } = createInvoiceServer({
  version: process.env.DEMO_VERSION ?? "1.0.0",
  store,
  principal: process.env.DEMO_PRINCIPAL ?? "demo-user",
});
await server.connect(new StdioServerTransport());
