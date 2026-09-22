/**
 * How this package and its neighbours find each other.
 *
 * Pi loads every extension with a fresh jiti instance and no module cache, so
 * two packages importing the same file still get two copies of it. The one
 * memory they truly share is the process itself: a well-known symbol on
 * `globalThis` is the same object for every loader, which is the pattern Pi
 * itself uses to share its theme across tsx and jiti module graphs.
 *
 * What travels here is deliberately small: a way to learn which mailbox thread
 * is open, so a job born inside one is filed under it, and a way to read the
 * ledger from outside, so `/team jobs` keeps working when pi-team is present.
 * Nothing here requires pi-team; without a provider the jobs simply belong to
 * the session that started them.
 */
export type AgentsRegistry = {
  /** The mailbox thread a job belongs to, when it was born inside one. */
  activeRoot?: () => string | undefined;
  /** The live ledger, for hosts that render it. Reads state, never a copy. */
  handle?: { lines: () => string[] };
};

const KEY = Symbol.for('prjct.agents');

/**
 * pi-memory publishes a read-only, role-filtered view here. Absent when
 * pi-memory is not installed, and then a child simply starts without memory.
 */
type ChildMemoryView = (request: { role: string; query?: string; signal?: AbortSignal }) => Promise<{ text: string }>;
const MEMORY_KEY = Symbol.for('prjct.memory');

export async function childMemory(role: string, query: string): Promise<string> {
  const host = (globalThis as unknown as Record<symbol, { childView?: ChildMemoryView } | undefined>)[MEMORY_KEY];
  if (typeof host?.childView !== 'function') return '';
  return (await host.childView({ role, query })).text;
}

export function registry(): AgentsRegistry {
  const space = globalThis as unknown as Record<symbol, AgentsRegistry | undefined>;
  const found = space[KEY];
  if (found) return found;
  const created: AgentsRegistry = {};
  space[KEY] = created;
  return created;
}

/** pi-team registers this while a team task can be open; absent means standalone. */
export function setActiveRootProvider(provider: () => string | undefined): void {
  registry().activeRoot = provider;
}

export function getActiveRoot(): string | undefined {
  return registry().activeRoot?.();
}

/** Registered once per process; the handle reads live state, never a snapshot. */
export function registerHandle(handle: NonNullable<AgentsRegistry['handle']>): void {
  registry().handle = handle;
}
