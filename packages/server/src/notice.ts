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
  /** The changes feed tool the changes line points to. Default whats_new. */
  changesToolName?: string;
  /**
   * Leave the text lines out and keep only the _meta counts. Set it when the server
   * exposes no tool the line could name (SEP sections 7 and 12).
   */
  metaOnly?: boolean;
}

export function updateNoticeLine(count: number, options: NoticeOptions): string {
  const tool = options.listToolName ?? "change_requests_list";
  const verb = count === 1 ? "has" : "have";
  return `Note from ${options.appName}: ${count} of your change requests ${verb} an update. Call ${tool} to see them.`;
}

export function changesNoticeLine(count: number, options: NoticeOptions): string {
  const tool = options.changesToolName ?? "whats_new";
  const noun = count === 1 ? "change" : "changes";
  return `Note from ${options.appName}: ${count} ${noun} may affect your use of this server. Call ${tool} to see them.`;
}

interface ToolResultLike {
  content?: unknown[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The _meta value for the counts above zero, or undefined when both are zero. */
export function noticeMeta(counts: { updates?: number; changes?: number }): { updates?: number; changes?: number } | undefined {
  const meta: { updates?: number; changes?: number } = {};
  if ((counts.updates ?? 0) > 0) meta.updates = counts.updates!;
  if ((counts.changes ?? 0) > 0) meta.changes = counts.changes!;
  return Object.keys(meta).length ? meta : undefined;
}

/**
 * Adds the notices to a tool result: the request update line (section 7), then the
 * changes line (section 12), each only when its count is above zero. Returns a new object.
 */
export function applyNotices<T extends ToolResultLike>(
  result: T,
  counts: { updates?: number; changes?: number },
  options: NoticeOptions,
): T {
  const meta = noticeMeta(counts);
  if (!meta) return result;
  const lines: { type: "text"; text: string }[] = [];
  if (!options.metaOnly) {
    if (meta.updates) lines.push({ type: "text", text: updateNoticeLine(meta.updates, options) });
    if (meta.changes) lines.push({ type: "text", text: changesNoticeLine(meta.changes, options) });
  }
  const content = [...(result.content ?? []), ...lines];
  return { ...result, content, _meta: { ...(result._meta ?? {}), [options.extensionId]: meta } };
}

/** Adds the update notice to a tool result when count is above zero. Returns a new object. */
export function applyUpdateNotice<T extends ToolResultLike>(result: T, count: number, options: NoticeOptions): T {
  return applyNotices(result, { updates: count }, options);
}
