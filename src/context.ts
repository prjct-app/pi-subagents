import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASK_TOOL, DELEGATE_TOOL, MEMORY_TOOL, MODEL_TOOL, READ_ONLY_TOOLS, REPORT_TOOL, WIRE_INBOX_TOOL, WIRE_SEND_TOOL, type Role } from './schema.ts';

/**
 * What a child is told, and what it is allowed to be told.
 *
 * Everything here is pure text assembly over values the caller passes in, so
 * what a child receives can be asserted on directly rather than inferred. The
 * rule the assembly exists to keep: a child gets its role, its task, and the
 * context its parent chose to hand it — never the parent's conversation, never
 * a third party's message, never the environment.
 */

/** One model the session can actually reach, priced in dollars per million tokens. */
export type ModelChoice = {
  provider: string;
  modelId: string;
  /** `provider/modelId`, which is how a parent names a choice. */
  key: string;
  label: string;
  in: number;
  out: number;
  window: number;
  reasoning: boolean;
};

/** The shape this needs from a host model; anything else on it is ignored. */
export type ModelLike = {
  id: string;
  provider: string;
  name?: string;
  cost?: { input?: number; output?: number };
  contextWindow?: number;
  reasoning?: boolean;
};

export const modelKey = (provider: string, modelId: string): string => `${provider}/${modelId}`;

/**
 * The closed list of models a job may run on.
 *
 * A parent chooses from this and nothing else. `scoped` is what the session was
 * started with, and it wins when it is set, because a person who scoped their
 * session did not scope it for everything except its children. An empty scope
 * means the whole available catalogue, which is what the host means by it.
 */
export function eligible(input: { available: readonly ModelLike[]; scoped?: readonly ModelLike[] }): ModelChoice[] {
  const source = input.scoped && input.scoped.length > 0 ? input.scoped : input.available;
  const seen = new Set<string>();
  return source
    .filter(model => typeof model.id === 'string' && typeof model.provider === 'string')
    .map((model): ModelChoice => ({
      provider: model.provider,
      modelId: model.id,
      key: modelKey(model.provider, model.id),
      label: model.name ?? model.id,
      in: model.cost?.input ?? 0,
      out: model.cost?.output ?? 0,
      window: model.contextWindow ?? 0,
      reasoning: model.reasoning === true,
    }))
    .filter(choice => (seen.has(choice.key) ? false : (seen.add(choice.key), true)))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const findChoice = (choices: readonly ModelChoice[], key: string): ModelChoice | undefined =>
  choices.find(choice => choice.key === key);

/** A compact capability hint; the full catalogue is requested only when needed. */
export function choiceHint(choices: readonly ModelChoice[]): string {
  if (!choices.length) return 'This session has no model to offer a job, so delegation is unavailable.';
  if (choices.length === 1) return `Only ${choices[0]!.key} is available.`;
  return `${choices.length} models are available. Omit model to inherit this session's model and reasoning level. `
    + 'Choose another model when the task calls for its capabilities; price alone does not establish capability.';
}

/**
 * The catalogue a child chooses from: facts, one line each, alphabetical.
 *
 * Cost and context size are facts, not a capability ranking. The child gets
 * the complete authorized catalogue and decides whether a switch helps.
 */
export function neutralCatalogue(choices: readonly ModelChoice[]): string {
  if (choices.length === 0) return 'This machine reports no models to switch to.';
  return choices
    .map(choice => `${choice.key} — ${choice.label}, $${choice.in}/$${choice.out} per Mtok, `
      + `${Math.round(choice.window / 1000)}k window${choice.reasoning ? ', reasoning' : ''}`)
    .sort()
    .join('\n');
}

const ROLE_BRIEF: Record<Role, string> = {
  worker: 'You implement the assigned task within your effective tools and working directory. Validate changes, report evidence and unresolved decisions. Do not expand scope.',
  explorer: 'You are an explorer. You map what is there — where things live, how they connect, '
    + 'what is missing — and you report it plainly. Report concrete risks or contradictions when the task calls for them.',
  reviewer: 'You are a reviewer. You read what is in front of you against criteria you derive '
    + 'yourself, and you report what holds, what does not, and what you could not check.',
};

export const roleBrief = (role: Role): string => ROLE_BRIEF[role];

/**
 * The prompt a child starts with.
 *
 * It says what the child is, what it cannot do, and that reporting is the only
 * way anything it learns leaves the process. The tone is deliberate: a child
 * with no person watching it must be told that asking is free and that waiting
 * is not, or it will sit on a blocker until a timeout kills it.
 */
/** The one line each well-known tool gets; anything else is named as given. */
const TOOL_BLURB: Record<string, string> = {
  read: 'read — open a file under the working directory.',
  grep: 'grep — search file contents under the working directory.',
  find: 'find — find files by name under the working directory.',
  ls: 'ls — list a directory under the working directory.',
  bash: 'bash — run an unrestricted shell. The working directory is its starting point, not a sandbox.',
  edit: 'edit — change a file under the working directory.',
  write: 'write — create or replace a file under the working directory.',
};

export function childPrompt(input: {
  name: string;
  role: Role;
  subject: string;
  task: string;
  context?: string;
  /** Package-owned profile and playbooks embedded by the factory. */
  profile?: string;
  /** When false or omitted, the delegate tool does not exist in this process. */
  canDelegate?: boolean;
  /** The pi tools this child was given. Omitted means the read-only set. */
  tools?: readonly string[];
  /** When true, the sibling channel tools exist in this process. */
  wired?: boolean;
  /** The project memory this child's role may see, already rendered by pi-memory. */
  memory?: string;
}): string {
  const context = input.context?.trim();
  const memory = input.memory?.trim();
  const profile = input.profile?.trim();
  const inherited = input.tools ?? READ_ONLY_TOOLS;
  /** File mutation and an unrestricted shell are separate capabilities. */
  const writer = inherited.includes('edit') || inherited.includes('write');
  const bash = inherited.includes('bash');
  const tools = [
    ...inherited.map(name => TOOL_BLURB[name] ?? `${name} — inherited from the session that asked.`),
    `${REPORT_TOOL} — return the report and end. This is the only way anything you learn leaves this process.`,
    `${MODEL_TOOL} — list the models this machine can run, or switch to one. You start on the model `
      + 'the session that asked had; you are the one doing this work, so switch only when the assigned task explicitly authorizes a different model.',
    `${MEMORY_TOOL} — look up what this project remembers about something you found. Records, not conclusions.`,
    `${ASK_TOOL} — ask whoever asked for your work when a decision is not yours. The answer arrives `
      + 'by itself; never wait for it. Carry on, or report the question as a blocker.',
    ...(input.canDelegate
      ? [`${DELEGATE_TOOL} — ask the parent to start another reader beside you. It reports to the parent, not to you. Do not wait.`]
      : []),
    ...(input.wired
      ? [`${WIRE_SEND_TOOL} / ${WIRE_INBOX_TOOL} — reach a sibling by name, or all with "*". `
        + 'Coordination, not conversation: say what you found or what you need, once, then get back to work.']
      : []),
  ];
  return [
    `You are ${input.name}, working alone in a session that exists for one task and ends with it.`,
    '',
    roleBrief(input.role),
    ...(profile ? ['', profile] : []),
    '',
    '## Tools you have',
    'This process loaded no ambient extensions, skills, or prompt templates. Only the package-owned profile and playbooks '
    + 'embedded above apply. Call only a tool from this list; anything else is not installed.',
    '',
    ...tools.map(line => `- ${line}`),
    '',
    bash
      ? 'You have bash: run the tests, builds and commands the task needs yourself; never ask the session '
        + 'that started you to run them. Bash is unrestricted and not sandboxed: the working directory is only '
        + 'where it starts. Read, edit, write, grep, find, and ls remain fenced to the working directory.'
      : writer
        ? 'You may change files through the tools you were given; those file tools stay under the working '
          + 'directory. Bash is not available.'
        : 'You do not have write, edit, or bash. Your file tools are read-only and stay under the working directory. '
          + 'You do not have any agent_* tool.',
    '',
    'Use the supplied acceptance criteria and inspect the relevant evidence before deriving additional checks. Label inferred requirements as inferred. '
    + 'Report every criterion as met, not met, or unknown, each with the evidence for it — file and '
    + 'line where there is one. Unknown is an honest answer; a criterion you could not check is '
    + 'never reported as met.',
    '',
    'Report findings, not a verdict. You do not approve anything, reject anything, or declare '
    + 'anything done: the session that asked holds the request you have not seen, and judges your '
    + 'evidence against it.',
    '',
    bash
      ? `If you cannot finish — a decision that is not yours, anything beyond the tools you have — ask with ${ASK_TOOL} `
        + 'when an answer would unblock you, and report it as a blocker either way, naming exactly what you need '
        + 'to continue. Do not wait for anyone.'
      : 'If you cannot finish — something outside the working directory, a decision that is not yours, '
        + `anything beyond the tools you have — ask with ${ASK_TOOL} when an answer would unblock you, `
        + 'and report it as a blocker either way, naming exactly what you need to continue. '
        + 'Do not look for a way around it, and do not wait for anyone.',
    '',
    `Calling ${REPORT_TOOL} ends this session. Nothing else you write here is read by anyone. `
    + 'Report once, and report it whole.',
    '',
    '## Task',
    input.subject.trim(),
    '',
    input.task.trim(),
    '',
    '## What you were given',
    context ? context : 'Nothing beyond the task above. Anything else, you find or you report missing.',
    ...(memory ? ['', '## What this project remembers', memory] : []),
  ].join('\n');
}

/**
 * Where a job starts. Omitted means the parent session's directory. A path
 * that is not a directory is refused rather than silently falling back. File
 * tools are fenced here; explicitly enabled Bash is not a sandbox.
 */
export function resolveWorkDir(base: string, wanted?: string): { cwd: string } | { refused: string } {
  const raw = wanted?.trim();
  if (!raw) return { cwd: base };
  const cwd = resolve(base, raw);
  if (!existsSync(cwd)) return { refused: `${cwd} does not exist, so a job cannot start there.` };
  try {
    if (!statSync(cwd).isDirectory()) return { refused: `${cwd} is not a directory.` };
  } catch {
    return { refused: `${cwd} cannot be opened.` };
  }
  return { cwd };
}
