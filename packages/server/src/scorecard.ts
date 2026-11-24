import type { ChangeRequestRecord, Gap, Stage } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const GAP_FOLLOW_UP_MS = 30 * 60 * 1000;

export interface ScorecardRow {
  requestId: string;
  title: string;
  kind: ChangeRequestRecord["kind"];
  origin: ChangeRequestRecord["origin"];
  about: ChangeRequestRecord["about"];
  status: ChangeRequestRecord["status"];
  version: string | null;
  /** Latest confirmation outcome, or null when unconfirmed. */
  confirmation: "pass" | "fail" | null;
  pickedUp: boolean;
  times: Record<Stage, string | null>;
  approximate: Stage[];
  /** requested to live. */
  hoursToLive: number | null;
  /** approved to built (pull request opened). */
  buildHours: number | null;
  /** requested to approved, plus built to published: the time spent waiting on people. */
  humanHours: number | null;
  /** Failed confirmations on this request. */
  contractFailures: number;
}

export interface ScorecardNumbers {
  requests: {
    total: number;
    byOrigin: Record<string, number>;
    byKind: Record<string, number>;
    byAbout: Record<string, number>;
  };
  live: { shipped: number; of: number };
  medianHoursToLive: number | null;
  medianBuildHours: number | null;
  medianHumanHours: number | null;
  confirmedFixed: { pass: number; fail: number; unconfirmed: number; of: number };
  adopted: { count: number; of: number };
  contractFailures: number;
  pickedUp: { count: number; of: number };
  gaps: { total: number; byWeek: Record<string, Record<string, number>>; followedByRequestWithin30Min: number };
}

export interface Scorecard {
  ledger: ScorecardRow[];
  numbers: ScorecardNumbers;
  markdown: string;
}

export interface ScorecardOptions {
  /** IANA time zone for the dates in the markdown table. Default UTC. */
  timeZone?: string;
  /** What to call the user who asks for changes, in the markdown. Default "principal". */
  principalLabel?: string;
}

function hoursBetween(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? ms / HOUR_MS : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function count<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

/** Monday of the UTC week that holds the given time, as YYYY-MM-DD. */
function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function scorecardRow(record: ChangeRequestRecord): ScorecardRow {
  const s = record.stages;
  const latest = record.confirmations.at(-1);
  const waitBefore = hoursBetween(s.requested, s.approved);
  const waitAfter = hoursBetween(s.built, s.published);
  return {
    requestId: record.requestId,
    title: record.title,
    kind: record.kind,
    origin: record.origin,
    about: record.about,
    status: record.status,
    version: record.version ?? null,
    confirmation: latest?.outcome ?? null,
    pickedUp: record.pickedUp,
    times: {
      requested: s.requested,
      approved: s.approved ?? null,
      built: s.built ?? null,
      merged: s.merged ?? null,
      published: s.published ?? null,
      live: s.live ?? null,
      confirmed: s.confirmed ?? null,
      adopted: s.adopted ?? null,
    },
    approximate: [...record.approximate],
    hoursToLive: hoursBetween(s.requested, s.live),
    buildHours: hoursBetween(s.approved, s.built),
    humanHours: waitBefore !== null && waitAfter !== null ? waitBefore + waitAfter : null,
    contractFailures: record.confirmations.filter((c) => c.outcome === "fail").length,
  };
}

export function computeScorecard(
  records: ChangeRequestRecord[],
  gaps: Gap[],
  options: ScorecardOptions = {},
): Scorecard {
  const ordered = [...records].sort(
    (a, b) => Date.parse(a.stages.requested) - Date.parse(b.stages.requested) || a.requestId.localeCompare(b.requestId),
  );
  const ledger = ordered.map(scorecardRow);
  const shipped = ledger.filter((r) => r.status === "shipped");
  const live = ledger.filter((r) => r.times.live !== null);

  const pass = shipped.filter((r) => r.confirmation === "pass").length;
  const fail = shipped.filter((r) => r.confirmation === "fail").length;

  const byWeek: Record<string, Record<string, number>> = {};
  let followed = 0;
  for (const gap of gaps) {
    const week = (byWeek[weekOf(gap.at)] ??= {});
    week[gap.reason] = (week[gap.reason] ?? 0) + 1;
    const t = Date.parse(gap.at);
    const hit = records.some(
      (r) => r.principal === gap.principal && Date.parse(r.createdAt) >= t && Date.parse(r.createdAt) - t <= GAP_FOLLOW_UP_MS,
    );
    if (hit) followed += 1;
  }

  const numbers: ScorecardNumbers = {
    requests: {
      total: ledger.length,
      byOrigin: count(ledger, (r) => r.origin),
      byKind: count(ledger, (r) => r.kind),
      byAbout: count(ledger, (r) => r.about),
    },
    live: { shipped: shipped.length, of: ledger.length },
    medianHoursToLive: round1(median(live.flatMap((r) => (r.hoursToLive === null ? [] : [r.hoursToLive])))),
    medianBuildHours: round1(median(ledger.flatMap((r) => (r.buildHours === null ? [] : [r.buildHours])))),
    medianHumanHours: round1(median(ledger.flatMap((r) => (r.humanHours === null ? [] : [r.humanHours])))),
    confirmedFixed: { pass, fail, unconfirmed: shipped.length - pass - fail, of: shipped.length },
    adopted: { count: shipped.filter((r) => r.times.adopted !== null).length, of: shipped.length },
    contractFailures: ledger.reduce((n, r) => n + r.contractFailures, 0),
    pickedUp: { count: shipped.filter((r) => r.pickedUp).length, of: shipped.length },
    gaps: { total: gaps.length, byWeek, followedByRequestWithin30Min: followed },
  };

  return { ledger, numbers, markdown: renderMarkdown(ledger, numbers, options) };
}

function renderMarkdown(ledger: ScorecardRow[], n: ScorecardNumbers, options: ScorecardOptions): string {
  const timeZone = options.timeZone ?? "UTC";
  const principal = options.principalLabel ?? "principal";
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
  const cell = (row: ScorecardRow, stage: Stage) => {
    const t = row.times[stage];
    if (!t) return "";
    return fmt.format(new Date(t)) + (row.approximate.includes(stage) ? "~" : "");
  };
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const label = (origin: string) => (origin === "principal" ? principal : origin);

  const lines = [
    "| # | Request | Kind, origin | Status | Requested | Approved | Built | Merged | Published | Live | Confirmed | Adopted |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...ledger.map((r, i) => {
      const status = r.status === "shipped" && r.version ? `shipped ${r.version}` : r.status;
      const stages: Stage[] = ["requested", "approved", "built", "merged", "published", "live", "confirmed", "adopted"];
      return `| ${i + 1} | ${esc(r.title)} | ${r.kind}, ${label(r.origin)} | ${status} | ${stages.map((s) => cell(r, s)).join(" | ")} |`;
    }),
    "",
    `Dates are in ${timeZone}; ~ marks an approximate time.`,
    "",
  ];

  const hours = (h: number | null) => (h === null ? "n/a" : `${h} h`);
  const origins = Object.entries(n.requests.byOrigin)
    .map(([k, v]) => `${v} ${label(k)}`)
    .join(", ");
  const spec = n.requests.byAbout.spec ?? 0;
  lines.push(
    `- Requests: ${n.requests.total}${origins ? ` (${origins})` : ""}`,
    `- About the spec: ${spec}`,
    `- Live: ${n.live.shipped} of ${n.live.of}`,
    `- Median request to live: ${hours(n.medianHoursToLive)}`,
    `- Median build time (approved to pull request): ${hours(n.medianBuildHours)}`,
    `- Median human time (request to approval, plus pull request to publish): ${hours(n.medianHumanHours)}`,
    `- Confirmed fixed: ${n.confirmedFixed.pass} of ${n.confirmedFixed.of} shipped (${n.confirmedFixed.fail} failed, ${n.confirmedFixed.unconfirmed} unconfirmed)`,
    `- Adopted: ${n.adopted.count} of ${n.adopted.of} shipped`,
    `- Contract failures: ${n.contractFailures}`,
    `- Picked up by the requester: ${n.pickedUp.count} of ${n.pickedUp.of} shipped`,
    `- Gaps logged: ${n.gaps.total}, ${n.gaps.followedByRequestWithin30Min} followed by a request within 30 minutes`,
  );
  return lines.join("\n");
}
