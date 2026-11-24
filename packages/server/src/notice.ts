/**
 * The update notice from SEP section 7: a count in _meta and one plain line of text
 * at the end of a tool result. The line carries no request content.
 */
export interface NoticeOptions {
  /** The app's name, shown as "Note from <appName>". */
  appName: string;
  /** The extension identifier used as the _meta key, for example "com.example/change-requests". */
  extensionId: string;
  /** The inbox tool the line points to. Default change_requests_list. */
  listToolName?: string;
}

export function updateNoticeLine(count: number, options: NoticeOptions): string {
  const tool = options.listToolName ?? "change_requests_list";
  const verb = count === 1 ? "has" : "have";
  return `Note from ${options.appName}: ${count} of your change requests ${verb} an update. Call ${tool} to see them.`;
}

interface ToolResultLike {
  content?: unknown[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Adds the notice to a tool result when count is above zero. Returns a new object. */
export function applyUpdateNotice<T extends ToolResultLike>(result: T, count: number, options: NoticeOptions): T {
  if (count <= 0) return result;
  const content = [...(result.content ?? []), { type: "text", text: updateNoticeLine(count, options) }];
  const meta = { ...(result._meta ?? {}), [options.extensionId]: { updates: count } };
  return { ...result, content, _meta: meta };
}
