import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { childArgs, frames, selectChildTools, spawnRunner, type RunnerEvent } from '../src/runner.ts';
import { childPrompt } from '../src/context.ts';
import {
  ASK_PREFIX, DELEGATE_TOOL, REPORT_TOOL, newJobId, type DelegateAnswer, type Job,
} from '../src/schema.ts';

const job = (over: Partial<Job> = {}): Job => ({
  id: newJobId(), role: 'reviewer', name: 'Nadia', subject: 'review it',
  task: 'Read it.', context: '', provider: 'openai-codex', modelId: 'gpt-5.4-mini',
  cwd: '/work', state: 'queued', depth: 0, admitted: 1, ...over,
});

/**
 * Signalling belongs to this file, for the whole file.
 *
 * A fake child carries an invented pid, and `process.kill(-pid)` with an
 * invented pid is a signal to whatever real process group happens to hold that
 * number. Nothing here reaches the operating system, and a teardown that
 * outlives the test that started it lands on its own pid instead of on the next
 * test's expectations. The runner gives each test file its own process, so this
 * is never restored and never leaks past it.
 */
const signalled: { pid: number; signal: string }[] = [];
const group = new Map<number, any>();
(process as any).kill = (pid: number, signal: string) => {
  signalled.push({ pid, signal });
  const child = group.get(-pid);
  // A mortal child dies of the first signal, which is what a child does.
  if (child?.mortal) setImmediate(() => { child.exitCode = 0; child.emit('exit', 0); });
  return true;
};
/** What was signalled to one child, so concurrent teardowns cannot be confused. */
const signalsTo = (child: any): string[] =>
  signalled.filter(sent => sent.pid === -child.pid).map(sent => sent.signal);

const pids = { last: 9000 };
const PRICE = { tokens: { total: 5_000 }, cost: 0.03, toolCalls: 4 };

/** A child process that is entirely ours: no binary, no network, no credential. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = ++pids.last;
  /** Whether a signal ends it, and whether it reads its stdin at all. */
  child.mortal = true;
  child.deaf = false;
  child.price = PRICE;
  child.refuses = '';
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.sent = [] as any[];
  child.calls = 0;
  group.set(child.pid, child);

  child.say = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      child.sent.push(message);
      if (child.deaf) continue;
      // What a live child answers by itself. A deaf one is the case that used to
      // leave the parent waiting on a promise nothing would ever resolve.
      if (message.type === 'abort') {
        child.say({ type: 'response', command: 'abort', id: message.id, success: true });
      }
      if (message.type === 'steer') {
        child.say({ type: 'response', command: 'steer', id: message.id, success: false, error: 'not streaming' });
      }
      if (message.type === 'prompt') {
        // Acceptance only: a real child answers that it took the work, never
        // that it did it. `refuses` plays the child that will not take it.
        child.say({ type: 'response', command: 'prompt', id: message.id,
          success: !child.refuses, ...(child.refuses ? { error: child.refuses } : {}) });
      }
      if (message.type === 'get_state') {
        child.say({ type: 'response', command: 'get_state', id: message.id, success: true,
          data: { sessionFile: '/fake/session.jsonl' } });
      }
      if (message.type === 'get_session_stats') {
        child.say({ type: 'response', command: 'get_session_stats', id: message.id, success: true, data: child.price });
      }
    }
  });
  /** Answer the last command of this type the way a real child would. */
  child.answer = (command: string, body: Record<string, unknown>) => {
    const asked = [...child.sent].reverse().find((message: any) => message.type === command);
    child.say({ type: 'response', command, id: asked?.id, ...body });
  };
  /** Call the report tool the way a model does, accepted by its guard or not. */
  child.report = (args: unknown, accepted = true) => {
    const toolCallId = `call_${++child.calls}`;
    child.say({ type: 'tool_execution_start', toolCallId, toolName: REPORT_TOOL, args });
    child.say({ type: 'tool_execution_end', toolCallId, toolName: REPORT_TOOL, isError: !accepted });
  };
  /** Wait until the runner has actually sent a command, so answers are not races. */
  child.waitFor = (command: string) =>
    until(`the runner sends "${command}"`, () => child.sent.some((message: any) => message.type === command));
  return child;
}

/** Let the loop turn until something is true, without waiting on a clock. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (const _ of Array.from({ length: 500 })) {
    if (ready()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for: ${what}`);
}
const settleTick = () => new Promise(resolve => setImmediate(resolve));

/** Start a runner against a fake child and collect what it emitted. */
async function started(over: Partial<Job> = {}, onReady?: (child: any) => void, extra: Record<string, unknown> = {}) {
  const child = fakeChild();
  const events: RunnerEvent[] = [];
  const args: string[][] = [];
  const envs: any[] = [];
  const runner = spawnRunner({
    guardPath: '/fake/guard.ts', invoke: given => ({ command: '/fake/pi', args: [...given] }),
    spawnProcess: ((_bin: string, given: string[], options: any) => {
      args.push(given); envs.push(options.env); return child;
    }) as any,
    ...extra,
  });
  const handle = runner(job(over), event => events.push(event));
  await child.waitFor('set_model');
  onReady?.(child);
  const ended = (): RunnerEvent | undefined =>
    events.find(event => event.type === 'settled' || event.type === 'failed');
  return { child, events, args: args[0], env: envs[0], handle: await handle, ended };
}
const live = (child: any) => child.answer('set_model', { success: true });

test('a child is never started with --model, because that costs thirty seconds', async () => {
  const { args, child } = await started({}, live);
  assert.equal(args.includes('--model'), false,
    'passing --model costs a flat ~30s on Pi 0.85.1, even for the model already selected');
  assert.equal(args.includes('--provider'), false);
  // The model arrives as a command instead, which the spike measured at ~1ms.
  const asked = child.sent.find((message: any) => message.type === 'set_model');
  assert.deepEqual([asked.provider, asked.modelId], ['openai-codex', 'gpt-5.4-mini']);
});

test('the child starts with ambient discovery off, and able to read and to report', () => {
  const args = childArgs('/owned/guard.ts');
  assert.deepEqual(args, [
    '--mode', 'rpc',
    '--no-extensions', '-e', '/owned/guard.ts',
    '--no-skills', '--no-prompt-templates',
    '--no-approve',
    '--tools', `read,grep,find,ls,${REPORT_TOOL},subagent_model,subagent_ask,subagent_memory`,
  ]);
  // `--tools` is an allowlist over extension tools too, so a report tool left
  // out of it is a child that works perfectly and then fails for saying nothing.
  assert.ok(args.at(-1)?.includes(REPORT_TOOL), 'the guard’s own tool has to be named here');
  assert.equal(args.includes('--no-session'), false,
    'the session file is what makes a child visible to the panel for free');
  assert.equal(args.some(arg => /write|edit|bash|apply/.test(arg)), false);
});

test('Bash selection requires both explicit consent and a writable child', () => {
  const worker = ['read', 'bash', 'edit', 'write'];
  assert.deepEqual(selectChildTools(worker, false), ['read', 'edit', 'write']);
  assert.deepEqual(selectChildTools(worker, true), worker);
  assert.deepEqual(selectChildTools(['read', 'bash', 'grep'], true), ['read', 'grep'],
    'plan-mode and other readers cannot turn Bash into an undeclared write path');
});

test('the runner filters stale job tools and gives the prompt the exact same Bash policy', async (t) => {
  const before = process.env.PI_SUBAGENTS_ALLOW_BASH;
  t.after(() => {
    if (before === undefined) delete process.env.PI_SUBAGENTS_ALLOW_BASH;
    else process.env.PI_SUBAGENTS_ALLOW_BASH = before;
  });
  const inherited = ['read', 'bash', 'edit', 'write'];
  delete process.env.PI_SUBAGENTS_ALLOW_BASH;
  const closed = await started({ tools: inherited }, live);
  assert.doesNotMatch(closed.args.at(-1) ?? '', /bash/);
  const closedPrompt = closed.child.sent.find((message: any) => message.type === 'prompt')?.message ?? '';
  assert.match(closedPrompt, /Bash is not available/);
  assert.doesNotMatch(closedPrompt, /explicitly enabled/);

  process.env.PI_SUBAGENTS_ALLOW_BASH = '1';
  const open = await started({ tools: inherited }, live);
  assert.match(open.args.at(-1) ?? '', /bash/);
  const openPrompt = open.child.sent.find((message: any) => message.type === 'prompt')?.message ?? '';
  assert.match(openPrompt, /Bash was explicitly enabled/);
  assert.match(openPrompt, /unrestricted and not sandboxed/);
});

test('a model the child cannot use fails the job instead of running on another', async () => {
  const { events, ended } = await started({}, child =>
    child.answer('set_model', { success: false, error: 'Model not found' }));
  await until('the job fails', () => ended() !== undefined);
  assert.match((ended() as any).reason, /could not use openai-codex\/gpt-5\.4-mini: Model not found/);
  assert.equal(events.some(event => event.type === 'running'), false, 'it never reports itself running');
});

test('the task travels as a prompt, and it is running only once that is taken', async () => {
  const { child, events } = await started({ task: 'Read src/importer.ts.', context: 'It was rewritten.' }, live);
  await until('it is running', () => events.some(event => event.type === 'running'));

  const prompt = child.sent.find((message: any) => message.type === 'prompt');
  assert.equal(prompt.message, childPrompt({
    name: 'Nadia', role: 'reviewer', subject: 'review it',
    task: 'Read src/importer.ts.', context: 'It was rewritten.',
  }), 'what the child is told is assembled from the job, and is what a test can read');
  assert.ok(child.sent.indexOf(prompt) > 0, 'the model is chosen before the work starts, never during it');
});

test('factory profiles inject only their assigned package-owned playbooks', async () => {
  const { child } = await started({ role: 'explorer', agent: 'bug-triager' }, live);
  const prompt = child.sent.find((message: any) => message.type === 'prompt')?.message ?? '';
  assert.match(prompt, /Factory profile: bug-triager/);
  assert.match(prompt, /Bug Triage and Debugging/);
  assert.match(prompt, /Risk-Based Quality/);
  assert.doesNotMatch(prompt, /Product Documentation/);
});

test('a child that will not take the task fails instead of sitting there', async () => {
  const { child, ended } = await started({}, c => {
    c.refuses = 'Agent is streaming';
    live(c);
  });
  await until('it fails', () => ended() !== undefined);
  assert.match((ended() as any).reason, /would not take the task: Agent is streaming/);
  assert.equal(child.sent.some((m: any) => m.type === 'abort'), true, 'and it is not left running');
});

test('an agent_end settles nothing, and ending without a report is a failure', async () => {
  const { child, events, ended } = await started({}, live);
  await until('it is running', () => events.some(event => event.type === 'running'));

  // An agent_end can be followed by a retry, so it settles nothing.
  child.say({ type: 'agent_end', messages: [], willRetry: true });
  await settleTick();
  assert.equal(ended(), undefined, 'agent_end alone settles nothing');

  child.say({ type: 'agent_settled' });
  await until('it prompts for a report', () => child.sent.some((message: any) =>
    message.type === 'prompt' && String(message.message ?? '').includes('subagent_report')));
  assert.equal(child.sent.some((message: any) => message.type === 'steer'
    && String(message.message ?? '').includes('subagent_report')), false,
  'an idle child needs a prompt; an accepted steer starts no recovery turn');
  assert.equal(ended(), undefined, 'one chance to report before failing');

  child.say({ type: 'agent_settled' });
  await until('it fails', () => ended() !== undefined);
  assert.match((ended() as any).reason, /ended without reporting/);
});

test('a child that reports after the nudge still settles', async () => {
  const { child, events, ended } = await started({}, live);
  await until('it is running', () => events.some(event => event.type === 'running'));
  child.say({ type: 'agent_settled' });
  await until('it prompts for a report', () => child.sent.some((message: any) =>
    message.type === 'prompt' && String(message.message ?? '').includes('subagent_report')));
  child.report({ outcome: 'completed', summary: 'done' });
  await until('it settles', () => ended() !== undefined);
  assert.equal((ended() as any).type, 'settled');
});

test('stopping a child that then settles without a report is not a failure of the job', async () => {
  const { child, handle, ended } = await started({}, live);
  await until('it is running', () => child.sent.some((message: any) => message.type === 'prompt'));
  await handle.stop('the clock ran out');
  child.say({ type: 'agent_settled' });
  await settleTick();
  assert.equal(ended(), undefined, 'the stop already owns the reason; agent_settled must not invent another');
});

test('an accepted report ends the run, priced, without waiting for the last word', async () => {
  const { child, events, ended } = await started({}, live);
  await until('it is running', () => events.some(event => event.type === 'running'));

  const report = { outcome: 'blocked', summary: 'need the schema' };
  child.report(report);
  await until('it settles', () => ended() !== undefined);

  const settled = ended() as any;
  assert.equal(settled.type, 'settled', 'having reported, ending is not a failure');
  assert.deepEqual(settled.report, report, 'forwarded as data, for the manager to validate');
  assert.deepEqual(settled.usage, { tokens: 5_000, cost: 0.03, calls: 4 });
  // Nothing waits for an `agent_settled` that would only cost another answer:
  // a child that has reported has nothing left to do.
  assert.equal(child.sent.some((message: any) => message.type === 'get_session_stats'), true);
  assert.deepEqual(events.filter(event => event.type !== 'activity').map(event => event.type), ['running', 'session', 'report', 'settled']);
});

test('a report its own guard rejected is not forwarded, and the child keeps going', async () => {
  const { child, events, ended } = await started({}, live);
  await until('it is running', () => events.some(event => event.type === 'running'));

  child.report({ outcome: 'approved' }, false);
  await settleTick();
  assert.equal(events.some(event => event.type === 'report'), false,
    'the parent hears only about a report the child stood behind');
  assert.equal(ended(), undefined, 'a rejected call is feedback to the child, not the end of the job');

  child.report({ outcome: 'completed', summary: 'fixed it' });
  await until('it settles', () => ended() !== undefined);
  assert.equal((ended() as any).report.summary, 'fixed it');
});

test('what a run cost is unknown rather than zero when the child cannot say', async () => {
  const { child, ended } = await started({}, live);
  await until('it is running', () => child.sent.length > 0);
  child.price = undefined;
  child.report({ outcome: 'completed', summary: 'done' });
  await until('it settles', () => ended() !== undefined);
  assert.equal((ended() as any).usage, undefined, 'no usage at all, never a zero that reads as free');
});

test('a child that dies on its own fails with what it last said', async () => {
  const { child, ended } = await started({}, live);
  await until('it is running', () => child.sent.length > 0);
  child.stderr.write('pi: no credential for openai-codex\n');
  await settleTick();
  child.exitCode = 1;
  child.emit('exit', 1);
  await until('it fails', () => ended() !== undefined);
  assert.match((ended() as any).reason, /exited \(1\) without reporting.*no credential for openai-codex/);
});

test('a guard that throws inside the child surfaces as a failure, not as silence', async () => {
  const { child, ended } = await started({}, live);
  await until('it is running', () => child.sent.length > 0);
  child.say({ type: 'extension_error', extensionPath: '/owned/guard.ts', event: 'tool_call', error: 'denied write' });
  await until('it fails', () => ended() !== undefined);
  assert.match((ended() as any).reason, /guard failed.*denied write/);
});

test('the frame reader is LF-only and cannot be made to hold an unbounded buffer', () => {
  const seen: unknown[] = [];
  const overflows: number[] = [];
  const feed = frames(value => seen.push(value), () => overflows.push(1));

  // U+2028 is legal inside a JSON string; a generic line reader would split here.
  feed(`{"type":"a","text":"line still the same line"}\n`);
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as any).text, 'line still the same line');

  feed('{"type":"b"}\r\n');
  assert.equal((seen[1] as any).type, 'b', 'a CR before the LF is accepted');

  feed('{"type":"c"');
  assert.equal(seen.length, 2, 'a partial frame waits');
  feed('}\n');
  assert.equal((seen[2] as any).type, 'c');

  feed('not json at all\n');
  assert.equal(seen.length, 3, 'a damaged frame is dropped, not thrown');

  feed('x'.repeat(600_000));
  assert.equal(overflows.length, 1, 'a child cannot hold the parent by never sending a newline');
  feed('{"type":"d"}\n');
  assert.equal((seen[3] as any).type, 'd', 'and the reader recovers afterwards');
});

/** Run one job and stop it, twice, the way a cancellation would. */
async function stopped(how: { mortal: boolean; deaf?: boolean }) {
  const { child, handle } = await started({}, c => {
    c.mortal = how.mortal;
    c.deaf = how.deaf === true;
    live(c);
  });
  await settleTick();
  await handle.stop('you asked');
  await handle.stop('again');
  return child;
}

test('stopping is safe to call twice and signals the group, never a bare pid', async () => {
  const child = await stopped({ mortal: true });
  assert.deepEqual(signalsTo(child), ['SIGTERM'], 'a child that goes is never also killed');
  assert.deepEqual(signalled.filter(sent => sent.pid === child.pid), [],
    'never a bare pid: the group is what holds whatever the child spawned');
  assert.equal(child.sent.filter((message: any) => message.type === 'abort').length, 1,
    'the second stop joins the first instead of starting a second teardown');
});

test('a child that answers nothing and dies of nothing is still gone afterwards', async () => {
  // The case that used to hang the parent: no acknowledgement of the abort, and
  // no exit after the SIGTERM. Both waits are bounded, so the stop escalates
  // once and returns, instead of waiting on a child that answers nothing.
  const child = await stopped({ mortal: false, deaf: true });
  assert.deepEqual(signalsTo(child), ['SIGTERM', 'SIGKILL']);
});

/** Play a child asking its parent for a child of its own. */
const delegating = async (job: Partial<Job>, onDelegate: any) => {
  const run = await started(job, live, { onDelegate });
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  return run;
};
const replies = (child: any): any[] =>
  child.sent.filter((message: any) => message.type === 'extension_ui_response');

test('a child at the bottom of the tree has no way to ask for a child', async () => {
  const onDelegate = async (): Promise<DelegateAnswer> => ({ ok: true, text: 'started' });
  const deep = await started({ depth: 1 }, live, { onDelegate });
  assert.equal(deep.args.at(-1)?.includes(DELEGATE_TOOL), false,
    'the tool is absent, which is a brake that cannot be talked around');
  assert.equal(deep.env.PI_SUBAGENTS_CAN_DELEGATE, undefined);
  assert.equal(deep.env.PI_SUBAGENTS_DEPTH, '2');

  const shallow = await started({ depth: 0 }, live, { onDelegate });
  assert.equal(shallow.args.at(-1)?.includes(DELEGATE_TOOL), true);
  assert.equal(shallow.env.PI_SUBAGENTS_CAN_DELEGATE, '1');
  // Both say the same thing, from the two sides, about the same child.
  assert.equal(shallow.env.PI_SUBAGENTS_DEPTH, '1');
});

test('a child that asks for a child gets its parent’s real answer', async () => {
  const asks: any[] = [];
  const { child } = await delegating({ depth: 0 }, async (parent: Job, ask: any) => {
    asks.push({ parent: parent.id, ask });
    return { ok: true, text: 'Accepted. Theo is reading the importer.' };
  });

  child.say({
    type: 'extension_ui_request', id: 'dialog-1', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'delegate', agent: 'explorer', subject: 'map it', task: 'Map src/.' })}`,
  });
  await until('the parent answers', () => replies(child).length > 0);

  assert.equal(asks.length, 1);
  assert.equal(asks[0].ask.subject, 'map it');
  const answer = replies(child)[0];
  assert.equal(answer.id, 'dialog-1', 'answered by the id it asked with');
  assert.deepEqual(JSON.parse(answer.value), { ok: true, text: 'Accepted. Theo is reading the importer.' });
});

test('a refusal reaches the child as an answer, never as a broken dialog', async () => {
  const { child } = await delegating({ depth: 0 }, async () => { throw new Error('the ledger is full'); });
  child.say({
    type: 'extension_ui_request', id: 'dialog-2', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'delegate', agent: 'explorer', subject: 'map it', task: 'Map src/.' })}`,
  });
  await until('the parent answers', () => replies(child).length > 0);
  assert.equal(JSON.parse(replies(child)[0].value).ok, false);

  child.say({ type: 'extension_ui_request', id: 'dialog-3', method: 'input', title: `${ASK_PREFIX}{"kind":"delegate","role":"writer"}` });
  await until('the bad one is answered too', () => replies(child).length > 1);
  assert.match(JSON.parse(replies(child)[1].value).text, /was not understood, so nothing was started/);
});

test('a child cannot make its parent prompt a person who is not there', async () => {
  const { child } = await delegating({ depth: 0 }, async () => ({ ok: true, text: 'started' }));
  child.say({ type: 'extension_ui_request', id: 'dialog-4', method: 'confirm', title: 'Delete everything?' });
  await until('it is answered', () => replies(child).length > 0);
  assert.deepEqual(replies(child)[0], { type: 'extension_ui_response', id: 'dialog-4', cancelled: true },
    'every dialog is answered, because one left open is a child waiting forever');

  // The fire-and-forget methods expect no response, so answering one would be a
  // frame the child never asked for.
  child.say({ type: 'extension_ui_request', id: 'dialog-5', method: 'notify', message: 'hello' });
  child.say({ type: 'extension_ui_request', id: 'dialog-6', method: 'input', title: `${ASK_PREFIX}{}` });
  await until('the one that blocks is answered', () => replies(child).length > 1);
  assert.deepEqual(replies(child).map(reply => reply.id), ['dialog-4', 'dialog-6']);
});

test('a child sees the catalogue without a recommendation, and switches its own model', async () => {
  const catalogue = () => [
    { provider: 'anthropic', modelId: 'claude-opus-4-5', key: 'anthropic/claude-opus-4-5', label: 'claude-opus-4-5', in: 5, out: 25, window: 200_000, reasoning: true },
    { provider: 'openai-codex', modelId: 'gpt-5.4-mini', key: 'openai-codex/gpt-5.4-mini', label: 'gpt-5.4-mini', in: 0.25, out: 2, window: 400_000, reasoning: true },
  ];
  const run = await started({ depth: 0 }, live, { catalogue });
  await until('it is running', () => run.events.some(event => event.type === 'running'));

  run.child.say({ type: 'extension_ui_request', id: 'm1', method: 'input', title: `${ASK_PREFIX}{"kind":"models"}` });
  await until('the catalogue is answered', () => replies(run.child).length > 0);
  const list = JSON.parse(replies(run.child)[0].value);
  assert.equal(list.ok, true);
  assert.ok(list.text.indexOf('anthropic/claude-opus-4-5') < list.text.indexOf('openai-codex/gpt-5.4-mini'),
    'alphabetical: the order carries no recommendation');
  assert.match(list.text, /\$5\/\$25 per Mtok/, 'the facts are there; the advice is not');
  assert.doesNotMatch(list.text, /cheapest|most capable/i);

  run.child.say({ type: 'extension_ui_request', id: 'm2', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'use_model', provider: 'anthropic', modelId: 'claude-opus-4-5' })}` });
  // The switch is a second set_model — not the one from startup — which the
  // child answers like the first.
  await until('the runner asks for the switch',
    () => run.child.sent.filter((message: any) => message.type === 'set_model').length >= 2);
  run.child.answer('set_model', { success: true });
  await until('the switch is answered', () => replies(run.child).length > 1);
  assert.deepEqual(JSON.parse(replies(run.child)[1].value), { ok: true, text: 'You are now running on anthropic/claude-opus-4-5.' });
  assert.ok(run.child.sent.some((message: any) => message.type === 'set_model'
    && message.provider === 'anthropic' && message.modelId === 'claude-opus-4-5'),
    'the switch is the one-millisecond command, not a restart');
  assert.ok(run.events.some(event => event.type === 'model' && event.modelId === 'claude-opus-4-5'),
    'and the job says what it is running on');

  run.child.say({ type: 'extension_ui_request', id: 'm3', method: 'input', title: `${ASK_PREFIX}{"kind":"use_model","provider":"x"}` });
  await until('the bad one is answered', () => replies(run.child).length > 2);
  assert.equal(JSON.parse(replies(run.child)[2].value).ok, false);
});

test('a wired child gets the wire in its environment and its sibling mail steered in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-wire-run-'));
  const run = await started({ depth: 0, wire: 'tree-1' }, live, { wireRoot: root, wireMs: 25 });
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  assert.equal(run.env.PI_SUBAGENTS_ALIAS, 'Nadia');
  assert.ok(run.env.PI_SUBAGENTS_WIRE, 'the tree names the file');
  assert.ok(run.args.at(-1)?.includes('subagent_send'), 'the wire tools are in the allowlist');

  const { post } = await import('../src/wire.ts');
  await post(root, run.env.PI_SUBAGENTS_WIRE, {
    id: 'w1', from: 'Omar', to: 'Nadia', subject: 'found it', body: 'the race is in pump()', at: 1,
  });
  const deadline = Date.now() + 2_000;
  while (!run.child.sent.some((message: any) => message.type === 'steer')) {
    assert.ok(Date.now() < deadline, 'the message is steered in');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const steered = run.child.sent.filter((message: any) => message.type === 'steer');
  assert.match(steered[0].message, /Omar/);
  assert.match(steered[0].message, /the race is in pump\(\)/);
  // Nothing repeats: the offset moved past what was delivered.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(run.child.sent.filter((message: any) => message.type === 'steer').length, 1);
  await rm(root, { recursive: true, force: true });
});

test('a child question climbs to whoever the session says, and the ack says not to wait', async () => {
  const asked: { job: string; question: string }[] = [];
  const run = await started({ depth: 0 }, live, {
    onAsk: async (job: Job, question: string) => {
      asked.push({ job: job.id, question });
      return { ok: true, text: 'Sent to the session that launched you. The answer arrives by itself; do not wait for it.' };
    },
  });
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  run.child.say({ type: 'extension_ui_request', id: 'q1', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'ask', question: 'is the legacy format in scope?' })}` });
  await until('the parent is asked', () => replies(run.child).length > 0);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].job.length > 0, 'the question carries which job asked');
  assert.equal(asked[0].question, 'is the legacy format in scope?');
  assert.match(JSON.parse(replies(run.child)[0].value).text, /do not wait/);

  // Without an answerer the child is told to report, never left waiting.
  const alone = await started({ depth: 0 }, live, {});
  await until('it is running', () => alone.events.some(event => event.type === 'running'));
  alone.child.say({ type: 'extension_ui_request', id: 'q2', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'ask', question: 'anyone?' })}` });
  await until('the refusal is answered', () => replies(alone.child).length > 0);
  assert.match(JSON.parse(replies(alone.child)[0].value).text, /no one to ask|Report what blocks you/);
});

test('steer rides a running child, starts an idle one, and never reaches a reported one', async () => {
  const run = await started({}, live);
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  const handle = run.handle;

  // The steer is refused (not streaming), so a prompt starts the turn instead.
  assert.equal(await handle.steer?.('words'), true);
  assert.ok(run.child.sent.some((message: any) => message.type === 'steer'));
  assert.ok(run.child.sent.some((message: any) => message.type === 'prompt' && message.message === 'words'));

  // Reported: the session is over, and its report already said what it knew.
  run.child.report({ outcome: 'completed', summary: 'done', criteria: [], findings: [], blockers: [] });
  await until('it settled', () => run.events.some(event => event.type === 'settled'));
  assert.equal(await handle.steer?.('more words'), false);
});

test('a child cannot switch to a model the session was not given', async () => {
  const catalogue = () => [
    { provider: 'openai-codex', modelId: 'gpt-5.4-mini', key: 'openai-codex/gpt-5.4-mini', label: 'gpt-5.4-mini', in: 0.25, out: 2, window: 400_000, reasoning: true },
  ];
  const run = await started({ depth: 0 }, live, { catalogue });
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  const before = run.child.sent.filter((message: any) => message.type === 'set_model').length;
  run.child.say({ type: 'extension_ui_request', id: 'm9', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'use_model', provider: 'anthropic', modelId: 'claude-opus-4-5' })}` });
  await until('the refusal is answered', () => replies(run.child).length > 0);
  assert.equal(JSON.parse(replies(run.child)[0].value).ok, false);
  assert.match(JSON.parse(replies(run.child)[0].value).text, /not a model this session has/);
  assert.equal(run.child.sent.filter((message: any) => message.type === 'set_model').length, before,
    'a scoped session scopes its children: no set_model left the parent');
});

test('the child says where its transcript lives, and the job carries it', async () => {
  const run = await started({}, live);
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  assert.ok(run.events.some(event => event.type === 'session' && event.file === '/fake/session.jsonl'),
    'best-effort, once the task is accepted');
});

test('observed usage lets a report settle without waiting for the RPC statistics timeout', async () => {
  const { child, ended } = await started({}, live);
  child.say({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 42, cost: { total: 0.001 } } } });
  child.report({ outcome: 'completed', summary: 'Done' });
  await until('report settles', () => ended() !== undefined);
  assert.deepEqual((ended() as any).usage, { tokens: 42, cost: 0.001, calls: 1 });
  assert.equal(child.sent.some((message: any) => message.type === 'get_session_stats'), false);
});

test('a child starts with its role\'s memory, searched with its task, and can ask for more', async () => {
  const asked: { role: string; query: string }[] = [];
  const memory = async (given: Job, query: string) => {
    asked.push({ role: given.role, query });
    return /pump/.test(query) ? `<project_memory for="${given.role}">\n- (fact) pump() lives in src/jobs.ts\n</project_memory>` : '';
  };
  const run = await started({ depth: 0, role: 'reviewer', subject: 'check pump', task: 'Review pump() for races.' }, live, { memory });
  await until('the prompt is sent', () => run.child.sent.some((message: any) => message.type === 'prompt'));
  const prompt = run.child.sent.find((message: any) => message.type === 'prompt').message;
  assert.match(prompt, /## What this project remembers\n<project_memory for="reviewer">/);
  assert.deepEqual(asked[0], { role: 'reviewer', query: 'check pump\nReview pump() for races.' });
  assert.ok(run.args.at(-1)?.includes('subagent_memory'), 'the lookup tool is in the allowlist');

  run.child.answer('prompt', { success: true });
  await until('it is running', () => run.events.some(event => event.type === 'running'));
  run.child.say({ type: 'extension_ui_request', id: 'mem1', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'memory', query: 'where does pump live' })}` });
  await until('the lookup is answered', () => replies(run.child).length > 0);
  assert.deepEqual(asked[1], { role: 'reviewer', query: 'where does pump live' }, 'the parent filters by the job\'s role, not the child\'s word');
  assert.match(JSON.parse(replies(run.child)[0].value).text, /lives in src\/jobs.ts/);

  run.child.say({ type: 'extension_ui_request', id: 'mem2', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'memory', query: 'unrelated' })}` });
  await until('the empty lookup is answered', () => replies(run.child).length > 1);
  assert.deepEqual(JSON.parse(replies(run.child)[1].value), { ok: true, text: 'Nothing in project memory matches that. Find it in the code.' });

  run.child.say({ type: 'extension_ui_request', id: 'mem3', method: 'input', title: `${ASK_PREFIX}{"kind":"memory"}` });
  await until('the bad lookup is answered', () => replies(run.child).length > 2);
  assert.equal(JSON.parse(replies(run.child)[2].value).ok, false);
});

test('a memory that fails or is absent never holds a child up', async () => {
  const run = await started({ depth: 0 }, live, { memory: async () => { throw new Error('database locked'); } });
  await until('the prompt is sent', () => run.child.sent.some((message: any) => message.type === 'prompt'));
  assert.doesNotMatch(run.child.sent.find((message: any) => message.type === 'prompt').message, /What this project remembers/);
  run.child.answer('prompt', { success: true });
  await until('it is running', () => run.events.some(event => event.type === 'running'));

  const alone = await started({ depth: 0 }, live, {});
  await until('it is running', () => alone.child.sent.some((message: any) => message.type === 'prompt'));
  alone.child.answer('prompt', { success: true });
  await until('it is running', () => alone.events.some(event => event.type === 'running'));
  alone.child.say({ type: 'extension_ui_request', id: 'mem4', method: 'input',
    title: `${ASK_PREFIX}${JSON.stringify({ kind: 'memory', query: 'anything' })}` });
  await until('the lookup is answered', () => replies(alone.child).length > 0);
  assert.match(JSON.parse(replies(alone.child)[0].value).text, /no memory/);
});

test('the parent reads memory through the view pi-memory publishes, and nothing when it is absent', async () => {
  const { childMemory } = await import('../src/host.ts');
  const key = Symbol.for('prjct.memory');
  const space = globalThis as unknown as Record<symbol, unknown>;
  const previous = space[key];
  try {
    delete space[key];
    assert.equal(await childMemory('explorer', 'x'), '');
    const seen: unknown[] = [];
    space[key] = { childView: async (request: unknown) => { seen.push(request); return { text: 'remembered' }; } };
    assert.equal(await childMemory('worker', 'the task'), 'remembered');
    assert.deepEqual(seen, [{ role: 'worker', query: 'the task' }]);
  } finally {
    space[key] = previous;
  }
});
