import { TERMINAL_STATUSES, type Status } from "./types.js";

/** The forward order of open statuses (SEP section 5). */
const ORDER: readonly Status[] = ["received", "needs_info", "triaged", "planned", "building", "shipped"];

export function isTerminal(status: Status): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Whether the server may move a request from one status to another.
 * The spec lets a server skip intermediate statuses, so any forward move is allowed.
 * declined can end any open request, and duplicate only a received one, as in the
 * spec's table. Withdrawn is reserved for the submitter (see ChangeRequestService.withdraw).
 * Nothing leaves a terminal status.
 */
export function canTransition(from: Status, to: Status): boolean {
  if (isTerminal(from)) return false;
  if (to === "withdrawn") return false;
  if (to === "declined") return true;
  if (to === "duplicate") return from === "received";
  const a = ORDER.indexOf(from);
  const b = ORDER.indexOf(to);
  return a >= 0 && b > a;
}
