import { realpathSync, readlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import {
  READY_PREFIX, ASK_PREFIX, ASK_TOOL, CHILD_TOOLS, DELEGATE_TOOL, DelegateSchema, MODEL_TOOL, READ_ONLY_TOOLS, REPORT_TOOL,
  ReportSchema, WIRE_INBOX_TOOL, WIRE_SEND_TOOL, checkReport, reportProblems, type DelegateAnswer,
} from './schema.ts';
import { post, recent } from './wire.ts';

/**
 * The only extension a child loads.
 *
 * A child starts with `--no-extensions`, so nothing ambient reaches it — which
 * also means none of the guards an ambient extension would have brought. This
 * file is what a child has instead: the one way to report, and the allowlist
 * around the tools it inherited. File tools are fenced to the working tree.
 * Bash is absent unless the operator explicitly opts in; when present it is
 * unrestricted, because parsing shell text is not a sandbox.
 *
 * It arms itself only inside a child this package spawned. Loaded anywhere else
 * it does nothing at all, because a guard that strips a person's tools because
 * they passed the wrong path is a worse failure than no guard.
 */
export default function subagentGuard(pi: ExtensionAPI): void {
  installGuard(pi);
}

/**
 * How long a child waits for its parent to answer a question.
 *
 * The dialog auto-dismisses when it expires, so a parent that has gone away
 * leaves the child with a refusal it can report, never with a wait.
 */
const ASK_MS = 30_000;

export function installGuard(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, request?: (payload: string) => Promise<string | undefined>): boolean {
  if (env.PI_SUBAGENTS_CHILD !== '1') return false;
  const askParent = (payload: string, ctx: any): Promise<string | undefined> => request ? request(payload) : ctx?.ui?.input?.(`${ASK_PREFIX}${payload}`, undefined, { timeout: ASK_MS });
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
      description: 'Ask for a second agent on a separable part of this task, choosing either a base role or a package-owned factory agent. '
        + 'It runs beside you and reports to the session that asked for your work, not to you, '
        + 'so do not wait for it and do not plan around its answer. Delegate only what is genuinely '
        + 'separable; splitting work you could finish yourself costs more than it saves.',
      parameters: DelegateSchema,
      async execute(_toolCallId: string, input: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {
        // The parent decides. Asking it is the only honest answer to give the
        // model here: a local “accepted” that the parent then refuses is worse
        // than a refusal, because the work is planned around a child that does
        // not exist.
        const answered = await askParent(JSON.stringify({ kind: 'delegate', ...(input as object) }), ctx);
        const answer = readAnswer(answered);
        return { content: [{ type: 'text' as const, text: answer.text }], details: answer };
      },
    } as Parameters<ExtensionAPI['registerTool']>[0]);
  }

  /**
   * The child's own choice of model. The catalogue is the machine's and the
   * switch is the runner's one-millisecond command; what the child gets back
   * is an answer, never a recommendation.
   */
  pi.registerTool({
    name: MODEL_TOOL,
    label: 'Choose your model',
    description: 'List the models this machine can run, or switch this session to one. You start on '
      + 'the model the session that asked had. Choose by the task in front of you: reading and '
      + 'mapping rarely need the expensive one, judgement does. Switching is instant.',
    parameters: Type.Object({
      action: StringEnum(['list', 'use'] as const),
      provider: Type.Optional(Type.String({ maxLength: 128 })),
      modelId: Type.Optional(Type.String({ maxLength: 128 })),
    }),
    async execute(_toolCallId: string, input: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const ask = input?.action === 'use'
        ? { kind: 'use_model', provider: String(input?.provider ?? ''), modelId: String(input?.modelId ?? '') }
        : { kind: 'models' };
      const answered = await askParent(JSON.stringify(ask), ctx);
      const answer = readAnswer(answered);
      return { content: [{ type: 'text' as const, text: answer.text }], details: answer };
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  /**
   * A question for whoever asked for this work. The ack is immediate and the
   * answer is steered back down by itself: a child that waits on its question
   * is a stalled job, so the tool tells it not to.
   */
  pi.registerTool({
    name: ASK_TOOL,
    label: 'Ask your parent',
    description: 'Ask whoever asked for your work when you are stuck on a decision that is not '
      + 'yours. The question travels up the delegation tree; the answer arrives by itself. Never '
      + 'wait for it: carry on with what you can, and if nothing can continue without the answer, '
      + `call ${REPORT_TOOL} with the question as a blocker.`,
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_toolCallId: string, input: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const answered = await askParent(JSON.stringify({ kind: 'ask', question: String(input?.question ?? '') }), ctx);
      const answer = readAnswer(answered);
      return { content: [{ type: 'text' as const, text: answer.text }], details: answer };
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  /**
   * The sibling channel. Armed only when the runner wired this child into a
   * tree: the tools are in the allowlist, and the file they speak through is
   * named by the environment. The send budget is the anti-loop brake on this
   * side: colleagues coordinate, they do not converse forever.
   */
  const wire = env.PI_SUBAGENTS_WIRE;
  const wireRoot = env.PI_SUBAGENTS_WIRE_ROOT;
  const alias = env.PI_SUBAGENTS_ALIAS ?? 'me';
  if (wire && wireRoot) {
    const budget = { left: 12 };
    pi.registerTool({
      name: WIRE_SEND_TOOL,
      label: 'Message a sibling',
      description: 'Send a message to a sibling working beside you on the same task, by name, or '
        + '"*" for all of them. Coordination, not conversation: say what you found or what you need, '
        + 'once. There is no parent address here — a question for the hierarchy goes through the ask channel.',
      parameters: Type.Object({
        to: Type.String({ minLength: 1, maxLength: 48 }),
        subject: Type.String({ minLength: 1, maxLength: 160 }),
        body: Type.String({ minLength: 1, maxLength: 8000 }),
      }),
      async execute(_toolCallId: string, input: any) {
        if (budget.left <= 0) {
          throw new Error('You have spent your messages for this task. Report what you have, with what '
            + 'you still need named as a blocker.');
        }
        budget.left -= 1;
        const posted = await post(wireRoot, wire, {
          id: `w_${randomUUID().replaceAll('-', '')}`, from: alias, to: String(input.to),
          subject: String(input.subject), body: String(input.body), at: Date.now(),
        });
        if (!posted) throw new Error('That message is too large for the wire. Send less.');
        return {
          content: [{ type: 'text' as const, text: `Sent to ${String(input.to)}. ${budget.left} message${budget.left === 1 ? '' : 's'} left. Do not wait for an answer; it arrives by itself.` }],
          details: { to: input.to },
        };
      },
    } as Parameters<ExtensionAPI['registerTool']>[0]);
    pi.registerTool({
      name: WIRE_INBOX_TOOL,
      label: 'Read sibling messages',
      description: 'Read the last messages your siblings sent you. Pushed messages also arrive by '
        + 'themselves while you work; this is for checking what you might have missed.',
      parameters: Type.Object({}),
      async execute() {
        const messages = await recent(wireRoot, wire, alias);
        const text = messages.length === 0
          ? 'No messages from your siblings.'
          : messages.map(message => `${message.from} · ${message.subject}\n${message.body}`).join('\n---\n');
        return { content: [{ type: 'text' as const, text }], details: { count: messages.length } };
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
  const requested = inherited ?? (mayDelegate ? [...CHILD_TOOLS, DELEGATE_TOOL] : CHILD_TOOLS);
  const writer = requested.includes('edit') || requested.includes('write');
  const bash = env.PI_SUBAGENTS_ALLOW_BASH === '1' && writer;
  // Enforce the opt-in again inside the child. `--tools` is the first gate;
  // this one also catches a stale job or a tool injected by another route.
  const capabilities = env.PI_SUBAGENTS_ROLE === 'explorer' || env.PI_SUBAGENTS_ROLE === 'reviewer'
    ? new Set([...READ_ONLY_TOOLS, ...CHILD_TOOLS, DELEGATE_TOOL, WIRE_SEND_TOOL, WIRE_INBOX_TOOL]) : undefined;
  const allowed = requested.filter(tool => (tool !== 'bash' || bash) && (!capabilities || capabilities.has(tool)));
  if (env.PI_SUBAGENTS_VERIFY_TOOLS === '1') pi.on('session_start', (_event, ctx) => {
    const available = new Set(pi.getAllTools().map(tool => tool.name));
    ctx.ui.notify(`${READY_PREFIX}${JSON.stringify({ missing: allowed.filter(tool => !available.has(tool)) })}`, 'info');
  });
  if (env.PI_SUBAGENTS_VERIFY_TOOLS === '1') pi.on('before_agent_start', () => {
    const available = new Set(pi.getAllTools().map(tool => tool.name));
    const missing = allowed.filter(tool => !available.has(tool));
    if (missing.length) throw new Error(`Child capabilities unavailable: ${missing.join(', ')}. Configure extensionPackages explicitly.`);
    pi.setActiveTools(allowed);
  });
  pi.on('tool_call', (event: any, ctx: any) => {
    const tool = String(event?.toolName ?? '');
    if (!allowed.includes(tool)) {
      const reason = tool === 'bash'
        ? 'Bash is disabled for subagents. It is available only to a child with edit or write when '
          + 'PI_SUBAGENTS_ALLOW_BASH=1; when enabled it is unrestricted and not a sandbox.'
        : `${tool} is not available here. This session can ${allowed.join(', ')} and nothing else.`;
      return {
        block: true,
        reason: `${reason} If the work needs more than that, call ${REPORT_TOOL} with it as a blocker.`,
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

/**
 * The real location of a path, resolved through its nearest existing ancestor.
 *
 * `realpathSync` fails on a path that does not exist yet — which is exactly
 * the case a symlink escape needs: `write` to `<root>/link/evil`, where `link`
 * points outside, has no target to resolve, and a fallback to the literal name
 * would judge the escape by its alias instead of where it lands. Walking up to
 * the nearest ancestor that exists and appending what was left resolves the
 * link even when the final segments are new.
 */
function realDeep(path: string, hops = 0): string {
  // A loop of symlinks has no answer; the kernel will refuse it too (ELOOP).
  if (hops > 40) return path;
  try { return realpathSync(path); } catch { /* fall through */ }
  // A dangling symlink has no realpath, but it still has a target: judge the
  // path by where the link points, never by the name it was given.
  try { return realDeep(resolve(dirname(path), readlinkSync(path)), hops + 1); }
  catch { /* not a symlink: keep walking up */ }
  const parent = dirname(path);
  if (parent === path) return path;
  return join(realDeep(parent, hops + 1), basename(path));
}

/** Whether a path the child asked for stays inside the directory it was given. */
export function contains(root: string, path?: string): boolean {
  if (path === undefined || path.trim() === '') return true;
  const base = realDeep(resolve(root));
  const target = realDeep(resolve(base, path));
  return target === base || target.startsWith(`${base}${sep}`);
}
