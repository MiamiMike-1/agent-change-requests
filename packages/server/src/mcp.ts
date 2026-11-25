/**
 * MCP adapter: registers the change request tools on an McpServer from
 * @modelcontextprotocol/sdk, and adds the update notice to any tool result.
 *
 * Tools, not protocol methods: few clients implement the extension's methods yet,
 * so the tools are how agents reach it today (see SEP section 7 and Backward Compatibility).
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { ChangeRequestError, isChangeRequestError } from "./errors.js";
import { applyNotices, type NoticeOptions } from "./notice.js";
import type { ChangeRequestService } from "./service.js";
import { STATUSES, type ChangesPage } from "./types.js";

/** What the adapter needs from each tool call to work out who is calling. */
export interface CallInfo {
  authInfo?: AuthInfo;
  sessionId?: string;
}

export interface McpAdapterOptions extends NoticeOptions {
  service: ChangeRequestService;
  /**
   * Returns the authenticated principal for a call, or null when there is none.
   * Use the identity the server already authenticates (a user or account id).
   * Never return a session id: answers must outlive the session that asked.
   */
  getPrincipal: (call: CallInfo) => string | null | undefined | Promise<string | null | undefined>;
  /** Extra text for the submit tool description, for app-specific guidance. */
  submitGuidance?: string;
  /** Time zone for scorecard dates. */
  timeZone?: string;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

const testSchema = z
  .object({
    description: z.string().optional().describe("What the test shows."),
    call: z
      .object({
        method: z.enum(["tools/call", "resources/read", "prompts/get"]).describe("The MCP method."),
        params: z.record(z.string(), z.unknown()).optional().describe("Its params. Use made-up example values."),
      })
      .describe("The call you wanted to make."),
    expect: z
      .object({
        isError: z.boolean().optional().describe("Whether the call should fail."),
        structuredContentSchema: z.record(z.string(), z.unknown()).optional().describe("A JSON Schema the structured result should match."),
        textContains: z.array(z.string()).max(5).optional().describe("Strings the text result should contain."),
      })
      .optional()
      .describe("The result you expected."),
  })
  .describe("An example of the call you wanted and the result you expected. Stored as data; never run against real data.");

function ok(data: Record<string, unknown>, text?: string): ToolResult {
  return { content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }], structuredContent: data };
}

function errorResult(error: unknown): ToolResult {
  if (isChangeRequestError(error)) {
    const data = { error: { code: error.code, message: error.message, data: error.data } };
    return { content: [{ type: "text", text: `${error.message} (${error.reason})` }], structuredContent: data, isError: true };
  }
  return { content: [{ type: "text", text: "Something went wrong with the change request." }], isError: true };
}

/**
 * Wraps any tool handler of the app so its results carry the update notice.
 * Use it on the app's own tools too: that is how an agent learns a fix shipped.
 */
export function withUpdateNotice<A extends unknown[], R extends { content?: unknown[]; _meta?: Record<string, unknown> }>(
  options: Pick<McpAdapterOptions, "service" | "getPrincipal" | "appName" | "extensionId" | "listToolName" | "changesToolName" | "metaOnly">,
  handler: (...args: A) => Promise<R> | R,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const result = await handler(...args);
    // The SDK passes the request's extra info as the last argument of every tool callback.
    const call = args.at(-1) as CallInfo | undefined;
    try {
      const principal = await options.getPrincipal(call ?? {});
      return applyNotices(result, await options.service.notices(principal), options);
    } catch {
      return result;
    }
  };
}

/** Readable text for one page of the changes feed. */
export function changesText(page: ChangesPage): string {
  if (page.changes.length === 0) return `No changes listed. Current version: ${page.currentVersion}.`;
  const lines = [`Current version: ${page.currentVersion}. Newest first:`];
  for (const c of page.changes) {
    const flags = [c.breaking ? "BREAKING" : "", c.removeAfter ? `may be removed after ${c.removeAfter}` : ""].filter(Boolean).join(", ");
    const targets = c.changed?.length ? ` [${c.changed.map((t) => t.name ?? t.type).join(", ")}]` : "";
    const yours = c.changeRequestIds?.length ? ` Resolves your request ${c.changeRequestIds.join(", ")}.` : "";
    lines.push(`- ${c.version} ${c.type}${flags ? ` (${flags})` : ""}${targets}: ${c.summary}${yours}`);
  }
  if (page.nextCursor) lines.push(`More: call again with cursor ${page.nextCursor}.`);
  return lines.join("\n");
}

/** Registers change_requests_submit, _list, _get, _withdraw, _confirm, _scorecard, and whats_new when the server has a changes feed. */
export function registerChangeRequestTools(server: McpServer, options: McpAdapterOptions): Record<string, RegisteredTool> {
  const { service, appName } = options;
  const tools: Record<string, RegisteredTool> = {};

  const run = async (call: CallInfo, fn: (principal: string | null | undefined) => Promise<ToolResult>): Promise<ToolResult> => {
    let principal: string | null | undefined;
    let result: ToolResult;
    try {
      principal = await options.getPrincipal(call);
      result = await fn(principal);
    } catch (error) {
      result = errorResult(error);
    }
    try {
      return applyNotices(result, await service.notices(principal), options);
    } catch {
      return result;
    }
  };

  const kinds = service.kinds as [string, ...string[]];

  const submitShape = {
    kind: z.enum(kinds).describe("bug (it is broken), friction (it works but is awkward), missing_capability (it cannot be done), or feature_request."),
    title: z.string().max(120).describe("One line, at most 120 characters."),
    description: z.string().max(4000).describe("What is broken or missing, in plain text, at most 4000 characters."),
    target: z
      .object({
        type: z.enum(["tool", "resource", "prompt", "server"]).describe("tool, resource, prompt, or server."),
        name: z.string().optional().describe("The tool, resource, or prompt name."),
      })
      .optional()
      .describe("What the request is about. name is required unless type is server."),
    context: z
      .object({
        goal: z.string().optional().describe("What you were trying to get done."),
        workaround: z.string().optional().describe("What you did instead, if anything."),
        cause: z.string().max(500).optional().describe("Your guess at why the gap exists. It is read as a guess, never a finding."),
        attempts: z.array(z.record(z.string(), z.unknown())).max(5).optional().describe("Up to 5 calls you tried, each with its outcome. Example values only."),
      })
      .optional()
      .describe("What you were doing."),
    failureMode: z
      .string()
      .optional()
      .describe("How it failed: capability_missing, interface_cost, data_gap, discoverability, scope_not_honored, silent_failure, or a vendor-prefixed mode."),
    impact: z
      .object({
        blocked: z.boolean().optional().describe("True when you could not finish the task at all."),
        frequency: z.enum(["once", "recurring"]).optional(),
        severity: z.enum(["low", "medium", "high"]).optional(),
        detectability: z.enum(["immediate", "eventual", "hidden"]).optional().describe("immediate: the call showed it. eventual: you noticed later. hidden: only outside evidence showed it."),
      })
      .optional()
      .describe("How much it matters."),
    ...(service.acceptanceTests
      ? { acceptanceTests: z.array(testSchema).max(10).optional().describe("Up to 10 examples of the call you wanted and the result you expected.") }
      : {}),
    idempotencyKey: z.string().describe("A unique string you make up for this request, such as a UUID. Resending it returns the first answer."),
    origin: z.enum(["agent", "principal"]).optional().describe("principal when the user asked for this change, agent (default) when you found the gap yourself."),
    about: z
      .enum(["app", "spec"])
      .optional()
      .describe("spec when the request is about these change request tools or the Agent Change Requests standard itself, app (default) for everything else. A request that targets a change_requests tool is marked spec on its own."),
  };

  tools["change_requests_submit"] = server.registerTool(
    "change_requests_submit",
    {
      description: [
        `Report a problem with ${appName}'s tools, or ask for a capability that is missing.`,
        "Describe what you were trying to do and what would have helped. Include an acceptance test when you can: the exact call you wanted and the result you expected.",
        "Never include credentials, personal data, the user's own words, resource contents, or file paths; use made-up example values.",
        "Send a new idempotencyKey for each new request. Returns a requestId: check it later with change_requests_list.",
        service.anonymous
          ? "Without a signed-in account you also get a ticket: keep it, because only change_requests_get with that ticket can read the request."
          : "",
        options.submitGuidance ?? "",
      ]
        .join(" ")
        .trim(),
      inputSchema: submitShape,
    },
    async (args, extra) =>
      run(extra, async (principal) => {
        const result = await service.submit(principal, args);
        return ok({ ...result });
      }),
  );

  tools["change_requests_list"] = server.registerTool(
    "change_requests_list",
    {
      description: `Your inbox: your change requests to ${appName} and their status, newest change first, at most 50 per page. Call it when a result says updates are waiting, or before using a workaround, to see whether a fix has shipped. Pass nextCursor back as cursor for the next page.`,
      inputSchema: {
        status: z.array(z.enum(STATUSES)).optional().describe("Only these statuses."),
        updatedSince: z.string().optional().describe("Only requests changed at or after this ISO 8601 time."),
        about: z.enum(["app", "spec"]).optional().describe("Only requests about the app, or only those about the change request standard."),
        limit: z.number().int().min(1).max(50).optional().describe("Page size, at most 50."),
        cursor: z.string().optional().describe("nextCursor from the previous page."),
      },
    },
    async (args, extra) =>
      run(extra, async (principal) => {
        const page = await service.list(principal, args);
        return ok({ requests: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
      }),
  );

  tools["change_requests_get"] = server.registerTool(
    "change_requests_get",
    {
      description: service.anonymous
        ? "Read the current status of one of your change requests by requestId. If you filed it without a signed-in account, pass the ticket you got back."
        : "Read the current status of one of your change requests by requestId.",
      inputSchema: {
        requestId: z.string().describe("The requestId that change_requests_submit returned."),
        ...(service.anonymous
          ? { ticket: z.string().optional().describe("The ticket change_requests_submit returned, for a request filed without a signed-in account.") }
          : {}),
      },
    },
    async (args, extra) =>
      run(extra, async (principal) => ok({ ...(await service.get(principal, args.requestId, (args as { ticket?: string }).ticket)) })),
  );

  tools["change_requests_withdraw"] = server.registerTool(
    "change_requests_withdraw",
    {
      description: "Withdraw a request you no longer need. Only works before it reaches a final status (shipped, declined, duplicate, or withdrawn).",
      inputSchema: { requestId: z.string().describe("The requestId that change_requests_submit returned.") },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async (args, extra) => run(extra, async (principal) => ok({ ...(await service.withdraw(principal, args.requestId)) })),
  );

  tools["change_requests_confirm"] = server.registerTool(
    "change_requests_confirm",
    {
      description:
        "After a request shows shipped, try the call you originally wanted, then report outcome pass or fail, with per-test results if you sent tests. Set adopted true once you use the change in real work or drop your workaround. If it fails, also file a new bug that names the original requestId.",
      inputSchema: {
        requestId: z.string().describe("The requestId that change_requests_submit returned."),
        outcome: z.enum(["pass", "fail"]).describe("Whether the shipped change did what you asked for."),
        tests: z
          .array(z.object({ index: z.number().int().min(0), outcome: z.enum(["pass", "fail"]) }))
          .max(10)
          .optional()
          .describe("Per-test results: index (0-based, in the order you sent the tests) and outcome."),
        note: z.string().max(1000).optional().describe("What you saw, at most 1000 characters."),
        adopted: z.boolean().optional().describe("True once you use the change in real work or dropped your workaround."),
      },
    },
    async (args, extra) => run(extra, async (principal) => ok({ ...(await service.confirm(principal, args)) })),
  );

  tools["change_requests_scorecard"] = server.registerTool(
    "change_requests_scorecard",
    {
      description:
        "The scorecard of all your change requests: each stage with its time (requested, approved, built, merged, published, live, confirmed, adopted), and the running numbers (time to live, build and human time, confirmed fix rate, adoption, contract failures, gaps). As markdown and as data. Read only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) =>
      run(extra, async (principal) => {
        // A null principal means "every principal" to the service, so refuse it here.
        if (!principal) throw new ChangeRequestError("unauthenticated", "Change requests need an authenticated caller.");
        const card = await service.scorecard(principal, options.timeZone ? { timeZone: options.timeZone } : {});
        return ok({ ledger: card.ledger, numbers: card.numbers, markdown: card.markdown } as unknown as Record<string, unknown>);
      }),
  );
  if (service.changesEnabled) {
    tools["whats_new"] = server.registerTool(
      "whats_new",
      {
        description: `What ${appName} has shipped: new tools, changed behavior, deprecations, and removals, newest first. Pass the version you last saw as sinceVersion (or a time as since) to see only what came after. Call it when a result says changes may affect you, and before relying on a tool you have not used in a while. Entries marked BREAKING can make a call that worked before fail.`,
        inputSchema: {
          sinceVersion: z.string().optional().describe("Only changes after this version."),
          since: z.string().optional().describe("Only changes published after this ISO 8601 time."),
          limit: z.number().int().min(1).max(50).optional().describe("Page size, at most 50."),
          cursor: z.string().optional().describe("nextCursor from the previous page."),
          notify: z
            .boolean()
            .optional()
            .describe("Only when the user asks: false stops the note about breaking changes and deprecations on tool results, true turns it back on."),
        },
        annotations: { readOnlyHint: false },
      },
      async (args, extra) =>
        run(extra, async (principal) => {
          const { notify, ...query } = args;
          if (notify !== undefined) await service.setChangeNotice(principal, notify);
          const page = await service.changes(principal, query);
          return ok({ ...page } as unknown as Record<string, unknown>, changesText(page));
        }),
    );
  }
  return tools;
}
