import { distinctName } from './names.ts';
import { checkReport, isTerminal, newJobId, ROLES, type Job, type JobState, type Ledger, type Report, type Role, type Usage } from './schema.ts';

/**
 * Admission, transitions and settlement, as pure functions over a ledger.
 *
 * Nothing here talks to a process, a model or the screen: the runner owns the
 * subprocess and the extension owns delivery. Keeping the rules here is what
 * makes the races testable without spawning anything.
 */
export type Limits = {
  /** Live child processes across every delegation in one parent session. */
  concurrency: number;
  /** Accepted jobs per parent session, kept across a reload. */
  jobs: number;
  /** Task and context together, in bytes. */
  taskBytes: number;
  /** Wall clock for a whole tree, measured from the root's admission. */
  timeoutMs: number;
  /** A job at this depth cannot delegate. Depth 0 is the parent session. */
  depth: number;
  /** Jobs admitted under one root, the root excluded. Spent, never returned. */
  descendants: number;
};

/**
 * Conservative on purpose. Raising them is trusted user configuration; a task
 * can never raise them, because a task is written by a model.
 */
export const DEFAULT_LIMITS: Limits = {
  concurrency: 2,
  jobs: 64,
  taskBytes: 24 * 1024,
  timeoutMs: 10 * 60_000,
  depth: 2,
  descendants: 4,
};

export type Request = {
  resumedFrom?: string;
  resumeSession?: string;
  runner?: 'process' | 'in-process';
  role: string;
  agent?: string;
  subject: string;
  task: string;
  context?: string;
  /** Chosen from what the session actually has, never a free string. */
  provider: string;
  modelId: string;
  cwd: string;
  sourceCwd?: string;
  workspace?: string;
  patchFile?: string;
  /** The pi tools the child inherits. Omitted is read-only, as it always was. */
  tools?: readonly string[];
  rootId?: string;
  /** The tree's wire. A root gets its own id, so every tree has one. */
  wire?: string;
  parentJobId?: string;
  depth: number;
  /** The tool call that asked. The same one twice admits one job. */
  key?: string;
};

export type Admission =
  | { ok: true; job: Job; ledger: Ledger; repeated: boolean }
  | { ok: false; reason: string };

export const emptyLedger = (session: string): Ledger => ({ v: 2, session, jobs: [] });

export const live = (ledger: Ledger): Job[] => ledger.jobs.filter(job => !isTerminal(job.state));
export const busy = (ledger: Ledger): Job[] =>
  ledger.jobs.filter(job => job.state === 'starting' || job.state === 'running' || job.state === 'stopping');
export const queued = (ledger: Ledger): Job[] => ledger.jobs.filter(job => job.state === 'queued');
export const settled = (ledger: Ledger): Job[] => ledger.jobs.filter(job => isTerminal(job.state));
/** Finished but not yet told to the parent. A reload must not tell it twice. */
export const undelivered = (ledger: Ledger): Job[] => settled(ledger).filter(job => !job.delivered);
/** Work the parent still owns: a blocker is unresolved even though the job ended. */
export const unresolved = (ledger: Ledger): Job[] =>
  ledger.jobs.filter(job => !isTerminal(job.state) || (!job.continuedBy && (job.report?.blockers?.length ?? 0) > 0));
export const find = (ledger: Ledger, jobId: string): Job | undefined => ledger.jobs.find(job => job.id === jobId);
export const children = (ledger: Ledger, jobId: string): Job[] => ledger.jobs.filter(job => job.parentJobId === jobId);

/**
 * Every job under this one, at any depth.
 *
 * The walk is bounded by what it has already seen. A ledger is read back from a
 * session file, and a file can be edited by hand: a cycle in it must come back
 * as a short answer, not as a parent that never finishes recursing.
 */
export function descendants(ledger: Ledger, jobId: string, seen = new Set<string>()): Job[] {
  if (seen.has(jobId)) return [];
  seen.add(jobId);
  return children(ledger, jobId).flatMap(child => [child, ...descendants(ledger, child.id, seen)]);
}

/** The job at the top of this one's tree. A root is its own. */
export function rootOf(ledger: Ledger, job: Job, seen = new Set<string>()): Job {
  if (seen.has(job.id)) return job;
  seen.add(job.id);
  const parent = job.parentJobId ? find(ledger, job.parentJobId) : undefined;
  return parent ? rootOf(ledger, parent, seen) : job;
}

const replace = (ledger: Ledger, job: Job): Ledger =>
  ({ ...ledger, jobs: ledger.jobs.map(current => current.id === job.id ? job : current) });

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Accept a job, or say plainly why not. Every refusal is explicit: work is
 * never silently dropped, trimmed to fit, or queued behind a limit it will
 * never clear.
 */
export function admit(ledger: Ledger, request: Request, now: number, limits: Limits = DEFAULT_LIMITS): Admission {
  const already = request.key ? ledger.jobs.find(job => job.key === request.key) : undefined;
  if (already) return { ok: true, job: already, ledger, repeated: true };

  if (!(ROLES as readonly string[]).includes(request.role)) {
    return { ok: false, reason: `Unknown role "${request.role}". Available: ${ROLES.join(', ')}.` };
  }
  if (!request.subject.trim()) return { ok: false, reason: 'A job needs a subject.' };
  if (!request.task.trim()) return { ok: false, reason: 'A job needs a task.' };

  const size = bytes(request.task) + bytes(request.context ?? '');
  if (size > limits.taskBytes) {
    return { ok: false, reason: `Task and context are ${size} bytes; the limit is ${limits.taskBytes}. Send less, not a trimmed version of everything.` };
  }
  if (request.depth >= limits.depth) {
    return { ok: false, reason: `Delegation stops at depth ${limits.depth}.` };
  }

  /**
   * A job admitted under another one is admitted into that tree, and the tree
   * is what the budget belongs to. Counting per node instead has depth
   * multiplying the fan-out, which is how one review becomes eight of them.
   */
  const parent = request.parentJobId ? find(ledger, request.parentJobId) : undefined;
  if (request.parentJobId && !parent) {
    return { ok: false, reason: 'The job that asked for this is not in this session.' };
  }
  if (parent && isTerminal(parent.state)) {
    return { ok: false, reason: `${parent.name} has already ended, so nothing is waiting for this.` };
  }
  if (parent) {
    const root = rootOf(ledger, parent);
    const spent = descendants(ledger, root.id).length;
    if (spent >= limits.descendants) {
      return { ok: false, reason: `This tree has spent its ${limits.descendants} delegations. Report what is known instead of dividing it again.` };
    }
  }
  if (ledger.jobs.length >= limits.jobs) {
    return { ok: false, reason: `This session has accepted its ${limits.jobs} jobs. Raise limits.jobs in prjct-subagents.json for a new session; completed jobs still consume this budget.` };
  }

  if (request.resumeSession && live(ledger).some(job => job.resumeSession === request.resumeSession || job.sessionFile === request.resumeSession)) return { ok: false, reason: 'This conversation already has an active continuation.' };

  const id = newJobId();
  const job: Job = {
    id,
    ...(request.resumedFrom ? { resumedFrom: request.resumedFrom, resumeSession: request.resumeSession } : {}),
    ...(request.runner ? { runner: request.runner } : {}),
    role: request.role as Role,
    ...(request.agent ? { agent: request.agent } : {}),
    name: distinctName(id, live(ledger).map(other => other.name)),
    subject: request.subject.trim(),
    task: request.task,
    context: request.context ?? '',
    provider: request.provider,
    modelId: request.modelId,
    cwd: request.cwd,
    ...(request.sourceCwd ? { sourceCwd: request.sourceCwd } : {}),
    ...(request.workspace ? { workspace: request.workspace } : {}),
    ...(request.patchFile ? { patchFile: request.patchFile } : {}),
    ...(request.tools ? { tools: [...request.tools] } : {}),
    state: 'queued',
    depth: request.depth,
    admitted: now,
    ...(request.rootId ? { rootId: request.rootId } : {}),
    // A root names its tree after itself; a child inherits its parent's wire,
    // so the whole tree talks on one file and no tree shares another's.
    wire: request.wire ?? id,
    ...(request.parentJobId ? { parentJobId: request.parentJobId } : {}),
    ...(request.key ? { key: request.key } : {}),
  };
  return { ok: true, job, ledger: { ...ledger, jobs: [...ledger.jobs.map(previous => previous.id === request.resumedFrom ? { ...previous, continuedBy: id } : previous), job] }, repeated: false };
}

/** The queued jobs that may start now, oldest first, within the live cap. */
export function startable(ledger: Ledger, limits: Limits = DEFAULT_LIMITS): Job[] {
  const room = Math.max(0, limits.concurrency - busy(ledger).length);
  return queued(ledger).slice(0, room);
}

export function starting(ledger: Ledger, jobId: string, now: number): Ledger {
  const job = find(ledger, jobId);
  if (!job || job.state !== 'queued') return ledger;
  return replace(ledger, { ...job, state: 'starting', started: now });
}

/** Where the child's transcript lives, learned once it answers get_state. */
export function noteSession(ledger: Ledger, jobId: string, file: string): Ledger {
  const job = find(ledger, jobId);
  if (!job || isTerminal(job.state)) return ledger;
  return replace(ledger, { ...job, sessionFile: file });
}

/** The child chose its own model; the job says what it is actually running on. */
export function remodel(ledger: Ledger, jobId: string, provider: string, modelId: string): Ledger {
  const job = find(ledger, jobId);
  if (!job || isTerminal(job.state)) return ledger;
  return replace(ledger, { ...job, provider, modelId });
}

export function running(ledger: Ledger, jobId: string): Ledger {
  const job = find(ledger, jobId);
  if (!job || job.state !== 'starting') return ledger;
  return replace(ledger, { ...job, state: 'running' });
}

/** Asked to stop. The process has not necessarily gone yet. */
export function stopping(ledger: Ledger, jobId: string, reason: string): Ledger {
  const job = find(ledger, jobId);
  if (!job || isTerminal(job.state)) return ledger;
  return replace(ledger, { ...job, state: 'stopping', reason });
}

export type Settlement =
  /** What a child sent, which is data until `checkReport` says otherwise. */
  | { kind: 'reported'; report: unknown; usage?: Usage }
  | { kind: 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; reason: string; usage?: Usage };

/**
 * End a job, and its subtree with it.
 *
 * A child outlives nothing: once the job that asked for its work has ended,
 * nobody is left to read what it returns, so its descendants are cancelled
 * first and the node is closed after them. This is what keeps a cancelled root
 * from leaving work running that no result will ever be collected from.
 */
export function settle(ledger: Ledger, jobId: string, settlement: Settlement, now: number): Ledger {
  const job = find(ledger, jobId);
  if (!job || isTerminal(job.state)) return ledger;
  const orphaned = descendants(ledger, jobId).filter(child => !isTerminal(child.state));
  const below = orphaned.reduce<Ledger>((current, child) => replace(current, {
    ...child, state: 'cancelled', settled: now,
    reason: `${job.name} ended, so there was nobody left to read this.`,
  }), ledger);
  return close(below, job, settlement, now);
}

function close(ledger: Ledger, job: Job, settlement: Settlement, now: number): Ledger {
  if (settlement.kind !== 'reported') {
    return replace(ledger, {
      ...job, state: settlement.kind, settled: now, reason: settlement.reason,
      ...(settlement.usage ? { usage: settlement.usage } : {}),
    });
  }
  if (!checkReport(settlement.report)) {
    return replace(ledger, {
      ...job, state: 'failed', settled: now,
      reason: 'The child returned a report that does not match the contract.',
      ...(settlement.usage ? { usage: settlement.usage } : {}),
    });
  }
  // The one cast in here, in the line after the check that earns it.
  const report = settlement.report as Report;
  const state: JobState = report.outcome === 'failed' ? 'failed' : 'completed';
  return replace(ledger, {
    ...job, state, settled: now, report, question: undefined,
    ...(settlement.usage ? { usage: settlement.usage } : {}),
  });
}

/**
 * Whether a job may be called finished. A node with live descendants is not:
 * it asked for work that is still running, and its own report cannot account
 * for what has not come back yet.
 */
export const closable = (ledger: Ledger, jobId: string): boolean =>
  descendants(ledger, jobId).every(child => isTerminal(child.state));

/** Consumed before the parent is told, so a crash cannot repeat a wake-up. */
export function markDelivered(ledger: Ledger, jobIds: readonly string[], now: number): Ledger {
  const wanted = new Set(jobIds);
  return { ...ledger, jobs: ledger.jobs.map(job => wanted.has(job.id) ? { ...job, delivered: now } : job) };
}

/**
 * Jobs a restart found still open. They are reported as interrupted and never
 * restarted: replaying work nobody watched is how a crash becomes a bill.
 */
export function recover(ledger: Ledger, now: number): Ledger {
  return {
    ...ledger,
    jobs: ledger.jobs.map(job => isTerminal(job.state) ? job : {
      ...job, state: 'interrupted' as JobState, settled: now,
      reason: 'The session that owned this job restarted while it was open.',
    }),
  };
}

/** Jobs whose tree has run past the clock, measured from the root's admission. */
export function expired(ledger: Ledger, now: number, limits: Limits = DEFAULT_LIMITS): Job[] {
  return live(ledger).filter(job => now - rootOf(ledger, job).admitted > limits.timeoutMs);
}

export function noteQuestion(ledger: Ledger, jobId: string, question?: string): Ledger {
  const job = find(ledger, jobId);
  return job ? replace(ledger, { ...job, question }) : ledger;
}
