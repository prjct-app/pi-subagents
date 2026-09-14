import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  ASK_PREFIX, CHILD_TOOLS, DELEGATE_TOOL, DelegateSchema, READ_ONLY_TOOLS, REPORT_TOOL,
  ReportSchema, checkReport, reportProblems, type DelegateAnswer,
} from './schema.ts';

/**
 * The only extension a child loads.
 *
 * A child starts with `--no-extensions`, so nothing ambient reaches it — which
 * also means none of the guards an ambient extension would have brought. This
 * file is what a child has instead: the one way to report, and the fence around
 * the tools it inherited. A child with edit or write is a worker; a child
 * without them is a reader, and its shell answers read-only commands only.
 *
 * It arms itself only inside a child this package spawned. Loaded anywhere else
 * it does nothing at all, because a guard that strips a person's tools because
 * they passed the wrong path is a worse failure than no guard.
 */
export default function subagentGuard(pi: ExtensionAPI): void {
  installGuard(pi);
}

/**
 * Commands a reader's shell never runs, and the ones it answers.
 *
 * The same boundary plan mode draws for a person, drawn for a child: the
 * parent decides *which* tools a child inherits, and when that set holds no
 * edit and no write, the child's bash is held to reading too. Patterns from
 * Pi's plan-mode extension, kept deliberately conservative.
 */
const BASH_DESTRUCTIVE = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i,
  /\bdd\b/i, /\bshred\b/i, /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i, /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i, /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i, /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i, /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
];
const BASH_SAFE = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/, /^\s*grep\b/,
  /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/, /^\s*printf\b/, /^\s*wc\b/,
  /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/, /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/,
  /^\s*tree\b/, /^\s*which\b/, /^\s*type\b/, /^\s*env\b/, /^\s*date\b/, /^\s*ps\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i, /^\s*git\s+ls-/i,
  /^\s*node\s+--version/i, /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/, /^\s*rg\b/,
  /^\s*fd\b/, /^\s*bat\b/, /^\s*eza\b/,
];

/** A command a read-only child may run: known-safe, and not destructive. */
export function isSafeCommand(command: string): boolean {
  return !BASH_DESTRUCTIVE.some(pattern => pattern.test(command)) && BASH_SAFE.some(pattern => pattern.test(command));
}

/**
 * How long a child waits for its parent to answer a question.
 *
 * The dialog auto-dismisses when it expires, so a parent that has gone away
 * leaves the child with a refusal it can report, never with a wait.
 */
const ASK_MS = 30_000;

export function installGuard(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_SUBAGENTS_CHILD !== '1') return false;
  const mayDelegate = env.PI_SUBAGENTS_CAN_DELEGATE === '1';

  pi.registerTool({
    name: REPORT_TOOL,
    label: 'Report',
    description: 'Return what you found and end this session. This is the only thing that reaches '
      + 'the session that asked for this work: nothing else written here is read by anyone. Give the '
      + 'acceptance criteria you derived from the task with the evidence for each, the findings, and '
      + 'anything that blocked you. Report evidence, never approval or a sign-off.',
    parameters: ReportSchema,
    async execute(_toolCallId: string, input: unknown) {
      // Validated here so the child can fix its own report while it still has
      // the context to do it. Throwing is what marks a result as an error, and
      // an errored report is one the parent is never told about.
      if (!checkReport(input)) {
        throw new Error(`Nothing was sent: this report does not match the contract. ${reportProblems(input).join('; ')}`);
      }
      return {
        content: [{ type: 'text' as const, text: 'Reported. This session is over; nothing further from it is read.' }],
        details: input,
      };
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  /**
   * Delegation exists only where the parent allowed it.
   *
   * At the bottom of the tree this tool is never registered, and the parent
   * leaves it out of the allowlist as well. A child there has no way to ask for
   * a child, which is a brake that cannot be talked around.
   */
  if (mayDelegate) {
    pi.registerTool({
      name: DELEGATE_TOOL,
      label: 'Delegate',
      description: 'Ask for a second reader on a part of this task that can be worked out on its '
        + 'own. It runs beside you and reports to the session that asked for your work, not to you, '
        + 'so do not wait for it and do not plan around its answer. Delegate only what is genuinely '
        + 'separable; splitting work you could finish yourself costs more than it saves.',
      parameters: DelegateSchema,
      async execute(_toolCallId: string, input: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {
        // The parent decides. Asking it is the only honest answer to give the
        // model here: a local “accepted” that the parent then refuses is worse
        // than a refusal, because the work is planned around a child that does
        // not exist.
        const answered = await ctx?.ui?.input?.(`${ASK_PREFIX}${JSON.stringify(input)}`, undefined, { timeout: ASK_MS });
        const answer = readAnswer(answered);
        return { content: [{ type: 'text' as const, text: answer.text }], details: answer };
      },
    } as Parameters<ExtensionAPI['registerTool']>[0]);
  }

  /**
   * The inherited allowlist, enforced twice.
   *
   * The parent already passes `--tools`, and this says the same thing from
   * inside, where it also holds for a tool that arrives some other way.
   * A blocked call is not the end of the job: the child is told to report the
   * blocker instead, because a child killed mid-task reports nothing at all,
   * and the whole point of a blocker is that it reaches the parent.
   */
  const inherited = env.PI_SUBAGENTS_TOOLS?.split(',').filter(Boolean);
  const allowed = inherited ?? (mayDelegate ? [...CHILD_TOOLS, DELEGATE_TOOL] : CHILD_TOOLS);
  /** A set without edit and write is a reader, and so is its shell. */
  const writer = allowed.includes('edit') || allowed.includes('write');
  pi.on('tool_call', (event: any, ctx: any) => {
    const tool = String(event?.toolName ?? '');
    if (!allowed.includes(tool)) {
      return {
        block: true,
        reason: `${tool} is not available here. This session can ${allowed.join(', ')} and `
          + `nothing else. If the work needs more than that, call ${REPORT_TOOL} with it as a blocker.`,
      };
    }
    if (tool === 'bash' && !writer && !isSafeCommand(String(event?.input?.command ?? ''))) {
      return {
        block: true,
        reason: 'This session is read-only, and that command is not a read-only one. If the work '
          + `needs it, call ${REPORT_TOOL} with it as a blocker.`,
      };
    }
    const root = String(ctx?.cwd ?? process.cwd());
    const path = typeof event?.input?.path === 'string' ? event.input.path : undefined;
    if (contains(root, path)) return undefined;
    return {
      block: true,
      reason: `That path is outside the directory this session was given. Everything it may read is `
        + `under ${root}. If the work needs something outside it, call ${REPORT_TOOL} with that as a blocker.`,
    };
  });
  return true;
}

/** What the parent said, or a refusal, when it said nothing a child can use. */
export function readAnswer(value: unknown): DelegateAnswer {
  const parsed = ((): unknown => {
    try { return typeof value === 'string' ? JSON.parse(value) : undefined; } catch { return undefined; }
  })();
  const answer = parsed as Partial<DelegateAnswer> | undefined;
  if (!answer || typeof answer.ok !== 'boolean' || typeof answer.text !== 'string') {
    return { ok: false, text: 'The session that asked for this work did not answer, so nothing was started. Carry on with what you can do yourself, and report what you could not.' };
  }
  return { ok: answer.ok, text: answer.text };
}

const real = (path: string): string => {
  // A path that does not exist has nothing to resolve; the tool itself will say
  // so. What matters here is that an existing symlink cannot point out of the
  // tree and be judged by the name it was given instead of where it leads.
  try { return realpathSync(path); } catch { return path; }
};

/** Whether a path the child asked for stays inside the directory it was given. */
export function contains(root: string, path?: string): boolean {
  if (path === undefined || path.trim() === '') return true;
  const base = real(resolve(root));
  const target = real(resolve(base, path));
  return target === base || target.startsWith(`${base}${sep}`);
}
