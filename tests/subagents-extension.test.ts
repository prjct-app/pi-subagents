import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installJobs } from '../src/index.ts';
import type { Handle, Runner, RunnerEvent } from '../src/runner.ts';
import type { Job, Report } from '../src/schema.ts';

const good = (over: Partial<Report> = {}): Report => ({
  outcome: 'completed', summary: 'Read the importer.',
  criteria: [{ criterion: 'the retry path is covered', met: 'no', evidence: 'src/importer.ts:88' }],
  findings: [{ detail: 'the retry path swallows the error', file: 'src/importer.ts', line: 88 }],
  blockers: [], ...over,
});

/** The host, as much of it as this extension touches. */
function host(options: { models?: any[]; scoped?: any[] } = {}) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const renderers = new Map<string, any>();
  const entries: { customType: string; data: any }[] = [];
  const sent: { message: any; options: any }[] = [];
  const runs = new Map<string, { job: Job; emit: (event: RunnerEvent) => void; stops: string[] }>();
  const session = { idle: true };

  const commands = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerEntryRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    appendEntry: (customType: string, data: any) => { entries.push({ customType, data }); },
    sendMessage: (message: any, given: any) => { sent.push({ message, options: given }); },
  } as unknown as ExtensionAPI;

  const model = (provider: string, id: string, input: number) =>
    ({ provider, id, name: id, cost: { input, output: input * 4 }, contextWindow: 200_000 });
  const available = options.models ?? [model('openai-codex', 'gpt-5.4-mini', 0.25), model('anthropic', 'claude-opus-4-5', 5)];

  const ctx: any = {
    cwd: '/work',
    model: available.at(-1),
    modelRegistry: { getAvailable: () => available },
    scopedModels: (options.scoped ?? []).map(value => ({ model: value })),
    isIdle: () => session.idle,
    sessionManager: {
      getSessionId: () => 's1',
      getBranch: () => entries.filter(entry => entry.customType === 'agent-jobs')
        .map(entry => ({ type: 'custom', customType: entry.customType, data: entry.data })),
    },
  };

  /** A runner that spawns nothing and hands the test the child's voice. */
  const makeRunner = ((given: any): Runner => async (job, emit) => {
    const run = { job, emit, stops: [] as string[] };
    runs.set(job.id, run);
    made.push(given);
    const handle: Handle = { stop: async reason => { run.stops.push(reason); } };
    return handle;
  }) as any;
  const made: any[] = [];

  installJobs(pi, { makeRunner, tickMs: 50 });

  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return {
    pi, tools, entries, sent, runs, renderers, ctx, session, made,
    emit,
    of: (job: Job) => runs.get(job.id)!,
    ledger: () => entries.filter(entry => entry.customType === 'agent-jobs').at(-1)?.data,
    delegate: (args: Record<string, unknown> = {}, id = `call_${runs.size + 1}`) =>
      tools.get('agent_delegate').execute(id, {
        role: 'reviewer', subject: 'review the importer', task: 'Read src/importer.ts.', ...args,
      }),
  };
}

const settleTick = () => new Promise(resolve => setImmediate(resolve));

test('delegating starts a child and says plainly not to wait for it', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });

  const result = await h.delegate();
  assert.equal(h.runs.size, 1);
  assert.match(result.content[0].text, /is on "review the importer", using anthropic\/claude-opus-4-5/);
  assert.match(result.content[0].text, /do not wait for it/);
  assert.equal(result.details.state, 'queued');
  assert.equal(h.ledger().jobs.length, 1, 'and the ledger reaches the session file');
});

test('the model is this session’s unless one from its own list is asked for', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });

  const cheap = await h.delegate({ model: 'openai-codex/gpt-5.4-mini' });
  assert.equal(cheap.details.modelId, 'gpt-5.4-mini', 'a job can be given a smaller model than the parent');
  const bare = await h.delegate({ model: 'gpt-5.4-mini' }, 'call_bare');
  assert.equal(bare.details.provider, 'openai-codex', 'named without its provider, if that is unambiguous');

  await assert.rejects(() => h.delegate({ model: 'anthropic/claude-3-opus' }, 'call_bad'),
    /is not a model this session has. Available: openai-codex\/gpt-5\.4-mini, anthropic\/claude-opus-4-5/,
    'and anything else is refused with the list, never quietly swapped');
});

test('a scoped session offers its children only what it was scoped to', async () => {
  const h = host({ scoped: [{ provider: 'openai-codex', id: 'gpt-5.4-mini', cost: { input: 0.25, output: 2 } }] });
  await h.emit('session_start', { reason: 'resume' });
  await assert.rejects(() => h.delegate({ model: 'anthropic/claude-opus-4-5' }),
    /Available: openai-codex\/gpt-5\.4-mini\.$/);
});

test('a finished job reaches the model once, as evidence and not as a verdict', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;

  h.of(job).emit({ type: 'settled', report: good({ blockers: ['the schema file is outside my reach'] }), usage: { cost: 0.04 } });
  await settleTick();
  await h.emit('agent_settled');

  assert.equal(h.sent.length, 1);
  const { message, options } = h.sent[0];
  assert.equal(message.customType, 'agent-job-result');
  assert.equal(message.display, true, 'the parent has to see who finished and what they found');
  assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' });
  assert.match(message.content, /evidence, not a verdict/);
  assert.match(message.content, /the retry path swallows the error \(src\/importer\.ts:88\)/);
  assert.match(message.content, /Blocked jobs are unresolved/);

  await h.emit('agent_settled');
  assert.equal(h.sent.length, 1, 'told once: a wake-up nobody asked for costs a turn every time');
});

test('a job can be fenced to a directory that is not this session\'s', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-job-cwd-'));
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const result = await h.delegate({ cwd: dir });
  assert.equal(result.details.cwd, dir);
  await assert.rejects(() => h.delegate({ cwd: join(dir, 'missing') }), /does not exist/);
});

test('a result that lands mid-turn steers instead of interrupting', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;
  h.session.idle = false;
  await h.emit('agent_start');

  h.of(job).emit({ type: 'settled', report: good() });
  await settleTick();
  assert.deepEqual(h.sent[0].options, { deliverAs: 'steer' });
});

test('nothing is delivered while the session cannot take a message', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;
  // Neither idle nor running: compaction, most of all.
  h.session.idle = false;
  h.of(job).emit({ type: 'settled', report: good() });
  await settleTick();
  assert.deepEqual(h.sent, [], 'it waits rather than being lost');

  h.session.idle = true;
  await h.emit('agent_settled');
  assert.equal(h.sent.length, 1);
});

test('every entry this writes has a renderer, and they render text', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;
  h.of(job).emit({ type: 'settled', report: good() });
  await settleTick();
  await h.emit('agent_settled');

  const written = new Set(h.entries.map(entry => entry.customType));
  assert.deepEqual([...written].sort(), ['agent-job', 'agent-jobs']);
  for (const customType of written) {
    assert.ok(h.renderers.has(customType), `${customType} has a renderer, so it cannot print as raw data`);
  }
  const rendered = h.renderers.get('agent-job')({ data: job }, { expanded: true }, {}, {}).render(120).join('\n');
  assert.doesNotMatch(rendered, /[{}]/, 'a job renders as text, not as a record');
  assert.equal(h.renderers.get('agent-jobs')({ data: h.ledger() }, { expanded: true }, {}, {}).render(120).join(''), '',
    'the ledger is state for a reload and for the panel, not something to read in the transcript');
});

test('status shows the tree, and cancelling one stops its child', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;

  const status = await h.tools.get('agent_jobs').execute('call_s', { action: 'status' });
  assert.match(status.content[0].text, /review the importer/);
  assert.match(status.content[0].text, /1 unresolved/);

  await h.tools.get('agent_jobs').execute('call_c', { action: 'cancel', jobId: job.id });
  assert.equal(h.of(job).stops.length, 1);
  assert.equal(h.ledger().jobs[0].state, 'cancelled');
  await assert.rejects(() => h.tools.get('agent_jobs').execute('call_c2', { action: 'cancel', jobId: 'j_nothing' }),
    /Give the id of a job this session started/);
});

test('a reload reports what was open as interrupted, and starts nothing again', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;
  h.of(job).emit({ type: 'running' });
  h.runs.clear();

  await h.emit('session_start', { reason: 'resume' });
  assert.equal(h.runs.size, 0, 'work nobody watched is not replayed');
  assert.equal(h.ledger().jobs[0].state, 'interrupted');
  assert.match(h.sent.at(-1)?.message.content ?? '', /restarted while it was open/);
});

test('a fork does not inherit jobs whose processes belong to another session', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;
  h.of(job).emit({ type: 'running' });
  h.runs.clear();
  h.sent.length = 0;

  await h.emit('session_start', { reason: 'fork' });
  assert.equal(h.ledger().jobs[0].state, 'running', 'the fork leaves the other session’s ledger alone');
  assert.deepEqual(h.sent, []);
});

test('a session going away takes its children with it', async () => {
  const h = host();
  await h.emit('session_start', { reason: 'resume' });
  const job = (await h.delegate()).details as Job;
  await h.emit('session_shutdown', { reason: 'quit' });
  assert.equal(h.of(job).stops.length, 1);
});
