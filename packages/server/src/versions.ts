/**
 * Version ordering for changeRequests/changes with sinceVersion.
 *
 * The default handles semantic versions and most dotted schemes: numeric parts compare
 * as numbers, other parts as text, and a pre-release ("1.2.0-beta.1") sorts before its
 * release. A server with another scheme passes its own compareVersions.
 */
export type CompareVersions = (a: string, b: string) => number;

function parts(version: string): { main: string[]; pre: string[] } {
  const clean = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const dash = clean.indexOf("-");
  const main = (dash === -1 ? clean : clean.slice(0, dash)).split(".");
  const pre = dash === -1 ? [] : clean.slice(dash + 1).split(".");
  return { main, pre };
}

function comparePart(a: string | undefined, b: string | undefined): number {
  const x = a ?? "0";
  const y = b ?? "0";
  const nx = /^\d+$/.test(x);
  const ny = /^\d+$/.test(y);
  if (nx && ny) return Math.sign(Number(x) - Number(y));
  if (nx) return -1;
  if (ny) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

export const compareVersions: CompareVersions = (a, b) => {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.main.length, pb.main.length); i += 1) {
    const c = comparePart(pa.main[i], pb.main[i]);
    if (c !== 0) return c;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    if (pa.pre[i] === undefined) return -1;
    if (pb.pre[i] === undefined) return 1;
    const c = comparePart(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
};
