import { defaultSettings, loadSettings, roleTools, extensionPaths, agentHome } from './config.ts';
import { cleanupStorage, storageRoot, sessionRoot, prepareSession, retainSettlement, resumable } from './storage.ts';
import { inProcessRunner } from './in-process.ts';
import type { Activity } from './activity.ts';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { choiceHint, eligible, findChoice, modelKey, resolveWorkDir, type ModelChoice } from './context.ts';
import { makeJobs, type Jobs } from './jobs.ts';
import { DEFAULT_LIMITS, find, live, undelivered, unresolved } from './manager.ts';
import { needsAttention, jobView, ledgerLines, ledgerView, resultContent, themedJobLine } from './render.ts';
import { getActiveRoot, registerHandle } from './host.ts';
import { plain } from './text.ts';
import { openAgentsPanel } from './panel.ts';
import { AUTO_MAX, TRIAGE_SYSTEM, parseTriage, worthTriaging } from './auto.ts';
import { selectSpecificationTopics } from './checklist.ts';
import { FACTORY_AGENTS, factoryAgent, factoryCatalogue, type FactoryAgent } from './factory.ts';
import { cleanupExternalWorkspaces, createExternalWorkspace, discardExternalWorkspace, finalizeExternalWorkspace, type ExternalWorkspace } from './workspace.ts';
import { spawnRunner } from './runner.ts';
import { READ_ONLY_TOOLS, ROLES, checkLedger, isTerminal, type DelegateAnswer, type DelegateAsk, type Job, type Ledger, type Role } from './schema.ts';

/**
 * pi-subagents: ephemeral subagents a session delegates to, usable on their
 * own — no team, no alias, no mailbox required. When pi-team is loaded beside
 * this package it files jobs under the thread they were born in, through the
 * registry in host.ts; nothing here requires it.
 *
 * The surface: two tools, the entries that make a reload and the panel work,
 * and the wiring that turns a settled job into one message.
 *
 * Everything expensive is kept out of the model's context. The ledger travels
 * as a session entry, which is free and is what the panel already reads; only
 * the bounded result of a finished job is ever sent, and only once.
 */
// The compiled local build (scripts/build-pi.mjs) ships child.js beside index.js; source runs keep child.ts.
const GUARD = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './child.ts' : './child.js', import.meta.url));
/** Only while something is open. Nothing here polls an idle session. */
const TICK_MS = 5_000;
/**
 * Ledger snapshots were written on every commit: five within a second for one
 * delegation, each carrying every report again. Real sessions accumulated 47MB
 * of them in three days, 60% within two seconds of the previous one.
 */
const LEDGER_WRITE_MS = 1_000;

export type JobsOptions = {
  /** The mailbox thread a job belongs to, when it was born inside one. */
  activeRoot?: () => string | undefined;
  /** Injected by the tests; the real one spawns `pi`. */
  makeRunner?: typeof spawnRunner;
  /** Injected by the tests; the real one asks the cheapest model on the registry. */
  complete?: (system: string, user: string, ctx: ExtensionContext) => Promise<string>;
  /** Injected by the tests; the real one lives beside the agent directory. */
  wireRoot?: string;
  /** External factory workspaces. Defaults to ~/.prjct/subagents/workspaces. */
  workspaceRoot?: string;
  tickMs?: number;
  /** Coalescing window for ledger snapshots; 0 writes every commit. */
  ledgerWriteMs?: number;
};

/** Auto-delegation starts off; a person turns it on with /agents auto on. */
function autoFromEnv(): boolean {
  const raw = process.env.PI_AGENTS_AUTO?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * What the rest of the extension needs from this one, and nothing more: the
 * lines for a plain list, the ledger for anything that draws, and the one
 * control — stop — that a panel or a neighbour package may ask for.
 */
export type JobsHandle = {
  lines: () => string[];
  ledger: () => Ledger | undefined;
  cancel: (jobId: string, reason: string) => Promise<void>;
  /** Words for a live child, from a person at the panel. */
  steer: (jobId: string, message: string) => Promise<boolean>;
  resume?: (jobId: string, message: string) => Promise<Job>;
  activity?: (jobId: string) => Activity[];
  subscribe?: (listener: () => void) => () => void;
  limits?: () => typeof DEFAULT_LIMITS;
};

export function installJobs(pi: ExtensionAPI, options: JobsOptions = {}): JobsHandle {
  // pi-team registers a provider through the registry when a team task can be
  // open; an explicit option still wins, which is how tests stay hermetic.
  const activeRoot = options.activeRoot ?? getActiveRoot;
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  const inFlight = new Map<string, number>();
  const recorded = new Set<string>();
  const retained = new Set<string>();
  /**
   * A job whose full record, report included, was already appended as an
   * `agent-job` entry keeps only a reference in later snapshots; restore puts
   * the report back from that entry.
   */
  const compactLedger = (ledger: Ledger): Ledger => ({
    ...ledger,
    jobs: ledger.jobs.map(job => recorded.has(job.id) && job.report ? { ...job, report: undefined } : job),
  });
  const ledgerWrite = {
    pending: undefined as Ledger | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    terminal: new Set<string>(),
  };
  const flushLedger = (): void => {
    if (ledgerWrite.timer) clearTimeout(ledgerWrite.timer);
    ledgerWrite.timer = undefined;
    const ledger = ledgerWrite.pending;
    ledgerWrite.pending = undefined;
    if (ledger) pi.appendEntry('agent-jobs', compactLedger(ledger));
  };
  const persistLedger = (ledger: Ledger): void => {
    ledgerWrite.pending = ledger;
    // A job reaching a terminal state is written at once: its report must not
    // sit in a timer when the process goes away.
    const settled = ledger.jobs.filter(job => isTerminal(job.state) && !ledgerWrite.terminal.has(job.id));
    for (const job of settled) ledgerWrite.terminal.add(job.id);
    const windowMs = options.ledgerWriteMs ?? LEDGER_WRITE_MS;
    if (windowMs <= 0 || settled.length > 0) { flushLedger(); return; }
    if (ledgerWrite.timer) return;
    ledgerWrite.timer = setTimeout(flushLedger, windowMs);
    ledgerWrite.timer.unref?.();
  };
  const state = {
    settings: defaultSettings(),
    delivering: false,
    ctx: undefined as ExtensionContext | undefined,
    jobs: undefined as Jobs | undefined,
    running: false,
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    choices: [] as ModelChoice[],
    widget: undefined as string | undefined,
    /** Auto-delegation: the toggle, and whether a triage call is in flight. */
    auto: { enabled: autoFromEnv(), inFlight: false },
    /** Set on shutdown: nothing admits a child into a session that is leaving. */
    closed: false,
  };

  const ctx = (): ExtensionContext => {
    if (!state.ctx) throw new Error('This session is not ready to delegate yet.');
    return state.ctx;
  };

  /**
   * The models this session can actually reach. Resolved once per session
   * rather than per call: it is the same list every time, and a parent that
   * asks for something outside it is told what there is.
   */
  const choices = (context: ExtensionContext): ModelChoice[] => {
    const registry = (context as any).modelRegistry;
    const available = typeof registry?.getAvailable === 'function' ? registry.getAvailable() : [];
    const scoped = ((context as any).scopedModels ?? []).map((entry: any) => entry?.model).filter(Boolean);
    return eligible({ available, scoped });
  };

  /**
   * The tools a child inherits: whatever this session may use right now, minus
   * this package's own parent tools — a child asks for children through the
   * guard, never through agent_delegate. In plan mode the active set is
   * already read-only, so a child born there is a reader too. Bash is a
   * separate, explicit capability: it is inherited only by a writable child
   * when the operator opted in, and it is never described as a sandbox.
   */
  const inheritedTools = (role: Role): string[] => {
    try {
      const active = pi.getActiveTools().filter(name => name !== 'agent_delegate' && name !== 'agent_jobs');
      return roleTools(role, active);
    } catch {
      return [...READ_ONLY_TOOLS];
    }
  };

  const factoryTools = (profile: FactoryAgent | undefined, role: Role, available = inheritedTools(role)): string[] => {
    if (!profile) return available;
    const safe = ['read', 'grep', 'find', 'ls', 'edit', 'write'];
    return available.filter(tool => safe.includes(tool) && (role === 'worker' || (READ_ONLY_TOOLS as readonly string[]).includes(tool)));
  };
  const resolveProfile = (agent?: string, role?: Role): { role: Role; profile?: FactoryAgent } => {
    if (agent && role) throw new Error('Choose either a factory agent or a base role, not both.');
    if (agent) { const profile = factoryAgent(agent); return { role: profile.role, profile }; }
    if (role) return { role };
    throw new Error(`Choose an agent (${FACTORY_AGENTS.join(', ')}) or a base role (${ROLES.join(', ')}).`);
  };
  const externalWorkspace = async (profile: FactoryAgent | undefined, source: string): Promise<ExternalWorkspace | undefined> =>
    profile?.workspace === 'isolated' ? createExternalWorkspace(source, options.workspaceRoot) : undefined;

  /** A model a job may run on: the one asked for, or this session's own. */
  const resolve = (wanted?: string): { provider: string; modelId: string } | { refused: string } => {
    const current = (state.ctx as any)?.model;
    if (!wanted?.trim()) {
      if (!current?.provider || !current?.id) return { refused: 'This session has no model to give a job.' };
      return { provider: current.provider, modelId: current.id };
    }
    const asked = wanted.trim();
    const exact = findChoice(state.choices, asked)
      ?? state.choices.find(choice => choice.modelId === asked);
    if (!exact) {
      return { refused: `${asked} is not a model this session has. Available: ${state.choices.map(choice => choice.key).join(', ')}.` };
    }
    return { provider: exact.provider, modelId: exact.modelId };
  };

  /** Deliver what finished, once, at a point the session can take a message. */
  const deliver = (): void => {
    const context = state.ctx;
    const jobs = state.jobs;
    if (!context || !jobs || state.closed || state.delivering) return;
    // Idle and running are the two states Pi accepts a message in. Anything
    // else — compaction, most of all — waits for the next tick.
    const idle = context.isIdle();
    if (!idle && !state.running) return;
    const confirmed = new Set<string>((context.sessionManager.getBranch() as any[]).flatMap(entry =>
      entry.type === 'custom_message' && entry.customType === 'agent-job-result' ? entry.details?.deliveryIds ?? [] : []));
    const receipts = jobs.pending().filter(job => confirmed.has(job.id)).map(job => job.id);
    if (receipts.length) { for (const id of receipts) inFlight.delete(id); jobs.acknowledge(receipts); }
    const done = jobs.pending().filter(job => {
      const attempt = inFlight.get(job.id);
      return attempt === undefined || (idle && !context.hasPendingMessages?.() && Date.now() - attempt >= (options.tickMs ?? TICK_MS));
    });
    if (done.length === 0) return;
    state.delivering = true;
    try {
      for (const job of done) {
        if (recorded.has(job.id)) continue;
        pi.appendEntry('agent-job', job);
        recorded.add(job.id);
      }
      for (const job of done) inFlight.set(job.id, Date.now());
      pi.sendMessage(
        { customType: 'agent-job-result', display: true, details: { jobs: done, deliveryIds: done.map(job => job.id) }, content: resultContent(done) },
        idle ? { triggerTurn: true, deliverAs: 'followUp' } : { deliverAs: 'steer' },
      );
      // ExtensionAPI.sendMessage is fire-and-forget. Only a message event or a
      // persisted receipt proves delivery; returning from this call does not.
    } catch {
      for (const job of done) inFlight.delete(job.id);
      startTicking();
    } finally { state.delivering = false; }
  };

  const stopTicking = (): void => {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = undefined;
  };

  const tick = (): void => {
    const jobs = state.jobs;
    if (!jobs) return;
    showWidget();
    void jobs.tick().then(deliver).catch(() => undefined);
    if (live(jobs.ledger()).length === 0 && jobs.pending().length === 0) stopTicking();
  };

  const startTicking = (): void => {
    if (state.timer || state.closed) return;
    state.timer = setInterval(tick, options.tickMs ?? TICK_MS);
    // A pending timer must never be the reason a session cannot exit.
    state.timer.unref?.();
  };

  /** A child asking for a child. The parent decides, and says what it decided. */
  const onDelegate = async (parent: Job, ask: DelegateAsk): Promise<DelegateAnswer> => {
    const jobs = state.jobs;
    if (!jobs) return { ok: false, text: 'The session that asked for this work is not able to start anything.' };
    try {
      const choice = resolveProfile(ask.agent, ask.role);
      if (choice.profile?.explicitOnly) return { ok: false, text: `${choice.profile.name} requires an explicit request from the user.` };
      const model = resolve(ask.model);
      if ('refused' in model) return { ok: false, text: model.refused };
      const workspace = await externalWorkspace(choice.profile, parent.cwd);
      const decision = await jobs.delegate({
        role: choice.role, ...(choice.profile ? { agent: choice.profile.name } : {}),
        subject: ask.subject, task: ask.task, context: ask.context,
        // A grandchild inherits what its parent was given, never more — tools,
        // and the wire: the whole tree talks on one file.
        tools: factoryTools(choice.profile, choice.role, roleTools(choice.role, parent.tools ?? READ_ONLY_TOOLS)), runner: state.settings.runner,
        ...(parent.wire ? { wire: parent.wire } : {}),
        ...model, cwd: workspace?.cwd ?? parent.cwd,
        ...(workspace ? workspace : {}),
        depth: parent.depth + 1, parentJobId: parent.id,
        ...(parent.rootId ? { rootId: parent.rootId } : {}),
      });
      if (!decision.ok || decision.repeated) {
        if (workspace) await discardExternalWorkspace(workspace);
        if (!decision.ok) return { ok: false, text: decision.reason };
      }
      startTicking();
      return {
        ok: true,
        text: `Accepted: ${decision.job.name} is on it, beside you. It reports to the session that asked `
          + 'for your work, not to you, so do not wait for it. Carry on with your own task.',
      };
    } catch (error) { return { ok: false, text: String((error as Error).message ?? error).slice(0, 500) }; }
  };

  /**
   * One line above the editor while any job is live, nothing when idle. It is
   * the same ledger the panel draws, so the two can never disagree; the 5s
   * tick that already runs for live jobs is what keeps the times moving.
   */
  const showWidget = (): void => {
    const context = state.ctx;
    if (!context || !context.hasUI) return;
    const all = state.jobs?.ledger().jobs ?? [];
    const active = all.filter(job => !isTerminal(job.state) && job.state !== 'queued');
    const queued = all.filter(job => job.state === 'queued');
    const attention = all.filter(needsAttention);
    const statuses = [`● ${active.length}`, ...(queued.length ? [`○ ${queued.length}`] : []), ...(attention.length ? [`! ${attention.length}`] : [])];
    const text = active.length ? `󰚩  Agents  ${statuses.join('  ')}  /agents` : undefined;
    if (text === state.widget) return;
    state.widget = text;
    context.ui.setWidget('agents', text === undefined ? undefined : [text]);
  };

  /** One bounded answer from the cheapest model this session can reach. */
  const complete = options.complete ?? (async (system: string, user: string, context: ExtensionContext): Promise<string> => {
    const cheapest = state.choices[0];
    const registry = (context as any).modelRegistry;
    const model = cheapest
      ? registry?.getAvailable?.().find((m: any) => m?.provider === cheapest.provider && m?.id === cheapest.modelId)
      : undefined;
    if (!model) return '';
    const { completeSimple } = await import('@earendil-works/pi-ai/compat');
    const reply = await completeSimple(model, {
      systemPrompt: system,
      messages: [{ role: 'user', content: user, timestamp: Date.now() }],
    } as any);
    return (reply.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
  });

  /**
   * Triage one typed prompt, and launch what it earns.
   *
   * The turn the prompt started is never waited on: the call runs beside it,
   * and the session is told what was launched as a steer — so the model learns
   * what is already being read before it goes and reads the same things.
   */
  const triageAndLaunch = async (prompt: string, context: ExtensionContext): Promise<void> => {
    const jobs = state.jobs;
    if (!jobs || state.closed) return;
    const plan = parseTriage(await complete(TRIAGE_SYSTEM, `Working directory: ${context.cwd}\n\nTask:\n${prompt}`, context));
    // The triage call outlives nothing: a shutdown that landed while it ran
    // must not find a fresh child beside a session that is gone.
    if (!plan.complex || state.closed) return;
    const launched: Job[] = [];
    for (const subtask of plan.subtasks.slice(0, AUTO_MAX)) {
      // The session's own model to start; the child chooses from there.
      const model = resolve(undefined);
      if ('refused' in model) break;
      const key = `auto:${createHash('sha256').update(`${prompt}:${subtask.subject}`).digest('hex').slice(0, 16)}`;
      const rootId = activeRoot();
      const decision = await jobs.delegate({
        role: subtask.role, subject: subtask.subject, task: subtask.task,
        context: `The person asked the session you are assisting:\n${prompt.slice(0, 800)}`,
        ...model, cwd: context.cwd, depth: 0, tools: inheritedTools(subtask.role), runner: state.settings.runner, key,
        ...(rootId ? { rootId } : {}),
      });
      if (decision.ok && !decision.repeated) launched.push(decision.job);
    }
    if (launched.length === 0) return;
    startTicking();
    const content = [
      `This task was complex enough to auto-launch ${launched.length} expert subagent${launched.length === 1 ? '' : 's'} beside you:`,
      ...launched.map(job => `- ${plain(job.name)} (${job.role}) — ${plain(job.subject)}`),
      'They read in parallel with fresh context and their evidence arrives here. Do not redo their '
        + 'reading; integrate their reports when they land. Stop one with agent_jobs if it is wrong.',
    ].join('\n');
    try {
      pi.sendMessage({ customType: 'agents-auto', display: true, details: { jobs: launched }, content },
        context.isIdle() ? { triggerTurn: true, deliverAs: 'followUp' } : { deliverAs: 'steer' });
    } catch { /* the session is closing */ }
  };

  /**
   * A child's question climbs the tree one level at a time. A live parent job
   * hears it as a steer and answers on the wire; a question with no parent job
   * left belongs to this session, whose model answers with agent_reply. Either
   * way the child is told the same thing: it was sent, do not wait for it.
   */
  const onAsk = async (job: Job, question: string): Promise<DelegateAnswer> => {
    const jobs = state.jobs;
    if (!jobs) return { ok: false, text: 'The question could not be sent. Report what blocks you instead.' };
    jobs.question(job.id, question);
    const parent = job.parentJobId ? find(jobs.ledger(), job.parentJobId) : undefined;
    if (parent && !isTerminal(parent.state)) {
      const sent = await jobs.steerTo(parent.id,
        `Your delegated child ${plain(job.name)} (${plain(job.subject)}) asks: ${plain(question)}\n`
        + `Answer on the wire with subagent_send to "${job.name}". If the answer is not yours to give, ask your own parent with subagent_ask.`);
      if (sent) {
        return { ok: true, text: `Sent to ${parent.name}, who asked for your work. The answer arrives by itself; do not wait for it.` };
      }
    }
    const context = state.ctx;
    if (context) {
      try {
        pi.sendMessage({
          customType: 'agents-ask', display: true, details: { job, question },
          content: `${plain(job.name)} — a subagent this session launched (${plain(job.subject)}) — asks: ${plain(question)}\n`
            + `Answer with the agent_reply tool (name: "${job.name}"). If the answer is not yours to give, say so in the answer.`,
        }, context.isIdle() ? { triggerTurn: true, deliverAs: 'followUp' } : { deliverAs: 'steer' });
        return { ok: true, text: 'Sent to the session that launched you. The answer arrives by itself; do not wait for it.' };
      } catch { /* the session is closing */ }
    }
    return { ok: false, text: 'There is no one to ask right now. Report what blocks you instead.' };
  };

  const build = (session: string): Jobs => {
    const directory = sessionRoot(session);
    const runnerOptions = {
      guardPath: GUARD, verifyCapabilities: true, depth: state.settings.limits.depth, onDelegate, onAsk, catalogue: () => state.choices,
      wireRoot: options.wireRoot ?? directory,
      extensionPaths: extensionPaths(state.settings.extensionPackages, ctx().cwd),
      prepare: (job: Job) => prepareSession(job, directory),
    };
    const factory = options.makeRunner ?? (state.settings.runner === 'in-process' ? inProcessRunner : spawnRunner);
    return makeJobs(session, {
      runner: factory(runnerOptions), limits: state.settings.limits,
      now: () => Date.now(),
      persist: persistLedger,
      onActivity: notify,
      onChange: ledger => {
        if (live(ledger).length > 0 || undelivered(ledger).length > 0) startTicking();
        for (const job of (options.makeRunner ? [] : ledger.jobs).filter(job => isTerminal(job.state) && !retained.has(job.id))) {
          retained.add(job.id);
          const workspace = job.patchFile ? finalizeExternalWorkspace({ cwd: job.cwd, patchFile: job.patchFile }) : Promise.resolve('');
          void Promise.all([retainSettlement(job, directory), workspace]).catch(() => retained.delete(job.id));
        }
        showWidget();
        notify();
        if (undelivered(ledger).length > 0) queueMicrotask(deliver);
      },
    });
  };

  const steerJob = async (jobId: string, message: string): Promise<boolean> => {
    if (!message.trim() || message.length > 4000) throw new Error('Send between 1 and 4,000 characters.');
    const sent = await state.jobs?.steerTo(jobId, message) ?? false;
    if (sent) {
      state.jobs?.question(jobId, undefined);
      state.jobs?.record(jobId, { kind: 'message', text: `You: ${message}` });
    }
    return sent;
  };
  const resumeJob = async (jobId: string, message: string, key?: string): Promise<Job> => {
    const jobs = state.jobs;
    const original = jobs && find(jobs.ledger(), jobId);
    if (!jobs || !original) throw new Error('Unknown job in this session.');
    if (key) { const previous = jobs.ledger().jobs.find(job => job.key === key); if (previous) return previous; }
    if (!message.trim() || message.length > 4000) throw new Error('Send between 1 and 4,000 characters.');
    const sessionFile = await resumable(original, state.settings.retentionDays);
    const allowed = inheritedTools(original.role).filter(tool => ([...original.tools ?? READ_ONLY_TOOLS] as readonly string[]).includes(tool));
    const dir = resolveWorkDir(ctx().cwd, original.cwd);
    if ('refused' in dir) throw new Error(dir.refused);
    const model = resolve(`${original.provider}/${original.modelId}`);
    if ('refused' in model) throw new Error(model.refused);
    const result = await jobs.delegate({ role: original.role, ...(original.agent ? { agent: original.agent } : {}),
      subject: original.subject, task: message,
      context: 'Continue the retained conversation. Previous reports are historical; return a new report for this request.',
      ...model, cwd: dir.cwd, ...(original.sourceCwd ? { sourceCwd: original.sourceCwd } : {}),
      ...(original.workspace ? { workspace: original.workspace } : {}), ...(original.patchFile ? { patchFile: original.patchFile } : {}),
      tools: allowed, depth: 0, key, rootId: original.rootId,
      resumedFrom: original.id, resumeSession: sessionFile, runner: state.settings.runner });
    if (!result.ok) throw new Error(result.reason);
    return result.job;
  };

  pi.registerEntryRenderer('agent-jobs', () => new Container());
  pi.registerEntryRenderer<Job>('agent-job', (entry, { expanded }, theme) => jobView(entry.data, expanded, theme));
  pi.registerMessageRenderer<{ jobs?: Job[] }>('agent-job-result', (message, { expanded }, theme) => {
    const jobs = message.details?.jobs ?? [];
    const heading = theme.fg('toolTitle', theme.bold(`▸ ${jobs.length} job${jobs.length === 1 ? '' : 's'} reported`));
    if (!expanded) return new Text(heading, 0, 0);
    return new Text([heading, ...jobs.map(job => themedJobLine(job, theme))].join('\n'), 1, 0);
  });

  /**
   * Registered again on every session start, because the description carries
   * what this session's models cost, and that is only knowable from a context.
   */
  const registerDelegate = (hint: string): void => {
    pi.registerTool({
      name: 'agent_delegate',
      label: 'Delegate a job',
      description: 'Start one separable job with either a package-owned factory agent or a base role. Factory implementers and documenters '
        + 'write only in external snapshots under ~/.prjct/subagents; documentation requires an explicit user request. Factory agents never inherit Bash or third-party mutation tools. '
        + 'Base explorer and reviewer roles are read-only. A legacy worker may inherit active write tools and opt-in unrestricted Bash. The job reports evidence and ends; do not wait for it. '
        + `Factory agents:\n${factoryCatalogue()}\n${hint}`,
      parameters: Type.Object({
        agent: Type.Optional(StringEnum(FACTORY_AGENTS)),
        role: Type.Optional(StringEnum(ROLES)),
        requestedByUser: Type.Optional(Type.Boolean({ description: 'True only when the user explicitly requested product documentation.' })),
        subject: Type.String({ minLength: 1, maxLength: 160 }),
        task: Type.String({ minLength: 1, maxLength: 24000 }),
        context: Type.Optional(Type.String({ maxLength: 24000 })),
        model: Type.Optional(Type.String({ maxLength: 256 })),
        cwd: Type.Optional(Type.String({ maxLength: 4096 })),
      }),
      async execute(toolCallId: string, input: any) {
        const jobs = state.jobs;
        if (!jobs) throw new Error('This session is not ready to delegate yet.');
        const choice = resolveProfile(input.agent, input.role);
        if (choice.profile?.explicitOnly && input.requestedByUser !== true) throw new Error(`${choice.profile.name} runs only after an explicit user request.`);
        if (choice.profile?.name === 'product-documenter' && state.settings.artifactPolicy === 'none') throw new Error('Product documentation artifacts are disabled by artifactPolicy.');
        const model = resolve(input.model);
        if ('refused' in model) throw new Error(model.refused);
        const dir = resolveWorkDir(ctx().cwd, input.cwd);
        if ('refused' in dir) throw new Error(dir.refused);
        const topics = choice.profile?.name === 'specification-architect' ? await selectSpecificationTopics(ctx()) : [];
        if (topics === undefined) throw new Error('Specification clarification was cancelled.');
        const clarification = choice.profile?.name === 'specification-architect'
          ? `Operator clarification focus: ${topics.length ? topics.join(', ') : 'no additional topics selected'}. Ask concise follow-up questions only where consequential uncertainty remains.` : '';
        const delegatedContext = [input.context, clarification].filter(Boolean).join('\n\n');
        if (Buffer.byteLength(input.task, 'utf8') + Buffer.byteLength(delegatedContext, 'utf8') > state.settings.limits.taskBytes) throw new Error('Task and clarification context exceed the configured delegation limit.');
        const workspace = await externalWorkspace(choice.profile, dir.cwd);
        // A job born inside a team thread is filed under it when a host that
        // knows about teams registered a provider; without one it stands alone.
        const rootId = activeRoot();
        const decision = await jobs.delegate({
          role: choice.role, ...(choice.profile ? { agent: choice.profile.name } : {}),
          subject: input.subject, task: input.task, context: delegatedContext,
          ...model, cwd: workspace?.cwd ?? dir.cwd, ...(workspace ? workspace : {}),
          depth: 0, tools: factoryTools(choice.profile, choice.role), runner: state.settings.runner,
          // The same call twice admits one job, not a second identical child.
          key: toolCallId,
          ...(rootId ? { rootId } : {}),
        });
        if (!decision.ok || decision.repeated) {
          if (workspace) await discardExternalWorkspace(workspace);
          if (!decision.ok) throw new Error(decision.reason);
        }
        startTicking();
        const job = decision.job;
        return {
          content: [{
            type: 'text' as const,
            text: `${job.name} (${job.agent ?? job.role}) is on "${job.subject}", using ${modelKey(job.provider, job.modelId)}, `
              + `${job.workspace ? `working in external snapshot ${job.cwd}; proposed changes will be written to ${job.patchFile}` : `reading ${job.cwd}`}. `
              + 'Its report arrives here when it ends. Carry on; do not wait for it, and do not ask again for the same work.',
          }],
          details: job,
        };
      },
      renderCall(args: any, theme: any) {
        const text = theme.fg('toolTitle', theme.bold('▸ delegate'))
          + ` ${theme.fg('muted', String(args?.agent ?? args?.role ?? ''))} ${plain(String(args?.subject ?? ''))}`;
        return new Text(text, 0, 0);
      },
      renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) { return jobView(result?.details, expanded, theme); },
    } as Parameters<ExtensionAPI['registerTool']>[0]);
  };

  registerDelegate('');

  // Real sessions spent ~11% of their prompt tokens on status calls that only
  // waited for a report; each re-sent the whole context. Reports arrive by
  // themselves and wake an idle session, so an unchanged ledger answers briefly.
  const lastStatus = { snapshot: '' };
  const ledgerSnapshot = (ledger: ReturnType<NonNullable<typeof state.jobs>['ledger']>): string =>
    JSON.stringify(ledger.jobs.map(job => [job.id, job.state, Boolean(job.report)]));

  pi.registerTool({
    name: 'agent_jobs',
    label: 'Delegated jobs',
    description: 'Review the subagents this session started, or stop one. A job that came back '
      + 'blocked is unresolved work you own: this is where to see what is still open before calling '
      + 'anything finished. Use result for full evidence, steer with a message to guide a live job, or resume with a message to continue a retained conversation. '
      + 'Never use status to wait: reports arrive in this conversation by themselves and wake the session when it is idle.',
    parameters: Type.Object({
      action: StringEnum(['status', 'cancel', 'result', 'steer', 'resume'] as const),
      jobId: Type.Optional(Type.String({ maxLength: 128 })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }),
    async execute(_toolCallId: string, input: any) {
      const jobs = state.jobs;
      if (!jobs) throw new Error('This session has not delegated anything.');
      if (['result', 'steer', 'resume'].includes(input.action)) {
        const job = input.jobId ? find(jobs.ledger(), input.jobId) : undefined;
        if (!job) throw new Error('Give the id of a job this session started.');
        if (input.action === 'result') return { content: [{ type: 'text' as const, text: JSON.stringify({
          ...(job.report ?? { state: job.state, reason: job.reason }),
          ...(job.patchFile ? { externalWorkspace: job.workspace, patchFile: job.patchFile } : {}),
        }) }], details: job };
        if (typeof input.message !== 'string') throw new Error('A message is required.');
        if (input.action === 'resume') {
          const resumed = await resumeJob(job.id, input.message, _toolCallId);
          return { content: [{ type: 'text' as const, text: `Resumed as ${resumed.name} (${resumed.id}).` }], details: resumed };
        }
        if (!await steerJob(job.id, input.message)) throw new Error('This job is not reachable; inspect its result or resume it.');
        return { content: [{ type: 'text' as const, text: `Message delivered to ${job.name}.` }], details: job };
      }
      if (input.action === 'cancel') {
        const job = input.jobId ? find(jobs.ledger(), input.jobId) : undefined;
        if (!job) throw new Error('Give the id of a job this session started.');
        await jobs.cancel(job.id, 'The session that asked for this stopped it.');
        deliver();
        return { content: [{ type: 'text' as const, text: `${job.name} stopped.` }], details: jobs.ledger() };
      }
      const ledger = jobs.ledger();
      const open = unresolved(ledger);
      const snapshot = ledgerSnapshot(ledger);
      const unchanged = snapshot === lastStatus.snapshot && ledger.jobs.some(job => !isTerminal(job.state));
      lastStatus.snapshot = snapshot;
      if (unchanged) {
        return {
          content: [{
            type: 'text' as const,
            text: `No change since your last check; ${ledger.jobs.filter(job => !isTerminal(job.state)).length} still running. `
              + 'Their reports arrive here by themselves and wake this session when it is idle, so do not poll. '
              + 'Continue your own work, or end your turn if nothing else is left.',
          }],
          details: ledger,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: [
            ...ledgerLines(ledger),
            ...(open.length > 0 ? ['', `${open.length} unresolved: work that is still running or came back blocked.`] : []),
          ].join('\n'),
        }],
        details: ledger,
      };
    },
    renderCall(args: any, theme: any) {
      return new Text(`${theme.fg('toolTitle', theme.bold('▸ jobs'))} ${theme.fg('muted', String(args?.action ?? 'status'))}`, 0, 0);
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) { return ledgerView(result?.details, expanded, theme); },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  pi.registerTool({
    name: 'agent_reply',
    label: 'Answer a subagent',
    description: 'Answer a question a subagent escalated to this session, naming it as the question '
      + 'named it. The answer is steered into the subagent, which was told not to wait — so answer '
      + 'once, plainly, and if the decision is not yours either, say that instead.',
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 48 }),
      answer: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    async execute(_toolCallId: string, input: any) {
      const jobs = state.jobs;
      const job = jobs?.ledger().jobs.find(candidate => candidate.name === input.name && !isTerminal(candidate.state));
      if (!jobs || !job) {
        throw new Error(`No live subagent named "${input.name}". If it already reported, its report has what it knew.`);
      }
      const sent = await steerJob(job.id, `The session that launched you answers: ${input.answer}`);
      if (!sent) throw new Error(`${input.name} is not reachable any more. Its report stands on its own.`);
      return { content: [{ type: 'text' as const, text: `Answered ${input.name}. Carry on with your own work.` }], details: { name: input.name } };
    },
    renderCall(args: any, theme: any) {
      return new Text(`${theme.fg('toolTitle', theme.bold('▸ reply'))} ${theme.fg('muted', String(args?.name ?? ''))}`, 0, 0);
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);

  /**
   * Auto-delegation never delays the prompt it watches: the handler returns
   * immediately and the triage runs beside the turn it started.
   */
  pi.on('input', (event: any, context: ExtensionContext) => {
    if (!state.auto.enabled || state.auto.inFlight || state.closed) return undefined;
    if (event?.source !== 'interactive' || !worthTriaging(String(event?.text ?? ''))) return undefined;
    state.auto.inFlight = true;
    void triageAndLaunch(String(event.text), context)
      .catch(() => undefined)
      .finally(() => { state.auto.inFlight = false; });
    return undefined;
  });

  pi.registerMessageRenderer<{ job?: Job; question?: string }>('agents-ask', (message, { expanded }, theme) => {
    const job = message.details?.job;
    const heading = theme.fg('toolTitle', theme.bold(`▸ ${plain(job?.name ?? 'a subagent')} asks`))
      + ` ${theme.fg('muted', plain(job?.subject ?? ''))}`;
    if (!expanded) return new Text(heading, 0, 0);
    return new Text([heading, plain(message.details?.question ?? '')].join('\n'), 1, 0);
  });

  pi.registerMessageRenderer<{ jobs?: Job[] }>('agents-auto', (message, { expanded }, theme) => {
    const jobs = message.details?.jobs ?? [];
    const heading = theme.fg('toolTitle', theme.bold(`▸ auto-delegated to ${jobs.length} subagent${jobs.length === 1 ? '' : 's'}`));
    if (!expanded) return new Text(heading, 0, 0);
    return new Text([heading, ...jobs.map(job => themedJobLine(job, theme))].join('\n'), 1, 0);
  });

  pi.on('session_start', async (event: any, context: ExtensionContext) => {
    state.ctx = context;
    state.closed = false;
    state.widget = undefined;
    state.settings = options.makeRunner ? defaultSettings() : loadSettings(context.cwd, agentHome(), text => context.ui.notify(text, 'warning'));
    inFlight.clear();
    recorded.clear();
    retained.clear();
    // A snapshot still pending here belonged to the session that just ended.
    if (ledgerWrite.timer) clearTimeout(ledgerWrite.timer);
    ledgerWrite.timer = undefined;
    ledgerWrite.pending = undefined;
    ledgerWrite.terminal.clear();
    for (const entry of context.sessionManager.getBranch() as any[]) {
      if (entry.type === 'custom' && entry.customType === 'agent-job' && entry.data?.id) recorded.add(entry.data.id);
    }
    if (!options.makeRunner) {
      void cleanupStorage(storageRoot(), state.settings.retentionDays).catch(() => undefined);
      void cleanupExternalWorkspaces(undefined, state.settings.workspaceRetentionHours).catch(() => undefined);
    }
    // The toggle survives a reload as a session entry, like the ledger does.
    const pref = context.sessionManager.getBranch()
      .filter((entry: any) => entry.type === 'custom' && entry.customType === 'agents-auto').at(-1) as any;
    if (typeof pref?.data?.enabled === 'boolean') state.auto.enabled = pref.data.enabled;
    state.choices = choices(context);
    registerDelegate(choiceHint(state.choices));
    const jobs = build(context.sessionManager.getSessionId());
    state.jobs = jobs;
    // Only this session's own ledger, never a fork's copy of one: a fork would
    // otherwise inherit jobs whose processes belong to the session it came from.
    if (event?.reason === 'fork' || event?.reason === 'new') return;
    const saved = context.sessionManager.getBranch()
      .filter((entry: any) => entry.type === 'custom' && entry.customType === 'agent-jobs').at(-1) as any;
    const data = saved?.data;
    if (!checkLedger(data) || data.session !== context.sessionManager.getSessionId()) return;
    const receipts = new Set<string>((context.sessionManager.getBranch() as any[]).flatMap(entry =>
      entry.type === 'custom_message' && entry.customType === 'agent-job-result' ? entry.details?.deliveryIds ?? [] : []));
    const reports = new Map<string, unknown>((context.sessionManager.getBranch() as any[]).flatMap(entry =>
      entry.type === 'custom' && entry.customType === 'agent-job' && entry.data?.id && entry.data.report ? [[entry.data.id, entry.data.report]] : []));
    await jobs.restore({ ...(data as Ledger), jobs: (data as Ledger).jobs.map(job => {
      const withReport = job.report || !reports.has(job.id) ? job : { ...job, report: reports.get(job.id) as Job['report'] };
      return receipts.has(job.id) ? { ...withReport, delivered: withReport.delivered ?? Date.now() } : withReport;
    }) });
    deliver();
  });

  pi.on('message_end', (event: any) => {
    const message = event.message;
    if (message?.customType !== 'agent-job-result' || !Array.isArray(message.details?.deliveryIds)) return;
    const ids = message.details.deliveryIds.filter((id: unknown) => typeof id === 'string' && state.jobs?.pending().some(job => job.id === id));
    if (ids.length) { for (const id of ids) inFlight.delete(id); state.jobs?.acknowledge(ids); }
  });

  pi.on('agent_start', () => { state.running = true; });
  pi.on('agent_settled', () => {
    state.running = false;
    // A turn that has just ended is the cheapest moment to hand over a result.
    deliver();
  });
  // Quit, reload, or one session replacing another: whichever it is, the
  // processes belonged to the session that is going, and they go with it.
  pi.on('session_shutdown', async () => {
    // Closed first: a triage in flight checks it before admitting anything.
    state.closed = true;
    stopTicking();
    await state.jobs?.close('The session that owned this ended.').catch(() => undefined);
    // Before the next session starts: a later append would land in that session.
    flushLedger();
  });

  /**
   * The one command a person needs. In a terminal it is the panel: the same
   * ledger everything else reads, live, with a stop key. Anywhere else it is
   * the lines.
   */
  const handle: JobsHandle = {
    lines: () => ledgerLines(state.jobs?.ledger()),
    ledger: () => state.jobs?.ledger(),
    cancel: async (jobId, reason) => { await state.jobs?.cancel(jobId, reason); },
    steer: steerJob, resume: resumeJob,
    activity: jobId => state.jobs?.activity(jobId) ?? [],
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    limits: () => state.settings.limits,
  };
  pi.registerCommand('agents', {
    description: 'Watch and control the subagents this session delegated; /agents auto on|off toggles auto-delegation',
    getArgumentCompletions(prefix) {
      const parts = prefix.split(/\s+/);
      const values = parts.length === 1 ? ['auto'] : parts.length === 2 && parts[0] === 'auto' ? ['on', 'off'] : [];
      const stem = parts.slice(0, -1).join(' ');
      return values.filter(v => v.startsWith(parts.at(-1) ?? '')).map(v => ({ value: `${stem ? stem + ' ' : ''}${v}`, label: v }));
    },
    handler: async (args, context) => {
      const [word, value] = args.trim().split(/\s+/);
      if (word === 'auto') {
        if (value === 'on' || value === 'off') {
          state.auto.enabled = value === 'on';
          try { pi.appendEntry('agents-auto', { enabled: state.auto.enabled }); } catch { /* the session is closing */ }
          context.ui.notify(state.auto.enabled
            ? 'Auto-delegation on: a complex prompt launches expert subagents beside the session.'
            : 'Auto-delegation off.', 'info');
          return;
        }
        context.ui.notify(`Auto-delegation is ${state.auto.enabled ? 'on' : 'off'}. /agents auto on|off`, 'info');
        return;
      }
      if (context.mode !== 'tui') { context.ui.notify(handle.lines().join('\n'), 'info'); return; }
      await openAgentsPanel(context, handle);
    },
  });
  // Other extensions in this process (pi-team, most of all) read the ledger
  // through the registry: jiti gives each package its own module graph, so the
  // process-wide symbol is the only channel that reaches them.
  registerHandle(handle);
  return handle;
}

export default function subagentsExtension(pi: ExtensionAPI): void { installJobs(pi); }
