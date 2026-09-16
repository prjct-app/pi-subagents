import { activityOf, type ActivityInput } from './activity.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { childPrompt, neutralCatalogue, type ModelChoice } from './context.ts';
import { read as readWire } from './wire.ts';
import { DEFAULT_LIMITS } from './manager.ts';
import {
  READY_PREFIX, ASK_PREFIX, ASK_TOOL, CHILD_TOOLS, DELEGATE_TOOL, MODEL_TOOL, READ_ONLY_TOOLS, REPORT_TOOL,
  WIRE_INBOX_TOOL, WIRE_SEND_TOOL, checkAsk, checkModelAsk, checkQuestionAsk,
  type DelegateAnswer, type DelegateAsk, type Job, type ModelAsk, type Usage,
} from './schema.ts';

/**
 * The subprocess boundary, behind one injectable function.
 *
 * Everything above this file is pure and testable without spawning anything;
 * everything below it is one real `pi` child speaking RPC. The seam exists so
 * the races in the manager can be tested at full speed, and so a test never
 * needs a model, a network, or a credential.
 */
export type RunnerEvent =
  | { type: 'running' }
  | { type: 'activity'; activity: ActivityInput }
  /**
   * The child stood behind a report: its own tool accepted it. Emitted as soon
   * as it lands so the job can be seen finishing, and still validated by the
   * manager before it is believed.
   */
  | { type: 'report'; report: unknown }
  /** Terminal. The child reported, and this is what the run cost. */
  | { type: 'settled'; report: unknown; usage?: Usage }
  /** Terminal. It ended without a report, died, or the transport broke. */
  | { type: 'failed'; reason: string; usage?: Usage }
  /** Diagnostic. The terminal event above is what settles a job, not this. */
  | { type: 'exit'; code: number | null }
  /** The child chose its own model; the job should say what it is running on. */
  | { type: 'model'; provider: string; modelId: string }
  /** Where the child's transcript lives. Best-effort: the panel reads it live. */
  | { type: 'session'; file: string };

export type Handle = {
  /** Ask it to stop, then make sure it stopped. Safe to call twice. */
  stop(reason: string): Promise<void>;
  /**
   * Put words in front of a live child: a steer while it runs, a prompt that
   * starts a turn when it idles, and nothing at all once it has reported.
   */
  steer?(message: string): Promise<boolean>;
};
export type Runner = (job: Job, emit: (event: RunnerEvent) => void) => Promise<Handle>;

/**
 * Bounds on what a child may send us. A child is untrusted input: its stdout
 * is parsed, never executed, and it cannot make the parent hold an unbounded
 * buffer by refusing to emit a newline.
 */
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STDERR_EXCERPT = 400;
/** Report calls seen but not yet accepted. A child cannot grow this. */
const MAX_OPEN_REPORTS = 4;
const START_DEADLINE_MS = 30_000;
/** How long a graceful `abort` is given to be acknowledged before signalling. */
const ABORT_ACK_MS = 1_000;
const STOP_GRACE_MS = 3_000;
/** Asking what the run cost must never delay reporting that it ended. */
const STATS_MS = 2_000;
/** A question from a child, bounded like everything else it can send. */
const MAX_ASK_BYTES = 32 * 1024;
/**
 * The extension UI methods that block until they are answered. The rest —
 * `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` — expect no
 * response, so answering one would be a frame the child never asked for.
 */
const DIALOGS = ['select', 'confirm', 'input', 'editor'];

/**
 * Every wait against a child is bounded, and leaves no timer behind either way.
 *
 * A child is not required to answer: it can be wedged, or have stopped reading
 * its stdin, or be gone without the parent having noticed. So no wait here ends
 * only when the child decides it does, and the deadline is cleared as soon as
 * it is moot rather than sitting in the loop until it fires.
 */
export async function within<T>(ms: number, work: Promise<T>, value: T): Promise<T> {
  const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
  try {
    return await Promise.race([
      work,
      new Promise<T>(resolve => { deadline.timer = setTimeout(() => resolve(value), ms); }),
    ]);
  } finally {
    clearTimeout(deadline.timer);
  }
}

/**
 * LF-only JSONL, on purpose.
 *
 * Node's `readline` also splits on U+2028 and U+2029, which are legal inside a
 * JSON string, so a child that quotes one would desynchronise the stream. A
 * partial frame is bounded rather than buffered forever.
 */
export function frames(onFrame: (value: unknown) => void, onOverflow: () => void) {
  const state = { buffer: '' };
  return (chunk: string): void => {
    state.buffer += chunk;
    if (state.buffer.length > MAX_FRAME_BYTES) {
      state.buffer = '';
      onOverflow();
      return;
    }
    const parts = state.buffer.split('\n');
    state.buffer = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      const value = ((): unknown => { try { return JSON.parse(line); } catch { return undefined; } })();
      if (value !== undefined) onFrame(value);
    }
  };
}

/**
 * The flags a child starts with.
 *
 * `--model` is deliberately absent. Passing it costs a flat ~30 seconds before
 * the child answers anything, measured on Pi 0.85.1 — even when asking for the
 * model the session already had. Starting on the inherited model takes ~360 ms
 * and the `set_model` command then switches in about a millisecond.
 *
 * The agent home is inherited too: it carries the model catalogue and the
 * credentials, and a child given an empty one has no models at all. What is
 * isolated is context — extensions, skills and prompt templates — not config.
 */
export function childArgs(guardPath: string, tools: readonly string[] = CHILD_TOOLS): string[] {
  return [
    '--mode', 'rpc',
    // Ambient discovery off; only the guard this package owns is loaded.
    '--no-extensions', '-e', guardPath,
    '--no-skills', '--no-prompt-templates',
    // Non-interactive: never prompt a person who is not watching.
    '--no-approve',
    // The inherited allowlist; the guard enforces the same set from inside.
    '--tools', tools.join(','),
  ];
}

/**
 * How to launch another `pi`.
 *
 * A session can be running from an npm install, from a Bun-compiled binary, or
 * from a single-file executable, and each of those is started differently. The
 * script this process was started with is the first answer, because it is the
 * same build the person is already using. `PI_SUBAGENTS_PI_COMMAND` overrides it for
 * an unusual host, and is the only path that takes a command from outside.
 */
export function piInvocation(args: readonly string[]): { command: string; args: string[] } {
  const override = process.env.PI_SUBAGENTS_PI_COMMAND?.trim();
  if (override) {
    const [command = 'pi', ...prefix] = override.split(' ').filter(Boolean);
    return { command, args: [...prefix, ...args] };
  }
  const script = process.argv[1];
  // A Bun virtual path exists only inside that process and cannot be spawned.
  const virtual = script?.startsWith('/$bunfs/root/') === true;
  if (script && !virtual && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  const host = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(host)) return { command: process.execPath, args: [...args] };
  return { command: 'pi', args: [...args] };
}

type Pending = Map<number, (value: Record<string, unknown>) => void>;

/**
 * Bash is a distinct, explicit capability, never an accidental side effect of
 * inheriting the parent's tool list. A read-only child cannot use it to become
 * a writer, even when the operator enabled Bash for writable children.
 */
export function selectChildTools(active: readonly string[], allowBash: boolean): string[] {
  const writer = active.includes('edit') || active.includes('write');
  return active.filter(name => name !== 'bash' || (allowBash && writer));
}

/** One `pi` child, spoken to over RPC. */
export function spawnRunner(options: {
  guardPath: string;
  extensionPaths?: string[];
  verifyCapabilities?: boolean;
  prepare?: (job: Job) => Promise<string>;
  /** How to launch the child. Injected so a test never reaches for a binary. */
  invoke?: (args: readonly string[]) => { command: string; args: string[] };
  /** Overridden only to widen what a child may call; never to add a writer. */
  tools?: readonly string[];
  /**
   * Where delegation stops. A child at the last allowed depth is started
   * without the tool and without it in the allowlist, so the brake is the
   * absence of the thing rather than a rule it is asked to follow.
   */
  depth?: number;
  /** Answers a child that asks for a child. Absent means delegation is off. */
  onDelegate?: (parent: Job, ask: DelegateAsk) => Promise<DelegateAnswer>;
  /** The models a child may switch to. Absent means it keeps what it has. */
  catalogue?: () => ModelChoice[];
  /** Where wire files live. Absent means siblings cannot reach each other. */
  wireRoot?: string;
  /** A child's question, escalated. Absent means the child is told to report. */
  onAsk?: (job: Job, question: string) => Promise<DelegateAnswer>;
  /** How often sibling mail is polled. Injected by the tests; 2s in life. */
  wireMs?: number;
  /** Injected so tests never reach for a real binary. */
  spawnProcess?: typeof spawn;
}): Runner {
  const start = options.spawnProcess ?? spawn;
  const invoke = options.invoke ?? piInvocation;
  const limit = options.depth ?? DEFAULT_LIMITS.depth;
  return async (job, emit) => {
    // The child's own depth, which is one below the job that is starting it.
    const depth = job.depth + 1;
    const mayDelegate = options.onDelegate !== undefined && depth < limit;
    /**
     * What the child may call: the tools the parent had at admission, or the
     * read-only set a job admitted before inheritance was promised. The guard
     * tools ride along; a test can still widen the whole set via options.
     */
    const inherited = options.tools ?? job.tools ?? READ_ONLY_TOOLS;
    const permitted = selectChildTools(inherited, process.env.PI_SUBAGENTS_ALLOW_BASH === '1');
    const wired = options.wireRoot !== undefined && job.wire !== undefined;
    const tools = [...new Set([...permitted, REPORT_TOOL, MODEL_TOOL, ASK_TOOL,
      ...(mayDelegate ? [DELEGATE_TOOL] : []),
      ...(wired ? [WIRE_SEND_TOOL, WIRE_INBOX_TOOL] : []),
    ])];
    const sessionFile = options.prepare ? await options.prepare(job) : undefined;
    const args = childArgs(options.guardPath, tools);
    if (sessionFile) args.push('--session', sessionFile);
    for (const path of options.extensionPaths ?? []) args.push('-e', path);
    const launch = invoke(args);
    if (sessionFile) emit({ type: 'session', file: sessionFile });
    const child: ChildProcess = start(launch.command, launch.args, {
      cwd: job.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so stopping the job stops everything it spawned.
      detached: true,
      env: {
        ...process.env,
        PI_SUBAGENTS_CHILD: '1',
        PI_SUBAGENTS_ROLE: job.role,
        PI_SUBAGENTS_VERIFY_TOOLS: '1',
        PI_SUBAGENTS_DEPTH: String(depth),
        // The guard enforces the identical list from inside, where a tool that
        // arrived some other way is held to it too.
        PI_SUBAGENTS_TOOLS: tools.join(','),
        ...(mayDelegate ? { PI_SUBAGENTS_CAN_DELEGATE: '1' } : {}),
        ...(wired ? {
          PI_SUBAGENTS_WIRE: job.wire as string,
          PI_SUBAGENTS_WIRE_ROOT: options.wireRoot as string,
          PI_SUBAGENTS_ALIAS: job.name,
        } : {}),
      },
    });

    const ready: { resolve?: (missing: string[]) => void } = {};
    const capabilities = new Promise<string[]>(resolve => { ready.resolve = resolve; });
    const pending: Pending = new Map();
    const claimed = new Map<string, unknown>();
    /** Sibling-mail forwarding state, declared before any terminal path runs. */
    const forward = { offset: 0, spent: 0, timer: undefined as ReturnType<typeof setInterval> | undefined };
    const state = {
      observed: undefined as Usage | undefined,
      toolCalls: 0,
      baseline: undefined as Usage | undefined,
      seq: 0, stderr: '',
      report: undefined as unknown,
      finishing: false, done: false,
      stopping: undefined as Promise<void> | undefined,
    };
    const send = (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = ++state.seq;
      const wait = new Promise<Record<string, unknown>>(resolve => pending.set(id, resolve));
      // Writing to a child that has already gone is expected during a stop, and
      // is an answer in itself rather than an exception to handle upstream.
      try { child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`); }
      catch {
        pending.delete(id);
        return Promise.resolve({ success: false, error: 'the child is not accepting input' });
      }
      return wait;
    };
    /** A frame with no command id: the dialog protocol answers by id, not by sequence. */
    const write = (frame: Record<string, unknown>): void => {
      try { child.stdin?.write(`${JSON.stringify(frame)}\n`); } catch { /* it is already gone */ }
    };
    // EPIPE on a dying child is routine; an unhandled one would take the parent.
    child.stdin?.on('error', () => undefined);

    /**
     * A child asking for something.
     *
     * Its one request-and-answer channel is the extension dialog protocol, and
     * every request on it is answered — a dialog left open is a child waiting
     * forever. A question this package did not ask is cancelled rather than
     * granted: a child cannot make the parent prompt a person who is not there.
     */
    const asked = async (message: Record<string, any>): Promise<void> => {
      if (!DIALOGS.includes(String(message.method))) return;
      const title = String(message.title ?? '');
      if (message.method !== 'input' || !title.startsWith(ASK_PREFIX)) {
        write({ type: 'extension_ui_response', id: message.id, cancelled: true });
        return;
      }
      const answer = await decide(title.slice(ASK_PREFIX.length));
      write({ type: 'extension_ui_response', id: message.id, value: JSON.stringify(answer) });
    };

    const decide = async (payload: string): Promise<DelegateAnswer> => {
      const ask = ((): unknown => {
        if (payload.length > MAX_ASK_BYTES) return undefined;
        try { return JSON.parse(payload); } catch { return undefined; }
      })();
      const kind = (ask as { kind?: unknown } | undefined)?.kind;
      if (kind === 'models') {
        return { ok: true, text: neutralCatalogue(options.catalogue?.() ?? []) };
      }
      if (kind === 'use_model') {
        if (!checkModelAsk(ask)) {
          return { ok: false, text: 'That request was not understood. It needs a provider and a modelId.' };
        }
        const wanted = ask as ModelAsk;
        // The catalogue is the closed list this session was given — a scoped
        // session scopes its children too, and a name outside the list is not
        // a model, whatever asked for it.
        const known = options.catalogue?.();
        if (known && !known.some(choice => choice.provider === wanted.provider && choice.modelId === wanted.modelId)) {
          return { ok: false, text: `${wanted.provider}/${wanted.modelId} is not a model this session has. `
            + 'Ask for the list, choose from it, or keep the model you have.' };
        }
        const chosen = await within(START_DEADLINE_MS,
          send({ type: 'set_model', provider: wanted.provider, modelId: wanted.modelId }),
          { success: false, error: 'it never answered' } as Record<string, unknown>);
        if (chosen.success !== true) {
          return { ok: false, text: `Could not switch to ${wanted.provider}/${wanted.modelId}: `
            + `${String(chosen.error ?? 'no reason given').slice(0, 200)}. Carry on with the model you have.` };
        }
        emit({ type: 'model', provider: wanted.provider, modelId: wanted.modelId });
        return { ok: true, text: `You are now running on ${wanted.provider}/${wanted.modelId}.` };
      }
      if (kind === 'ask') {
        if (!checkQuestionAsk(ask)) {
          return { ok: false, text: 'That question was not understood. It needs a question, in words.' };
        }
        if (!options.onAsk) {
          return { ok: false, text: 'There is no one to ask from here. Report what blocks you instead.' };
        }
        try { return await options.onAsk(job, (ask as { question: string }).question); }
        catch { return { ok: false, text: 'The question could not be sent. Report what blocks you instead.' }; }
      }
      if (kind !== 'delegate') {
        return { ok: false, text: 'That request was not understood, so nothing was started. '
          + 'It needs a kind: delegate, models, use_model, or ask.' };
      }
      if (!options.onDelegate || !mayDelegate) {
        return { ok: false, text: 'Delegation is not available from here. Report what you found and what you could not reach.' };
      }
      if (!checkAsk(ask)) {
        return { ok: false, text: 'That request was not understood, so nothing was started. It needs a role, a subject and a task.' };
      }
      // A refusal from the parent is an answer, never an exception the child
      // has to interpret from a broken dialog.
      try { return await options.onDelegate(job, ask as DelegateAsk); }
      catch { return { ok: false, text: 'The session that asked for this work could not take the request, so nothing was started.' }; }
    };

    /** At most one terminal event, whichever cause gets there first. */
    const terminal = (event: RunnerEvent): void => {
      if (state.done) return;
      if (forward.timer) { clearInterval(forward.timer); forward.timer = undefined; }
      // A stop already owns the reason (timeout, cancel). An abort makes the
      // child emit agent_settled without a report; that must not overwrite
      // "the clock ran out" with "ended without reporting".
      if (state.stopping && event.type === 'failed') return;
      state.done = true;
      emit(event);
    };

    /** What the run cost, from the child's own accounting. Absent is unknown. */
    const spent = async (): Promise<Usage | undefined> => {
      const answer = await within(STATS_MS, send({ type: 'get_session_stats' }), { success: false });
      const data = (answer as Record<string, any>).data;
      if (answer.success !== true || !data) return undefined;
      const usage: Usage = {
        ...(typeof data.tokens?.total === 'number' ? { tokens: data.tokens.total } : {}),
        ...(typeof data.cost === 'number' ? { cost: data.cost } : {}),
        ...(typeof data.toolCalls === 'number' ? { calls: data.toolCalls } : {}),
      };
      if (state.baseline) {
        for (const key of ['tokens', 'cost', 'calls'] as const) {
          if (usage[key] !== undefined && state.baseline[key] !== undefined) usage[key] = Math.max(0, usage[key]! - state.baseline[key]!);
        }
      }
      return Object.keys(usage).length > 0 ? usage : undefined;
    };

    /**
     * The run is over. An accepted report ends it immediately: a child that has
     * reported has nothing left to do, and whatever it would say next is spend
     * nobody asked for.
     */
    const finish = async (): Promise<void> => {
      if (state.finishing || state.stopping) return;
      state.finishing = true;
      const usage = state.observed ? { ...state.observed, calls: state.toolCalls } : await spent();
      if (state.report === undefined) {
        terminal({ type: 'failed', reason: 'The child ended without reporting.', ...(usage ? { usage } : {}) });
        return;
      }
      terminal({ type: 'settled', report: state.report, ...(usage ? { usage } : {}) });
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Kept bounded and never forwarded to the model: it is diagnostics.
      state.stderr = `${state.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', frames(value => {
      const message = value as Record<string, any>;
      if (!state.done && message.type === 'tool_execution_start') state.toolCalls += 1;
      if (!state.done && message.type === 'message_end' && message.message?.role === 'assistant') {
        const usage = message.message.usage;
        if (usage && typeof usage.totalTokens === 'number') state.observed = {
          tokens: (state.observed?.tokens ?? 0) + usage.totalTokens,
          ...(typeof usage.cost?.total === 'number' ? { cost: (state.observed?.cost ?? 0) + usage.cost.total } : {}),
        };
      }
      const activity = activityOf(message);
      if (activity && !state.done) emit({ type: 'activity', activity });
      if (message.type === 'extension_ui_request' && message.method === 'notify' && String(message.message).startsWith(READY_PREFIX)) {
        try { const data = JSON.parse(String(message.message).slice(READY_PREFIX.length)); if (Array.isArray(data.missing)) ready.resolve?.(data.missing); } catch { /* malformed startup message */ }
        return;
      }
      if (message.type === 'response' && typeof message.id === 'number') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        return;
      }
      /**
       * The report is the arguments of the child's own report call, read off
       * the event stream. There is no side channel to trust, no transcript to
       * scrape, and nothing the child says in prose can be mistaken for one.
       */
      if (message.type === 'tool_execution_start' && message.toolName === REPORT_TOOL) {
        if (claimed.size >= MAX_OPEN_REPORTS) claimed.delete(claimed.keys().next().value as string);
        claimed.set(String(message.toolCallId), message.args);
        return;
      }
      if (message.type === 'tool_execution_end' && message.toolName === REPORT_TOOL) {
        const args = claimed.get(String(message.toolCallId));
        claimed.delete(String(message.toolCallId));
        // A rejected call is the child's own guard telling it to fix the report.
        // The parent hears only about the one the child stood behind.
        if (message.isError === true || args === undefined) return;
        state.report = args;
        emit({ type: 'report', report: args });
        void finish();
        return;
      }
      // Settlement is `agent_settled`, not `agent_end`: an agent_end can be
      // followed by an automatic retry, and a job must not be called finished
      // while the child is still going.
      if (message.type === 'agent_settled') {
        void finish();
        return;
      }
      if (message.type === 'extension_ui_request' && message.id !== undefined) {
        void asked(message);
        return;
      }
      if (message.type === 'extension_error') {
        terminal({ type: 'failed', reason: `The child's guard failed: ${String(message.error).slice(0, 200)}` });
      }
    }, () => terminal({ type: 'failed', reason: 'The child sent a frame past the size this accepts.' })));

    /** Resolves the moment the process is actually gone, and never on a timer. */
    const departed = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const alive = (): boolean => child.exitCode === null && child.signalCode === null;

    child.on('exit', code => {
      for (const resolve of pending.values()) resolve({ success: false });
      pending.clear();
      emit({ type: 'exit', code });
      // A death nobody asked for is a settlement too, and it says so with what
      // the child last wrote to stderr rather than with silence.
      if (state.finishing || state.stopping) return;
      const tail = state.stderr.trim().replace(/\s+/g, ' ').slice(-STDERR_EXCERPT);
      terminal({
        type: 'failed',
        reason: `The child exited (${code}) without reporting.${tail ? ` It last said: ${tail}` : ''}`,
      });
    });
    child.on('error', error => {
      terminal({ type: 'failed', reason: `The child could not start: ${error.message}` });
    });

    /**
     * Ask, then insist, and only ever on the group this runner made.
     *
     * Both waits are bounded. A child that has stopped reading its stdin cannot
     * acknowledge the abort, and a child wedged in a syscall may not answer the
     * SIGTERM either; neither may leave the caller waiting forever, because a
     * stop that can hang is how a cancelled job becomes an orphan.
     */
    const end = async (): Promise<void> => {
      if (!alive()) return;
      await within<unknown>(ABORT_ACK_MS, send({ type: 'abort' }), undefined);
      if (!alive()) return;
      kill(child, 'SIGTERM');
      await within<unknown>(STOP_GRACE_MS, departed, undefined);
      if (alive()) kill(child, 'SIGKILL');
    };
    // Memoised, so stopping twice joins one stop instead of believing a stop
    // that is still in flight has already finished.
    const stop = (_reason: string): Promise<void> => (state.stopping ??= end());

    /**
     * Words for a live child. A steer rides beside a running turn; an idle
     * child needs a prompt to start one. A child that has reported gets
     * nothing: its session is over and its report already said what it knew.
     */
    const steer = async (message: string): Promise<boolean> => {
      if (state.done || !alive()) return false;
      const steered = await within(2_000, send({ type: 'steer', message }), { success: false } as Record<string, unknown>);
      if (steered.success === true) return true;
      if (state.report !== undefined || state.done) return false;
      const prompted = await within(2_000, send({ type: 'prompt', message }), { success: false } as Record<string, unknown>);
      return prompted.success === true;
    };

    // Selecting the model is a command, not a flag, for the reason above. An
    // unavailable model fails the job here rather than quietly running on
    // whatever the session happened to have.
    const chosen = await within(START_DEADLINE_MS,
      send({ type: 'set_model', provider: job.provider, modelId: job.modelId }),
      { success: false, error: 'it never answered' } as Record<string, unknown>);
    if (chosen.success !== true) {
      const why = String(chosen.error ?? 'no reason given').slice(0, 200);
      terminal({ type: 'failed', reason: `The child could not use ${job.provider}/${job.modelId}: ${why}` });
      // The teardown runs on its own; the handle is how a caller joins it.
      void stop('model unavailable');
      return { stop, steer };
    }

    /**
     * The task itself, assembled from the job and from nothing else: no parent
     * conversation, no third party's message, no environment. Acceptance means
     * the prompt was taken, not that the work is done.
     */
    if (options.verifyCapabilities) {
      const missing = await within(5_000, capabilities, ['capability handshake unavailable']);
      if (missing.length || state.done) {
        terminal({ type: 'failed', reason: `Child capabilities unavailable: ${missing.join(', ')}. Configure extensionPackages explicitly.` });
        void stop('capabilities unavailable');
        return { stop, steer };
      }
    }
    if (job.resumeSession) state.baseline = await spent();
    const taken = await within(START_DEADLINE_MS,
      send({ type: 'prompt', message: childPrompt({ ...job, tools: permitted, canDelegate: mayDelegate, wired }) }),
      { success: false, error: 'it never answered' } as Record<string, unknown>);
    if (taken.success !== true) {
      const why = String(taken.error ?? 'no reason given').slice(0, 200);
      terminal({ type: 'failed', reason: `The child would not take the task: ${why}` });
      void stop('task refused');
      return { stop, steer };
    }

    /**
     * Sibling mail, pushed. Each message for this child is steered in once,
     * tracked by byte offset so a reload of the loop repeats nothing, and a
     * per-child budget cuts a ping-pong loop off instead of feeding it.
     * Everything is best-effort: the file keeps what a steer could not
     * deliver, and the child's own subagent_inbox can still read it.
     */
    const FORWARD_BUDGET = 24;
    if (wired) {
      const root = options.wireRoot as string;
      const tree = job.wire as string;
      const poll = (): void => {
        void readWire(root, tree, forward.offset, job.name).then(async found => {
          forward.offset = found.offset;
          for (const message of found.messages) {
            if (forward.spent >= FORWARD_BUDGET || state.done) return;
            if (message.from === job.name) continue;
            forward.spent += 1;
            await send({
              type: 'steer',
              message: `Message from ${message.from}, a sibling working beside you on the same task:\n`
                + `${message.subject}\n${message.body}\nAnswer it with subagent_send if it needs one; then get back to your task.`,
            });
          }
        }).catch(() => undefined);
      };
      // Once now — mail posted while the child was starting is still mail —
      // then on the interval.
      poll();
      forward.timer = setInterval(poll, options.wireMs ?? 2_000);
      forward.timer.unref?.();
    }

    emit({ type: 'running' });

    /**
     * Where the child's transcript lives, for the takeover view. Best-effort:
     * a child that never answers still has a panel, just not a live one.
     */
    const where = await within(1_500, send({ type: 'get_state' }), { success: false } as Record<string, unknown>);
    const file = (where as Record<string, any>).data?.sessionFile;
    if (where.success === true && typeof file === 'string') emit({ type: 'session', file });

    return { stop, steer };
  };
}

/** Signal the whole group, and never a pid this runner does not own. */
function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid !== 'number') return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}
