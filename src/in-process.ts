import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { installGuard } from './child.ts';
import { agentHome, roleTools } from './config.ts';
import { activityOf } from './activity.ts';
import { childPrompt, neutralCatalogue } from './context.ts';
import { factoryAgent } from './factory.ts';
import { within, type Runner, type RunnerEvent, type spawnRunner } from './runner.ts';
import { read as readWire } from './wire.ts';
import { ASK_TOOL, DELEGATE_TOOL, MODEL_TOOL, READ_ONLY_TOOLS, REPORT_TOOL, WIRE_INBOX_TOOL, WIRE_SEND_TOOL, checkAsk, checkModelAsk, checkQuestionAsk, type DelegateAnswer } from './schema.ts';

type Options = Parameters<typeof spawnRunner>[0];

/** Native Pi sessions with explicit resources and per-session state; never mutates process.env or cwd. */
export function inProcessRunner(options: Options): Runner {
  return async (job, emit) => {
    const slot: { session?: AgentSession; done: boolean; stop?: Promise<void>; timer?: ReturnType<typeof setInterval>; offset: number; forwarding: boolean; sent: number; nudged: boolean } = { done: false, offset: 0, forwarding: false, sent: 0, nudged: false };
    const mayDelegate = Boolean(options.onDelegate) && job.depth + 1 < (options.depth ?? 2);
    const wired = Boolean(options.wireRoot && job.wire);
    // Admission already removed ambient extension tools unless their packages
    // were configured explicitly; keep that admitted set here.
    const permitted = roleTools(job.role, job.tools ?? READ_ONLY_TOOLS, undefined, true);
    const tools = [...new Set([...permitted, REPORT_TOOL, MODEL_TOOL, ASK_TOOL, ...(mayDelegate ? [DELEGATE_TOOL] : []), ...(wired ? [WIRE_SEND_TOOL, WIRE_INBOX_TOOL] : [])])];
    const stop = (): Promise<void> => {
      if (slot.stop) return slot.stop;
      const work = (async () => {
        slot.done = true;
        clearInterval(slot.timer);
        const session = slot.session;
        if (!session) return;
        const stopped = await within(3_000, session.abort().then(() => true), false);
        if (!stopped) throw new Error('Native child has not acknowledged cancellation; its capacity remains reserved.');
        await within(3_000, session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }).catch(() => undefined), undefined);
        session.dispose();
      })();
      slot.stop = work;
      void work.catch(() => { slot.stop = undefined; });
      return work;
    };
    const terminal = (event: RunnerEvent): void => {
      if (slot.done) return;
      slot.done = true;
      clearInterval(slot.timer);
      emit(event);
      void stop().catch(() => undefined);
    };
    const steer = async (message: string): Promise<boolean> => {
      if (slot.done || !slot.session) return false;
      try {
        if (slot.session.isStreaming) await slot.session.steer(message);
        else void slot.session.prompt(message).catch(error => terminal({ type: 'failed', reason: String(error) }));
        return true;
      } catch { return false; }
    };
    const decide = async (payload: string): Promise<string> => {
      const answer = async (): Promise<DelegateAnswer> => {
        if (payload.length > 32 * 1024) return { ok: false, text: 'Request too large.' };
        const ask = JSON.parse(payload);
        if (ask.kind === 'models') return { ok: true, text: neutralCatalogue(options.catalogue?.() ?? []) };
        if (ask.kind === 'ask' && checkQuestionAsk(ask) && options.onAsk) return options.onAsk(job, ask.question);
        if (ask.kind === 'delegate' && checkAsk(ask) && mayDelegate && options.onDelegate) return options.onDelegate(job, ask);
        if (ask.kind === 'use_model' && checkModelAsk(ask) && slot.session) {
          const known = options.catalogue?.();
          if (known && !known.some(choice => choice.provider === ask.provider && choice.modelId === ask.modelId)) return { ok: false, text: 'That model is outside the parent catalogue.' };
          const model = slot.session.modelRuntime.getModel(ask.provider, ask.modelId);
          if (!model) return { ok: false, text: 'That model is unavailable in this child.' };
          await slot.session.setModel(model);
          emit({ type: 'model', provider: ask.provider, modelId: ask.modelId });
          return { ok: true, text: `Using ${ask.provider}/${ask.modelId}.` };
        }
        return { ok: false, text: 'This request is unavailable or invalid.' };
      };
      try { return JSON.stringify(await within(30_000, answer(), { ok: false, text: 'The parent did not answer in time.' })); }
      catch (error) { return JSON.stringify({ ok: false, text: String(error).slice(0, 500) }); }
    };
    try {
      const file = options.prepare ? await options.prepare(job) : undefined;
      const settings = SettingsManager.inMemory({ defaultTools: tools });
      const loader = new DefaultResourceLoader({
        cwd: job.cwd, agentDir: agentHome(), settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: options.extensionPaths ?? [],
        extensionFactories: [pi => { installGuard(pi, {
          PI_SUBAGENTS_CHILD: '1', PI_SUBAGENTS_ROLE: job.role,
          PI_SUBAGENTS_TOOLS: tools.join(','), PI_SUBAGENTS_VERIFY_TOOLS: '1',
          PI_SUBAGENTS_ALLOW_BASH: process.env.PI_SUBAGENTS_ALLOW_BASH,
          PI_SUBAGENTS_CAN_DELEGATE: mayDelegate ? '1' : '0',
          ...(wired ? { PI_SUBAGENTS_WIRE: job.wire, PI_SUBAGENTS_WIRE_ROOT: options.wireRoot, PI_SUBAGENTS_ALIAS: job.name } : {}),
        }, decide); }],
      });
      await loader.reload();
      if (loader.getExtensions().errors.length) throw new Error(loader.getExtensions().errors.map(error => error.error).join('; '));
      const { session } = await createAgentSession({ cwd: job.cwd, agentDir: agentHome(), settingsManager: settings,
        resourceLoader: loader, tools, sessionManager: file ? SessionManager.open(file, undefined, job.cwd) : SessionManager.inMemory(job.cwd) });
      slot.session = session;
      await session.bindExtensions({ mode: 'rpc', onError: error => terminal({ type: 'failed', reason: String(error.error) }) });
      if (slot.done) throw new Error('Child extension initialization failed.');
      const model = session.modelRuntime.getModel(job.provider, job.modelId);
      if (!model) throw new Error(`Child model ${job.provider}/${job.modelId} unavailable; configure its extension package explicitly.`);
      await session.setModel(model);
      const missing = tools.filter(tool => !session.getAllTools().some(available => available.name === tool));
      if (missing.length) throw new Error(`Child capabilities unavailable: ${missing.join(', ')}`);
      session.setActiveToolsByName(tools);
      const baseline = session.getSessionStats();
      const claims = new Map<string, unknown>();
      session.subscribe(event => {
        if (slot.done) return;
        const raw = event as any;
        const activity = activityOf(raw);
        if (activity) emit({ type: 'activity', activity });
        if (raw.type === 'tool_execution_start' && raw.toolName === REPORT_TOOL) claims.set(raw.toolCallId, raw.args);
        if (raw.type === 'tool_execution_end' && raw.toolName === REPORT_TOOL) {
          const report = claims.get(raw.toolCallId);
          claims.delete(raw.toolCallId);
          if (raw.isError || !report) return;
          const stats = session.getSessionStats();
          emit({ type: 'report', report });
          terminal({ type: 'settled', report, usage: { tokens: Math.max(0, stats.tokens.total - baseline.tokens.total), cost: Math.max(0, stats.cost - baseline.cost), calls: Math.max(0, stats.toolCalls - baseline.toolCalls) } });
        }
        if (raw.type === 'agent_settled') {
          if (slot.nudged) { terminal({ type: 'failed', reason: 'The child ended without reporting.' }); return; }
          slot.nudged = true;
          void steer(`You settled without calling ${REPORT_TOOL}. Call ${REPORT_TOOL} now with the evidence you have. Do not wait.`).then(ok => {
            if (!ok && !slot.done) terminal({ type: 'failed', reason: 'The child ended without reporting.' });
          });
        }
      });
      if (file) emit({ type: 'session', file });
      emit({ type: 'running' });
      if (wired) {
        slot.timer = setInterval(() => {
          if (slot.forwarding || slot.done || slot.sent >= 24) return;
          slot.forwarding = true;
          void readWire(options.wireRoot!, job.wire!, slot.offset, job.name).then(async found => {
            slot.offset = found.offset;
            for (const message of found.messages) {
              if (message.from === job.name || slot.sent >= 24 || slot.done) continue;
              slot.sent += 1;
              await steer(`Message from ${message.from}: ${message.subject}\n${message.body}`);
            }
          }).catch(() => undefined).finally(() => { slot.forwarding = false; });
        }, options.wireMs ?? 2_000);
        slot.timer.unref?.();
      }
      void session.prompt(childPrompt({ ...job, tools: permitted, canDelegate: mayDelegate, wired,
        ...(job.agent ? { profile: factoryAgent(job.agent).instructions } : {}) })).catch(error => terminal({ type: 'failed', reason: String(error).slice(0, 500) }));
    } catch (error) {
      terminal({ type: 'failed', reason: String(error).slice(0, 500) });
      await stop();
    }
    return { stop, steer };
  };
}
