/**
 * The client's redaction pass (SEP section 9). A request carries text a model wrote,
 * so before it leaves the user's environment every free-text field and every
 * argument value goes through these rules.
 *
 * Redaction is a safety net, not a guarantee: patterns catch common secrets, contact
 * details, and paths, and the app adds what only it knows (the user's name, workspace
 * and database names, other servers' tool names). When a rule fires, a review hook
 * can show the user the cleaned request before it is sent.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export const DEFAULT_RULES: readonly RedactionRule[] = [
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "<private-key>" },
  { name: "jwt", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, replacement: "<token>" },
  { name: "bearer", pattern: /\bBearer\s+[\w.~+/=-]{8,}/gi, replacement: "Bearer <token>" },
  {
    name: "api_key",
    pattern: /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_])?[A-Za-z0-9_-]{16,}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replacement: "<secret>",
  },
  {
    name: "assigned_secret",
    pattern: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    replacement: "$1$2<secret>",
  },
  { name: "url_credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replacement: "$1<credentials>@" },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "<email>" },
  { name: "phone", pattern: /(?<![\w-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g, replacement: "<phone>" },
  { name: "ip_address", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, replacement: "<ip>" },
  { name: "windows_path", pattern: /\b[A-Za-z]:\\(?:[^\\\s:*?"<>|]+\\)*[^\\\s:*?"<>|]*/g, replacement: "<path>" },
  { name: "file_path", pattern: /(?<![\w.:/-])(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+[\w.@-]*/g, replacement: "<path>" },
  { name: "long_token", pattern: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, replacement: "<token>" },
];

export interface RedactOptions {
  /** Values only the app knows are sensitive: the user's name, workspace, project, or database names. */
  sensitiveValues?: readonly string[];
  /** Tool, resource, and prompt names of the other servers connected to this client (section 9). */
  foreignNames?: readonly string[];
  /** Replace the default rules. */
  rules?: readonly RedactionRule[];
  /** Rules added after the defaults. */
  extraRules?: readonly RedactionRule[];
}

/** Where a rule fired. It never includes the value that was removed. */
export interface RedactionFinding {
  path: string;
  rule: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private readonly rules: RedactionRule[];

  constructor(options: RedactOptions = {}) {
    this.rules = [...(options.rules ?? DEFAULT_RULES), ...(options.extraRules ?? [])];
    const literal = (values: readonly string[] | undefined, name: string, replacement: string) => {
      const usable = (values ?? []).filter((v) => v.trim().length >= 2).sort((a, b) => b.length - a.length);
      if (usable.length === 0) return;
      this.rules.unshift({
        name,
        pattern: new RegExp(`(?<![\\w])(?:${usable.map(escapeRegExp).join("|")})(?![\\w])`, "gi"),
        replacement,
      });
    };
    literal(options.foreignNames, "other_server", "<other-server>");
    literal(options.sensitiveValues, "sensitive_value", "<redacted>");
  }

  /** Redacts one string and reports which rules fired. */
  text(value: string, path = "", findings: RedactionFinding[] = []): string {
    let out = value;
    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(out)) continue;
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replacement);
      findings.push({ path, rule: rule.name });
    }
    return out;
  }

  /** Redacts every string inside a JSON value, keys included. */
  value(value: unknown, path: string, findings: RedactionFinding[]): unknown {
    if (typeof value === "string") return this.text(value, path, findings);
    if (Array.isArray(value)) return value.map((item, i) => this.value(item, `${path}[${i}]`, findings));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        out[this.text(key, `${path}{key}`, findings)] = this.value(inner, path ? `${path}.${key}` : key, findings);
      }
      return out;
    }
    return value;
  }
}

/** Fields that hold fixed vocabulary, never model-written text. */
const FIXED_FIELDS = new Set(["kind", "idempotencyKey", "failureMode", "impact", "origin", "about"]);

/**
 * Redacts a changeRequests/submit params object. Fixed fields pass through, target.name
 * is checked only against foreign names, and every other string is redacted.
 */
export function redactSubmission<T extends Record<string, unknown>>(
  params: T,
  options: RedactOptions = {},
): { params: T; findings: RedactionFinding[] } {
  const redactor = new Redactor(options);
  const findings: RedactionFinding[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (FIXED_FIELDS.has(key)) {
      out[key] = value;
    } else if (key === "target" && value && typeof value === "object") {
      const target = { ...(value as Record<string, unknown>) };
      if (typeof target.name === "string") {
        target.name = new Redactor({ ...options, rules: [], extraRules: [] }).text(target.name, "target.name", findings);
      }
      if (typeof target.component === "string") {
        target.component = new Redactor({ ...options, rules: [], extraRules: [] }).text(target.component, "target.component", findings);
      }
      out[key] = target;
    } else if (key === "acceptanceTests" && Array.isArray(value)) {
      out[key] = value.map((test, i) => {
        const { call, ...rest } = test as { call?: { method?: unknown; params?: unknown } };
        const cleaned = redactor.value(rest, `acceptanceTests[${i}]`, findings) as Record<string, unknown>;
        if (call) {
          cleaned.call = {
            method: call.method,
            ...(call.params !== undefined
              ? { params: redactor.value(call.params, `acceptanceTests[${i}].call.params`, findings) }
              : {}),
          };
        }
        return cleaned;
      });
    } else {
      out[key] = redactor.value(value, key, findings);
    }
  }
  return { params: out as T, findings };
}
