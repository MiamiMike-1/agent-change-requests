import { ChangeRequestService, type ServiceOptions } from "../src/service.js";
import { MemoryStore } from "../src/store.js";

export function makeService(overrides: Partial<ServiceOptions> = {}) {
  let clock = Date.parse("2026-01-05T12:00:00.000Z");
  let n = 0;
  const events: unknown[] = [];
  const store = new MemoryStore();
  const service = new ChangeRequestService({
    store,
    now: () => new Date(clock),
    newId: () => `crq_${++n}`,
    onEvent: (e) => {
      events.push(e);
    },
    ...overrides,
  });
  return {
    service,
    store,
    events,
    advance(ms: number) {
      clock += ms;
    },
    nowIso() {
      return new Date(clock).toISOString();
    },
  };
}

export function request(overrides: Record<string, unknown> = {}) {
  return {
    kind: "missing_capability",
    title: "list_things cannot filter by owner",
    description: "Finding one owner's things means paging through all of them.",
    target: { type: "tool", name: "list_things" },
    idempotencyKey: `key-${Math.random()}`,
    ...overrides,
  };
}

export const shippedResolution = { availability: "all" as const, workaroundObsolete: true };
