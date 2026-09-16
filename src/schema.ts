import { randomUUID } from 'node:crypto';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

/**
 * Ephemeral subagents: parent-owned jobs that start when a session delegates a
 * task, return a bounded report, and terminate.
 *
 * They are deliberately not team members. A member is a persistent session a
 * person opened and joined; a job is a temporary child this session owns, and
 * nothing about it touches the mailbox record. Keeping the two apart is what
 * lets a job exist without a team, an alias, or a claim.
 */
const id = Type.String({ minLength: 1, maxLength: 128 });
const moment = Type.Number({ minimum: 0 });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));

/** Whether a criterion holds. Three-valued, because unknown is an answer. */
export const MET = ['yes', 'no', 'unknown'] as const;
export type Met = (typeof MET)[number];

/** The first release explores and reviews. Both are read-only. */
export const ROLES = ['explorer', 'reviewer', 'worker'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The one tool a child has that is not a way of reading.
 *
 * The name is the contract between the two processes: the parent matches the
 * child's tool calls on it to find the report, and names it in the child's tool
 * allowlist. It is deliberately not a word Pi might one day ship as a built-in.
 */
export const REPORT_TOOL = 'subagent_report';

/**
 * The tool a child uses to ask for a child of its own.
 *
 * It exists only where delegation is allowed. At the bottom of the tree the
 * tool is not registered and is not in the allowlist, so the brake is the
 * absence of the thing rather than an instruction not to use it.
 */
export const DELEGATE_TOOL = 'subagent_delegate';

/**
 * How a child's question reaches its parent.
 *
 * A child has one request-and-answer channel to the process that spawned it:
 * the extension dialog protocol, which in RPC mode is a request on stdout and
 * an answer on stdin. The prefix is what tells the parent that the question
 * came from this package rather than from something asking for a person.
 */
export const READY_PREFIX = 'pi-subagents-ready:';
export const ASK_PREFIX = 'pi-subagents-ask:';

/**
 * The tool a child uses to see and choose its own model.
 *
 * The parent no longer chooses for it: a child starts on the inherited model
 * because that start is fast, and then decides for itself, because the one
 * doing the work is the one who knows what the work needs. The catalogue it
 * chooses from is the machine's, not a recommendation.
 */
export const MODEL_TOOL = 'subagent_model';

/**
 * The sibling channel: one file per delegation tree, no membership.
 *
 * A child reaches the others by the names the ledger gave them, and '*'.
 * There is no 'parent' address: a question for the hierarchy travels the ask
 * channel, not the wire, because the wire is between equals.
 */
export const WIRE_SEND_TOOL = 'subagent_send';
export const WIRE_INBOX_TOOL = 'subagent_inbox';

/**
 * A question for the hierarchy, not the wire.
 *
 * A child that is stuck on a decision that is not its own asks its parent —
 * or the parent asks the grandparent, up to the session that launched the
 * tree. It never blocks on the answer: the ack is immediate and the answer
 * arrives by itself, steered back down.
 */
export const ASK_TOOL = 'subagent_ask';

/** A child's question, on the wire to its parent. */
export const QuestionAskSchema = Type.Object({
  kind: Type.Literal('ask'),
  question: Type.String({ minLength: 1, maxLength: 2000 }),
});

export const DelegateSchema = Type.Object({
  role: Type.Optional(StringEnum(ROLES)),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  subject: Type.String({ minLength: 1, maxLength: 160 }),
  task: Type.String({ minLength: 1, maxLength: 24000 }),
  context: Type.Optional(Type.String({ maxLength: 24000 })),
  model: Type.Optional(Type.String({ maxLength: 256 })),
});
export type DelegateAsk = {
  role?: Role;
  agent?: string;
  subject: string;
  task: string;
  context?: string;
  model?: string;
};
/** What a parent answers a child that asked for help. */
export type DelegateAnswer = { ok: boolean; text: string };

/** A child switching its own model. */
export const ModelAskSchema = Type.Object({
  kind: Type.Literal('use_model'),
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
});
export type ModelAsk = { kind: 'use_model'; provider: string; modelId: string };

/** A child asking for a child, on the wire: the ask plus its kind. */
export const DelegateEnvelopeSchema = Type.Object({
  kind: Type.Literal('delegate'),
  role: Type.Optional(StringEnum(ROLES)),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  subject: Type.String({ minLength: 1, maxLength: 160 }),
  task: Type.String({ minLength: 1, maxLength: 24000 }),
  context: Type.Optional(Type.String({ maxLength: 24000 })),
  model: Type.Optional(Type.String({ maxLength: 256 })),
});

/** Everything a child may do to the disk: look at it. */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
/**
 * The whole tool list, the guard's own included.
 *
 * `--tools` is a strict allowlist across built-in, extension and custom tools
 * alike, so a child whose report tool is not named here cannot report at all —
 * it would work perfectly and then fail for having said nothing.
 */
export const CHILD_TOOLS: readonly string[] = [...READ_ONLY_TOOLS, REPORT_TOOL, MODEL_TOOL, ASK_TOOL];

/**
 * Every state a job can be in. There is no state that waits forever: a job
 * leaves `running` by reporting, timing out, being cancelled, dying, or losing
 * its parent, and each of those is a distinct recorded reason.
 */
export const JOB_STATES = ['queued', 'starting', 'running', 'stopping',
  'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL: readonly JobState[] = ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
export const isTerminal = (state: JobState): boolean => TERMINAL.includes(state);

/**
 * What a child returns. It reports the criteria it derived itself, the evidence
 * against them, and what it could not check. `blocked` is a real outcome and a
 * complete one: the process always ends, and the unresolved need becomes the
 * parent's. A child never returns a verdict.
 */
export const ReportSchema = Type.Object({
  outcome: StringEnum(['completed', 'blocked', 'failed'] as const),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  /** Acceptance criteria the child derived from the task it was given. */
  criteria: Type.Array(Type.Object({
    criterion: Type.String({ minLength: 1, maxLength: 500 }),
    met: StringEnum(MET),
    evidence: Type.String({ maxLength: 1000 }),
  }), { maxItems: 20 }),
  findings: Type.Array(Type.Object({
    detail: Type.String({ minLength: 1, maxLength: 1000 }),
    file: Type.Optional(Type.String({ maxLength: 4096 })),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
  }), { maxItems: 40 }),
  /** What stopped it, and exactly what it needs. The parent owns these. */
  blockers: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
});
export type Report = {
  outcome: 'completed' | 'blocked' | 'failed';
  summary: string;
  criteria: { criterion: string; met: Met; evidence: string }[];
  findings: { detail: string; file?: string; line?: number }[];
  blockers: string[];
};

/** Observed from the child's own reporting. Absent is unknown, never zero. */
export type Usage = { tokens?: number; cost?: number; calls?: number };

export type Job = {
  continuedBy?: string;
  resumedFrom?: string;
  resumeSession?: string;
  runner?: 'process' | 'in-process';
  question?: string;
  id: string;
  role: Role;
  /** Optional package-owned operating profile and its assigned playbooks. */
  agent?: string;
  /** An invented person name, stable for the life of the job. */
  name: string;
  subject: string;
  task: string;
  context: string;
  /** Resolved at admission and fixed: `provider/modelId`, never a pattern. */
  provider: string;
  modelId: string;
  cwd: string;
  /** Original client directory when cwd is an external package-owned snapshot. */
  sourceCwd?: string;
  workspace?: string;
  patchFile?: string;
  /**
   * The pi tools this child may call, inherited from the parent's active set
   * at admission. Absent means the original promise: read-only.
   */
  tools?: string[];
  state: JobState;
  /** The mailbox thread this job belongs to, when it was born inside one. */
  rootId?: string;
  /** The delegation tree's wire: siblings reach each other through it. */
  wire?: string;
  /** The child's session file: what the takeover view reads, live. */
  sessionFile?: string;
  /** Who admitted it. Absent on a job the session itself delegated. */
  parentJobId?: string;
  depth: number;
  /**
   * The tool call that asked for it. A retried call must admit one job, not a
   * second identical child nobody asked for.
   */
  key?: string;
  admitted: moment_;
  started?: moment_;
  settled?: moment_;
  /** Why it left `running`, in words, when that was not a plain report. */
  reason?: string;
  report?: Report;
  usage?: Usage;
  /** Set once the parent has been told, so a reload does not tell it twice. */
  delivered?: moment_;
};
type moment_ = number;

export const JobSchema = Type.Object({
  continuedBy: Type.Optional(id),
  resumedFrom: Type.Optional(id),
  resumeSession: Type.Optional(Type.String({ maxLength: 4096 })),
  runner: Type.Optional(enumOf('process', 'in-process')),
  question: Type.Optional(Type.String({ maxLength: 2000 })),
  // The pi tools this child may call, captured from the parent's active set at
  // admission. Absent on jobs admitted before the inheritance existed: those
  // stay read-only, which is what they were promised.
  id,
  role: enumOf(...ROLES),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  name: Type.String({ minLength: 1, maxLength: 48 }),
  subject: Type.String({ minLength: 1, maxLength: 160 }),
  task: Type.String({ minLength: 1, maxLength: 24000 }),
  context: Type.String({ maxLength: 24000 }),
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  sourceCwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  workspace: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  patchFile: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
  state: enumOf(...JOB_STATES),
  rootId: Type.Optional(id),
  /** The delegation tree's wire file. Every job in a tree shares one. */
  wire: Type.Optional(id),
  /** The child's own session file, once it says where it is. */
  sessionFile: Type.Optional(Type.String({ maxLength: 4096 })),
  parentJobId: Type.Optional(id),
  depth: Type.Integer({ minimum: 0, maximum: 8 }),
  key: Type.Optional(id),
  admitted: moment,
  started: Type.Optional(moment),
  settled: Type.Optional(moment),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
  report: Type.Optional(ReportSchema),
  usage: Type.Optional(Type.Object({
    tokens: Type.Optional(Type.Number({ minimum: 0 })),
    cost: Type.Optional(Type.Number({ minimum: 0 })),
    calls: Type.Optional(Type.Number({ minimum: 0 })),
  })),
  delivered: Type.Optional(moment),
});

/**
 * What is written to the parent's session so a reload can recover. Bounded by
 * construction: the task, the context and the report are already capped, and
 * nothing here carries a transcript or an RPC stream.
 */
export const LedgerSchema = Type.Object({
  v: Type.Union([Type.Literal(1), Type.Literal(2)]),
  session: id,
  jobs: Type.Array(JobSchema, { maxItems: 256 }),
});
export type Ledger = { v: 1 | 2; session: string; jobs: Job[] };

export const newJobId = (): string => `j_${randomUUID().replaceAll('-', '')}`;

function lazy<T>(make: () => T): () => T {
  const slot: { value?: T } = {};
  return () => (slot.value ??= make());
}
const reportValidator = lazy(() => Compile(ReportSchema));
const askValidator = lazy(() => Compile(DelegateSchema));
const envelopeValidator = lazy(() => Compile(DelegateEnvelopeSchema));
const modelAskValidator = lazy(() => Compile(ModelAskSchema));
const questionAskValidator = lazy(() => Compile(QuestionAskSchema));
const ledgerValidator = lazy(() => Compile(LedgerSchema));

/** A report is data from a child. It is validated before it is believed. */
export const checkReport = (value: unknown): boolean => reportValidator().Check(value);

/**
 * What is wrong with a report, in words a model can act on. Bounded, because
 * a malformed report can produce one complaint per element it got wrong.
 */
export function reportProblems(value: unknown): string[] {
  return [...reportValidator().Errors(value)]
    .slice(0, 8)
    .map(problem => `${problem.instancePath || 'the report'}: ${problem.message}`);
}
export const checkLedger = (value: unknown): boolean => ledgerValidator().Check(value);
/** A child asking for a child is untrusted input like any other. */
export const checkAsk = (value: unknown): boolean => envelopeValidator().Check(value);
export const checkModelAsk = (value: unknown): boolean => modelAskValidator().Check(value);
export const checkQuestionAsk = (value: unknown): boolean => questionAskValidator().Check(value);
