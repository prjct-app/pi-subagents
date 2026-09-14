import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DELEGATE_TOOL, READ_ONLY_TOOLS, REPORT_TOOL, type Role } from './schema.ts';

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
 * How many choices a parent is offered.
 *
 * The list travels in the delegation tool's schema, which is paid on every turn
 * of the parent session, so it is capped and ordered cheapest first: the models
 * a parent should reach for by default are the ones it sees first.
 */
export const MAX_CHOICES = 16;

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
    .sort((a, b) => (a.in + a.out) - (b.in + b.out) || a.key.localeCompare(b.key))
    .slice(0, MAX_CHOICES);
}

export const findChoice = (choices: readonly ModelChoice[], key: string): ModelChoice | undefined =>
  choices.find(choice => choice.key === key);

const money = (rate: number): string => (rate >= 10 ? `$${Math.round(rate)}` : `$${rate}`);

/**
 * The one line of pricing a parent needs to choose by complexity.
 *
 * The whole priced catalogue would be a table paid on every turn for a decision
 * taken rarely, so this names the extremes and leaves the middle to the list in
 * the schema.
 */
export function choiceHint(choices: readonly ModelChoice[]): string {
  const cheapest = choices.at(0);
  const strongest = choices.at(-1);
  if (!cheapest || !strongest) return 'This session has no model to offer a job, so delegation is unavailable.';
  if (cheapest.key === strongest.key) return `Only ${cheapest.key} is available.`;
  const rate = (choice: ModelChoice) => `${money(choice.in)}/${money(choice.out)} per Mtok`;
  return `Cheapest ${cheapest.key} (${rate(cheapest)}), most capable ${strongest.key} (${rate(strongest)}). `
    + 'Match the model to the task: reading and mapping rarely needs the expensive one. Omit it to reuse this session’s.';
}

const ROLE_BRIEF: Record<Role, string> = {
  explorer: 'You are an explorer. You map what is there — where things live, how they connect, '
    + 'what is missing — and you report it plainly. You are not asked whether any of it is good.',
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
  bash: 'bash — run commands from the working directory.',
  edit: 'edit — change a file under the working directory.',
  write: 'write — create or replace a file under the working directory.',
};

export function childPrompt(input: {
  name: string;
  role: Role;
  subject: string;
  task: string;
  context?: string;
  /** When false or omitted, the delegate tool does not exist in this process. */
  canDelegate?: boolean;
  /** The pi tools this child was given. Omitted means the read-only set. */
  tools?: readonly string[];
}): string {
  const context = input.context?.trim();
  const inherited = input.tools ?? READ_ONLY_TOOLS;
  /** A child with edit or write is a worker; without them, a reader. */
  const writer = inherited.includes('edit') || inherited.includes('write');
  const tools = [
    ...inherited.map(name => TOOL_BLURB[name] ?? `${name} — inherited from the session that asked.`),
    `${REPORT_TOOL} — return the report and end. This is the only way anything you learn leaves this process.`,
    ...(input.canDelegate
      ? [`${DELEGATE_TOOL} — ask the parent to start another reader beside you. It reports to the parent, not to you. Do not wait.`]
      : []),
  ];
  return [
    `You are ${input.name}, working alone in a session that exists for one task and ends with it.`,
    '',
    roleBrief(input.role),
    '',
    '## Tools you have',
    'This process loaded no extensions, no skills, and no prompt templates. A skill or extension '
    + 'from the session that asked is not here. Call only a tool from this list; anything else is not installed.',
    '',
    ...tools.map(line => `- ${line}`),
    '',
    writer
      ? 'You have the same tools as the session that asked, minus delegation and team tools. '
        + 'Every path stays under the working directory you were given; the fence cannot be talked around.'
      : 'You do not have write, edit, or an unrestricted shell: bash answers read-only commands only. '
        + 'You do not have any agent_* tool.',
    '',
    'Work out the acceptance criteria yourself, from the task below, before you open anything. '
    + 'Report every criterion as met, not met, or unknown, each with the evidence for it — file and '
    + 'line where there is one. Unknown is an honest answer; a criterion you could not check is '
    + 'never reported as met.',
    '',
    'Report findings, not a verdict. You do not approve anything, reject anything, or declare '
    + 'anything done: the session that asked holds the request you have not seen, and judges your '
    + 'evidence against it.',
    '',
    'If you cannot finish — something outside the working directory, a decision that is not yours, '
    + 'anything that needs writing or running — stop and report it as a blocker, naming exactly what '
    + 'you need to continue. Do not look for a way around it, and do not wait for anyone.',
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
  ].join('\n');
}

/**
 * Where a job may look. Omitted means the parent session's directory. A path
 * that is not a directory is refused rather than silently falling back: the
 * child is fenced to this folder, so a wrong one is a job that cannot do the work.
 */
export function resolveWorkDir(base: string, wanted?: string): { cwd: string } | { refused: string } {
  const raw = wanted?.trim();
  if (!raw) return { cwd: base };
  const cwd = resolve(base, raw);
  if (!existsSync(cwd)) return { refused: `${cwd} does not exist, so a job cannot be fenced there.` };
  try {
    if (!statSync(cwd).isDirectory()) return { refused: `${cwd} is not a directory.` };
  } catch {
    return { refused: `${cwd} cannot be opened.` };
  }
  return { cwd };
}
