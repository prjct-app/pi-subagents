import {
  DEFAULT_LIMITS, admit, descendants, emptyLedger, expired, find, live, markDelivered,
  noteSession, noteQuestion, recover, remodel, running, settle, startable, starting, stopping, undelivered,
  type Admission, type Limits, type Request,
} from './manager.ts';
import { activityStore, type Activity, type ActivityInput } from './activity.ts';
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
  onActivity?: () => void;
};

export type Jobs = {
  /** Admit and start. A refusal is returned, never thrown and never queued. */
  delegate(request: Request): Promise<Admission>;
  /** Put words in front of a live job. False when there is nobody to hear them. */
  steerTo(jobId: string, message: string): Promise<boolean>;
  /** End one job and its subtree, whatever state it is in. */
  cancel(jobId: string, reason: string): Promise<void>;
  /** Time passes: expire what has run too long and start what can start. */
  tick(): Promise<void>;
  /** What finished and has not been reported to the parent yet. Consumed once. */
  drain(): Job[];
  pending(): Job[];
  acknowledge(ids: readonly string[]): void;
  question(jobId: string, text?: string): void;
  activity(jobId: string): Activity[];
  record(jobId: string, input: ActivityInput): void;
  /** Come back from a reload: nothing open survives, and nothing is replayed. */
  restore(saved: Ledger | undefined): Promise<void>;
  /** End everything, for a session that is going away. */
  close(reason: string): Promise<void>;
  ledger(): Ledger;
};

export function makeJobs(session: string, wiring: Wiring): Jobs {
  const limits = wiring.limits ?? DEFAULT_LIMITS;
  const store = { ledger: emptyLedger(session) };
  const activity = activityStore(() => wiring.onActivity?.());
  /**
   * The live children, by job. A handle is stored as the promise of one so a
   * cancellation that arrives while a child is still starting has something to
   * wait for instead of finding nothing and leaving the process behind.
   */
  const handles = new Map<string, Promise<Handle>>();
  /** Best-effort deadline nudges are sent once per stage, never on every tick. */
  const deadlineNudges = new Set<string>();

  const commit = (next: Ledger): Ledger => {
    const previous = store.ledger;
    store.ledger = next;
    for (const job of next.jobs) {
      if (find(previous, job.id)?.state !== job.state) activity.add(job.id, { kind: 'state', text: job.state });
    }
    try { void Promise.resolve(wiring.persist(next)).catch(() => undefined); } catch { /* Delivery separately persists each report before sending. */ }
    wiring.onChange?.(next);
    return next;
  };

  /** Stop one child and forget it, whatever state its start was left in. */
  const release = async (jobId: string, reason: string): Promise<void> => {
    const handle = handles.get(jobId);
    if (!handle) return;
    // A start that failed leaves a rejected promise here, and awaiting it is how
    // that rejection would become the caller's problem. There is nothing to stop
    // in that case, which is the same outcome as having stopped it.
    const started = await handle.catch(() => undefined);
    if (started) await started.stop(reason);
    handles.delete(jobId);
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
    if (event.type === 'activity') { activity.add(jobId, event.activity); return; }
    if (event.type === 'running') {
      commit(running(store.ledger, jobId));
      return;
    }
    if (event.type === 'model') {
      commit(remodel(store.ledger, jobId, event.provider, event.modelId));
      return;
    }
    if (event.type === 'session') {
      commit(noteSession(store.ledger, jobId, event.file));
      return;
    }
    if (event.type === 'settled') {
      commit(settle(store.ledger, jobId, {
        kind: 'reported', report: event.report, ...(event.usage ? { usage: event.usage } : {}),
      }, now));
      void after().catch(() => undefined);
      return;
    }
    if (event.type === 'failed') {
      const current = find(store.ledger, jobId);
      // halt() has already named why this is ending. A child that dies of the
      // abort must not relabel a timeout as "ended without reporting".
      if (current?.state === 'stopping') return;
      commit(settle(store.ledger, jobId, { kind: 'failed', reason: event.reason, ...(event.usage ? { usage: event.usage } : {}) }, now));
      void after().catch(() => undefined);
    }
  };

  /** After anything settles: release what ended, then fill the free slot. */
  const after = async (): Promise<void> => {
    await reap();
    await pump();
  };

  const pump = async (): Promise<void> => {
    for (const job of startable(store.ledger, limits).slice(0, Math.max(0, limits.concurrency - handles.size))) {
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
    async steerTo(jobId, message) {
      const job = find(store.ledger, jobId);
      if (!job || isTerminal(job.state)) return false;
      const handle = handles.get(jobId);
      if (!handle) return false;
      // A start that failed leaves a rejected promise here; unreachable is an
      // answer, never an exception for the one who asked.
      try { return await (await handle).steer?.(message) ?? false; } catch { return false; }
    },

    async delegate(request) {
      const decision = admit(store.ledger, request, wiring.now(), limits);
      if (!decision.ok || decision.repeated) return decision;
      commit(decision.ledger);
      await pump();
      // Admission creates a transient queued record so two pumps cannot race.
      // Return the current record after pumping; otherwise the caller renders
      // "queued" even though this entity already owns a runner.
      return { ...decision, job: find(store.ledger, decision.job.id) ?? decision.job, ledger: store.ledger };
    },

    async cancel(jobId, reason) {
      const job = find(store.ledger, jobId);
      if (!job || isTerminal(job.state)) return;
      await halt(jobId, reason);
      commit(settle(store.ledger, jobId, { kind: 'cancelled', reason }, wiring.now()));
      await after();
    },

    async tick() {
      const now = wiring.now();
      for (const job of live(store.ledger).filter(item => !item.parentJobId && item.state === 'running')) {
        const elapsed = now - job.admitted;
        const ratio = elapsed / limits.timeoutMs;
        const stage = ratio >= 0.85 && ratio < 1 ? 'final' : ratio >= 0.6 && ratio < 1 ? 'narrow' : undefined;
        const key = stage ? `${job.id}:${stage}` : undefined;
        if (!stage || !key || deadlineNudges.has(key)) continue;
        deadlineNudges.add(key);
        const remaining = Math.max(1, Math.ceil((limits.timeoutMs - elapsed) / 1000));
        const message = stage === 'final'
          ? `Deadline imminent: about ${remaining}s remain. Stop optional exploration now and call subagent_report with your best evidence. A partial report or explicit blocker is preferable to a timeout.`
          : `Time budget: about ${remaining}s remain. Narrow the scope to the requested outcome. If anything blocks completion, report the blocker instead of continuing optional exploration.`;
        const handle = handles.get(job.id);
        if (handle) await handle.then(value => value.steer?.(message), () => undefined).catch(() => undefined);
      }
      const reason = `This ran past the ${Math.round(limits.timeoutMs / 1000)}s its tree was given.`;
      for (const job of expired(store.ledger, now, limits)) {
        if (isTerminal(find(store.ledger, job.id)?.state ?? 'failed')) continue;
        await halt(job.id, reason);
        commit(settle(store.ledger, job.id, { kind: 'timed_out', reason }, wiring.now()));
      }
      await after();
    },

    pending: () => undelivered(store.ledger),
    acknowledge(ids) { commit(markDelivered(store.ledger, ids, wiring.now())); },
    question(jobId, text) {
      commit(noteQuestion(store.ledger, jobId, text));
      if (text) activity.add(jobId, { kind: 'question', text });
    },
    activity: activity.get,
    record: activity.add,
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
      commit(recover({ ...saved, v: 2, session }, wiring.now()));
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
