import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeJobs } from '../src/jobs.ts';
import { DEFAULT_LIMITS, find, live } from '../src/manager.ts';
import type { Handle, Runner, RunnerEvent } from '../src/runner.ts';
import type { Job, Ledger, Report } from '../src/schema.ts';

const NOW = 1_700_000_000_000;
const ask = (over: Record<string, unknown> = {}) => ({
  role: 'reviewer', subject: 'review the importer', task: 'Read src/importer.ts.',
  provider: 'openai-codex', modelId: 'gpt-5.4-mini', cwd: '/work', depth: 0, ...over,
});
const good = (): Report => ({
  outcome: 'completed', summary: 'Read it.',
  criteria: [{ criterion: 'the retry path is covered', met: 'no', evidence: 'src/importer.ts:88' }],
  findings: [], blockers: [],
});

/** A runner that spawns nothing and lets a test play the child by hand. */
function fakeRunner(options: { hangs?: boolean; broken?: boolean; dyingOfAbort?: boolean } = {}) {
  const runs = new Map<string, { job: Job; emit: (event: RunnerEvent) => void; stops: string[] }>();
  const held: ((handle: Handle) => void)[] = [];
  const runner: Runner = async (job, emit) => {
    if (options.broken) throw new Error('spawn ENOENT');
    const run = { job, emit, stops: [] as string[] };
    runs.set(job.id, run);
    const handle: Handle = { stop: async reason => {
      run.stops.push(reason);
      // What a real child does when abort lands: agent_settled with no report.
      if (options.dyingOfAbort) emit({ type: 'failed', reason: 'The child ended without reporting.' });
    } };
    if (!options.hangs) return handle;
    // A child that is still starting: the handle exists only once released.
    return new Promise<Handle>(resolve => held.push(() => resolve(handle)));
  };
  return {
    runner, runs,
    /** Finish a start that was left hanging, with the handle it would have had. */
    release: () => held.splice(0).forEach(give => give(undefined as unknown as Handle)),
    of: (job: Job) => runs.get(job.id)!,
    stops: () => [...runs.values()].flatMap(run => run.stops),
  };
}

function jobsWith(options: { hangs?: boolean; broken?: boolean; dyingOfAbort?: boolean } = {}) {
  const clock = { now: NOW };
  const saved: Ledger[] = [];
  const fake = fakeRunner(options);
  const jobs = makeJobs('s1', {
    runner: fake.runner,
    now: () => clock.now,
    persist: ledger => { saved.push(ledger); },
  });
  return { jobs, clock, saved, ...fake };
}

const accepted = async (jobs: ReturnType<typeof makeJobs>, over: Record<string, unknown> = {}) => {
  const decision = await jobs.delegate(ask(over) as any);
  assert.ok(decision.ok, `expected admission: ${decision.ok ? '' : decision.reason}`);
  return decision.job;
};

test('as many children run as the session allows, and the next starts as one ends', async () => {
  const { jobs, runs, of } = jobsWith();
  const first = await accepted(jobs);
  const second = await accepted(jobs);
  const third = await accepted(jobs);

  assert.equal(runs.size, DEFAULT_LIMITS.concurrency, 'the third is admitted, not started');
  assert.equal(find(jobs.ledger(), third.id)?.state, 'queued');

  of(first).emit({ type: 'running' });
  assert.equal(find(jobs.ledger(), first.id)?.state, 'running');

  of(first).emit({ type: 'settled', report: good(), usage: { cost: 0.02 } });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(find(jobs.ledger(), first.id)?.state, 'completed');
  assert.equal(find(jobs.ledger(), first.id)?.usage?.cost, 0.02);
  assert.deepEqual(of(first).stops.length, 1, 'a child that has reported is not left running');
  assert.equal(runs.size, 3, 'the slot it freed went to the one that was waiting');
  assert.equal(find(jobs.ledger(), second.id)?.state, 'starting');
});

test('the same tool call twice starts one child, however many times it arrives', async () => {
  const { jobs, runs } = jobsWith();
  const first = await jobs.delegate(ask({ key: 'call-7' }) as any);
  const again = await jobs.delegate(ask({ key: 'call-7' }) as any);
  assert.ok(first.ok && again.ok);
  assert.equal(again.repeated, true);
  assert.equal(again.job.id, first.job.id);
  assert.equal(runs.size, 1, 'a retried call is the same job, not a second child');
});

test('a child that cannot be spawned fails with a reason and frees its slot', async () => {
  const { jobs } = jobsWith({ broken: true });
  const job = await accepted(jobs);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(find(jobs.ledger(), job.id)?.state, 'failed');
  assert.match(find(jobs.ledger(), job.id)?.reason ?? '', /could not be started: spawn ENOENT/);
  assert.deepEqual(live(jobs.ledger()), []);
});

test('a job cancelled while its child is still starting still stops that child', async () => {
  const { jobs, release, stops } = jobsWith({ hangs: true });
  const job = await accepted(jobs);
  assert.equal(find(jobs.ledger(), job.id)?.state, 'starting');

  const cancelling = jobs.cancel(job.id, 'you asked');
  release();
  await cancelling;

  assert.equal(find(jobs.ledger(), job.id)?.state, 'cancelled');
  assert.equal(find(jobs.ledger(), job.id)?.reason, 'you asked');
  assert.deepEqual(stops(), ['you asked'],
    'the cancellation waited for the start it interrupted, instead of leaving the process behind');
});

test('the clock belongs to the tree, and running out of it stops every child in it', async () => {
  const { jobs, clock, of } = jobsWith();
  const root = await accepted(jobs);
  const child = await accepted(jobs, { depth: 1, parentJobId: root.id });
  of(root).emit({ type: 'running' });
  of(child).emit({ type: 'running' });

  clock.now = NOW + DEFAULT_LIMITS.timeoutMs + 1;
  await jobs.tick();

  assert.equal(find(jobs.ledger(), root.id)?.state, 'timed_out');
  assert.match(find(jobs.ledger(), root.id)?.reason ?? '', /ran past the 300s its tree was given/);
  assert.equal(find(jobs.ledger(), child.id)?.state, 'cancelled', 'the tree goes together');
  assert.deepEqual(live(jobs.ledger()), []);
  assert.equal(of(root).stops.length, 1);
  assert.equal(of(child).stops.length, 1, 'no process outlives the job it belonged to');
});

test('a child that dies of the abort does not relabel a timeout', async () => {
  const { jobs, clock, of } = jobsWith({ dyingOfAbort: true });
  const job = await accepted(jobs);
  of(job).emit({ type: 'running' });

  clock.now = NOW + DEFAULT_LIMITS.timeoutMs + 1;
  await jobs.tick();

  assert.equal(find(jobs.ledger(), job.id)?.state, 'timed_out');
  assert.match(find(jobs.ledger(), job.id)?.reason ?? '', /ran past the 300s/);
  assert.doesNotMatch(find(jobs.ledger(), job.id)?.reason ?? '', /without reporting/);
});

test('what finished is handed over once, and a reload does not hand it over twice', async () => {
  const { jobs, of } = jobsWith();
  const job = await accepted(jobs);
  of(job).emit({ type: 'settled', report: good() });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(jobs.drain().map(item => item.id), [job.id]);
  assert.deepEqual(jobs.drain(), [], 'consumed, because a wake-up nobody asked for costs a turn');
  assert.equal(find(jobs.ledger(), job.id)?.delivered, NOW);
});

test('a reload interrupts what was open, replays nothing, and starts what waited', async () => {
  const before = jobsWith();
  const root = await accepted(before.jobs, { key: 'call-1' });
  await accepted(before.jobs, { key: 'call-2' });
  before.of(root).emit({ type: 'running' });
  const saved = before.jobs.ledger();

  const after = jobsWith();
  await after.jobs.restore(saved);

  assert.equal(find(after.jobs.ledger(), root.id)?.state, 'interrupted');
  assert.match(find(after.jobs.ledger(), root.id)?.reason ?? '', /restarted while it was open/);
  assert.equal(after.runs.size, 0, 'nothing is started again: work nobody watched is not replayed');
  assert.deepEqual(live(after.jobs.ledger()), []);
  assert.equal(after.jobs.drain().length, 2, 'and the parent is told both are gone');
});

test('a session going away takes its children with it', async () => {
  const { jobs, of } = jobsWith();
  const first = await accepted(jobs);
  const second = await accepted(jobs);
  await jobs.close('the session ended');

  assert.deepEqual(live(jobs.ledger()), []);
  assert.equal(of(first).stops.length, 1);
  assert.equal(of(second).stops.length, 1);
});

test('every change reaches the session file, so a reload has something to read', async () => {
  const { jobs, saved, of } = jobsWith();
  const job = await accepted(jobs);
  of(job).emit({ type: 'settled', report: good() });
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(saved.length >= 3, 'admitted, started, settled');
  assert.equal(saved.at(-1)?.jobs.at(0)?.state, 'completed');
  assert.equal(saved.at(-1)?.session, 's1');
});

test('a slot is not free while the process in it is still dying', async () => {
  const { jobs, release } = jobsWith({ hangs: true });
  const first = await accepted(jobs);
  await accepted(jobs);
  const third = await accepted(jobs);
  assert.equal(find(jobs.ledger(), third.id)?.state, 'queued');

  const cancelling = jobs.cancel(first.id, 'you asked');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(find(jobs.ledger(), first.id)?.state, 'stopping', 'asked to go, not yet gone');
  assert.equal(find(jobs.ledger(), third.id)?.state, 'queued',
    'nothing starts beside a child that is still dying, or the limit is one higher than it says');

  release();
  await cancelling;
  assert.equal(find(jobs.ledger(), first.id)?.state, 'cancelled');
  assert.equal(find(jobs.ledger(), third.id)?.state, 'starting', 'and the slot opens once it has gone');
});

test('a start that failed is nothing to stop, and never becomes the caller’s error', async () => {
  const { jobs } = jobsWith({ broken: true });
  const job = await accepted(jobs);
  // Cancelled before the failed start has even been noticed: the handle in hand
  // is a rejected promise, and awaiting it is how that would reach the caller.
  await jobs.cancel(job.id, 'you asked');
  assert.ok(['cancelled', 'failed'].includes(find(jobs.ledger(), job.id)?.state ?? ''),
    'whichever ending got there first, it is an ending');
  assert.deepEqual(live(jobs.ledger()), []);
});

test('a child that cannot acknowledge stop keeps its slot reserved', async () => {
  const state = { fail: true, started: 0 };
  const jobs = makeJobs('s', { limits: { ...DEFAULT_LIMITS, concurrency: 1 }, now: () => NOW, persist: () => {},
    runner: async () => { state.started += 1; return { stop: async () => { if (state.fail) throw new Error('still stopping'); } }; } });
  const first = await accepted(jobs); const second = await accepted(jobs);
  await assert.rejects(() => jobs.cancel(first.id, 'cancel'), /still stopping/);
  assert.equal(find(jobs.ledger(), first.id)?.state, 'stopping');
  assert.equal(find(jobs.ledger(), second.id)?.state, 'queued'); assert.equal(state.started, 1);
  state.fail = false; await jobs.cancel(first.id, 'retry'); assert.equal(state.started, 2);
  await jobs.close('done');
});
