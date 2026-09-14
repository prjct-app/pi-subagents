import {
  DEFAULT_LIMITS, admit, descendants, emptyLedger, expired, find, live, markDelivered,
  recover, running, settle, startable, starting, stopping, undelivered,
  type Admission, type Limits, type Request,
} from './manager.ts';
import type { Handle, Runner } from './runner.ts';
import { isTerminal, type Job, type Ledger } from './schema.ts';

/**
 * The one place where the ledger meets real processes.
 *
 * Everything it decides comes from `manager.ts`, and everything it spawns goes
 * through the injected runner, so the races here can be tested at full speed
 * against fake children. What this file owns is the order of operations: mark
 * before spawning, settle before stopping, persist after every change.
 */
export type Wiring = {
  runner: Runner;
  now: () => number;
  /** Written to the parent's session, so a reload knows what was open. */
  persist: (ledger: Ledger) => void | Promise<void>;
  /** Called after every change, for whatever is drawing this. */
  onChange?: (ledger: Ledger) => void;
  limits?: Limits;
};

export type Jobs = {
  /** Admit and start. A refusal is returned, never thrown and never queued. */
  delegate(request: Request): Promise<Admission>;
  /** End one job and its subtree, whatever state it is in. */
  cancel(jobId: string, reason: string): Promise<void>;
  /** Time passes: expire what has run too long and start what can start. */
  tick(): Promise<void>;
  /** What finished and has not been reported to the parent yet. Consumed once. */
  drain(): Job[];
  /** Come back from a reload: nothing open survives, and nothing is replayed. */
  restore(saved: Ledger | undefined): Promise<void>;
  /** End everything, for a session that is going away. */
  close(reason: string): Promise<void>;
  ledger(): Ledger;
};

export function makeJobs(session: string, wiring: Wiring): Jobs {
  const limits = wiring.limits ?? DEFAULT_LIMITS;
  const store = { ledger: emptyLedger(session) };
  /**
   * The live children, by job. A handle is stored as the promise of one so a
   * cancellation that arrives while a child is still starting has something to
   * wait for instead of finding nothing and leaving the process behind.
   */
  const handles = new Map<string, Promise<Handle>>();

  const commit = (next: Ledger): Ledger => {
    store.ledger = next;
    void wiring.persist(next);
    wiring.onChange?.(next);
    return next;
  };

  /** Stop one child and forget it, whatever state its start was left in. */
  const release = async (jobId: string, reason: string): Promise<void> => {
    const handle = handles.get(jobId);
    if (!handle) return;
    handles.delete(jobId);
    // A start that failed leaves a rejected promise here, and awaiting it is how
    // that rejection would become the caller's problem. There is nothing to stop
    // in that case, which is the same outcome as having stopped it.
    try { await (await handle).stop(reason); } catch { /* it never started */ }
  };

  /** Stop the children of jobs that are no longer live, and forget them. */
  const reap = async (): Promise<void> => {
    const going = [...handles.keys()].filter(jobId => {
      const job = find(store.ledger, jobId);
      return !job || isTerminal(job.state);
    });
    await Promise.all(going.map(jobId =>
      release(jobId, find(store.ledger, jobId)?.reason ?? 'the job ended')));
  };

  /**
   * Ask a job and everything under it to stop, and wait until they have.
   *
   * The jobs are marked `stopping` first, which is not cosmetic: a slot is not
   * free while a process is still dying. Marking them terminal straight away
   * starts a replacement beside a child that has not gone yet.
   */
  const halt = async (jobId: string, reason: string): Promise<void> => {
    const going = [jobId, ...descendants(store.ledger, jobId).map(job => job.id)];
    commit(going.reduce((ledger, id) => stopping(ledger, id, reason), store.ledger));
    await Promise.all(going.map(id => release(id, reason)));
  };

  const heard = (jobId: string) => (event: Parameters<Parameters<Runner>[1]>[0]): void => {
    const now = wiring.now();
    if (event.type === 'running') {
      commit(running(store.ledger, jobId));
      return;
    }
    if (event.type === 'settled') {
      commit(settle(store.ledger, jobId, {
        kind: 'reported', report: event.report, ...(event.usage ? { usage: event.usage } : {}),
      }, now));
      void after();
      return;
    }
    if (event.type === 'failed') {
      const current = find(store.ledger, jobId);
      // halt() has already named why this is ending. A child that dies of the
      // abort must not relabel a timeout as "ended without reporting".
      if (current?.state === 'stopping') return;
      commit(settle(store.ledger, jobId, { kind: 'failed', reason: event.reason, ...(event.usage ? { usage: event.usage } : {}) }, now));
      void after();
    }
  };

  /** After anything settles: release what ended, then fill the free slot. */
  const after = async (): Promise<void> => {
    await reap();
    await pump();
  };

  const pump = async (): Promise<void> => {
    for (const job of startable(store.ledger, limits)) {
      // Marked before anything is spawned, so a second pump cannot start the
      // same job twice while this one is waiting on a process.
      commit(starting(store.ledger, job.id, wiring.now()));
      const started = wiring.runner(job, heard(job.id));
      handles.set(job.id, started);
      void started.catch(error => {
        handles.delete(job.id);
        commit(settle(store.ledger, job.id, {
          kind: 'failed', reason: `The child could not be started: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
        }, wiring.now()));
        void pump();
      });
    }
  };

  return {
    async delegate(request) {
      const decision = admit(store.ledger, request, wiring.now(), limits);
      if (!decision.ok || decision.repeated) return decision;
      commit(decision.ledger);
      await pump();
      return { ...decision, ledger: store.ledger };
    },

    async cancel(jobId, reason) {
      const job = find(store.ledger, jobId);
      if (!job || isTerminal(job.state)) return;
      await halt(jobId, reason);
      commit(settle(store.ledger, jobId, { kind: 'cancelled', reason }, wiring.now()));
      await after();
    },

    async tick() {
      const reason = `This ran past the ${Math.round(limits.timeoutMs / 1000)}s its tree was given.`;
      for (const job of expired(store.ledger, wiring.now(), limits)) {
        if (isTerminal(find(store.ledger, job.id)?.state ?? 'failed')) continue;
        await halt(job.id, reason);
        commit(settle(store.ledger, job.id, { kind: 'timed_out', reason }, wiring.now()));
      }
      await after();
    },

    drain() {
      const ready = undelivered(store.ledger);
      if (ready.length === 0) return [];
      // Marked delivered before the caller is told, so a crash between the two
      // repeats nothing: a wake-up nobody asked for costs a turn every time.
      commit(markDelivered(store.ledger, ready.map(job => job.id), wiring.now()));
      return ready;
    },

    async restore(saved) {
      if (!saved || saved.jobs.length === 0) return;
      // Whatever was open belonged to a process that is gone. It is recorded as
      // interrupted and never restarted: replaying work nobody watched is how a
      // crash turns into a bill.
      commit(recover({ ...saved, session }, wiring.now()));
      await pump();
    },

    async close(reason) {
      for (const job of live(store.ledger)) {
        if (isTerminal(find(store.ledger, job.id)?.state ?? 'failed')) continue;
        await halt(job.id, reason);
        commit(settle(store.ledger, job.id, { kind: 'cancelled', reason }, wiring.now()));
      }
      await reap();
    },

    ledger: () => store.ledger,
  };
}
