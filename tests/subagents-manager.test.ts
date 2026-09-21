import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMITS, admit, busy, closable, descendants, emptyLedger, expired, find, live,
  markDelivered, recover, remodel, rootOf, running, settle, startable, starting, stopping,
  undelivered, unresolved, purge, purgeable,
} from '../src/manager.ts';
import { distinctName, nameFor } from '../src/names.ts';
import { checkReport, isTerminal, type Ledger, type Report } from '../src/schema.ts';

const NOW = 1_700_000_000_000;
const ask = (over: Record<string, unknown> = {}) => ({
  role: 'reviewer', subject: 'review the importer', task: 'Read src/importer.ts and report gaps.',
  provider: 'openai-codex', modelId: 'gpt-5.4-mini', cwd: '/work', depth: 0, ...over,
});
const good = (): Report => ({
  outcome: 'completed', summary: 'Reviewed the importer.',
  criteria: [{ criterion: 'every branch has a test', met: 'no', evidence: 'src/importer.ts:88 is untested' }],
  findings: [{ detail: 'the retry path swallows the error', file: 'src/importer.ts', line: 88 }],
  blockers: [],
});
/** Admit a job and hand back the ledger it produced, failing loudly if refused. */
const accept = (ledger: Ledger, over: Record<string, unknown> = {}, now = NOW) => {
  const result = admit(ledger, ask(over) as any, now);
  assert.ok(result.ok, `expected admission: ${result.ok ? '' : result.reason}`);
  return result as Extract<typeof result, { ok: true }>;
};

test('a job is admitted with a person for a name and nothing of the team', () => {
  const { job, ledger } = accept(emptyLedger('s1'));
  assert.equal(job.state, 'queued');
  assert.equal(job.role, 'reviewer');
  assert.equal(job.name, nameFor(job.id), 'the name follows the id, so it survives a repaint');
  assert.match(job.id, /^j_[0-9a-f]{32}$/);
  assert.equal(job.provider, 'openai-codex');
  assert.equal(job.modelId, 'gpt-5.4-mini');
  assert.equal(ledger.jobs.length, 1);
  assert.equal(live(ledger).length, 1);
});

test('the same tool call admits one job, however many times it arrives', () => {
  const first = accept(emptyLedger('s1'), { key: 'call-7' });
  const second = admit(first.ledger, ask({ key: 'call-7' }) as any, NOW + 10);
  assert.ok(second.ok);
  assert.equal(second.repeated, true, 'a repeated call is the same job, not a second child');
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.ledger.jobs.length, 1);
});

test('every refusal says why, and nothing is quietly trimmed to fit', () => {
  const base = emptyLedger('s1');
  assert.match((admit(base, ask({ role: 'writer' }) as any, NOW) as any).reason, /Unknown role/);
  assert.match((admit(base, ask({ task: '   ' }) as any, NOW) as any).reason, /needs a task/);
  assert.match((admit(base, ask({ subject: '' }) as any, NOW) as any).reason, /needs a subject/);

  const huge = admit(base, ask({ task: 'x'.repeat(DEFAULT_LIMITS.taskBytes + 1) }) as any, NOW);
  assert.equal(huge.ok, false);
  assert.match((huge as any).reason, /Send less, not a trimmed version/);

  // The session cap counts every job it ever accepted, settled or not.
  const full = Array.from({ length: DEFAULT_LIMITS.jobs }).reduce<Ledger>(
    ledger => accept(ledger).ledger, base);
  const over = admit(full, ask() as any, NOW);
  assert.equal(over.ok, false);
  assert.match((over as any).reason, /holds 64 jobs.*agent_jobs purge/);
});

test('delegation stops at the configured depth, and says so', () => {
  const refused = admit(emptyLedger('s1'), ask({ depth: DEFAULT_LIMITS.depth }) as any, NOW);
  assert.equal(refused.ok, false);
  assert.match((refused as any).reason, /stops at depth 2/);
  assert.equal(admit(emptyLedger('s1'), ask({ depth: 1 }) as any, NOW).ok, true);
});

test('only as many children run at once as the session allows', () => {
  const a = accept(emptyLedger('s1'));
  const b = accept(a.ledger);
  const c = accept(b.ledger);
  assert.equal(c.ledger.jobs.length, 3);

  const throttled = { ...DEFAULT_LIMITS, concurrency: 2 };
  const ready = startable(c.ledger, throttled);
  assert.equal(ready.length, throttled.concurrency, 'an explicit throttle queues the third');
  assert.deepEqual(ready.map(job => job.id), [a.job.id, b.job.id], 'oldest first');

  const two = ready.reduce((ledger, job) => running(starting(ledger, job.id, NOW), job.id), c.ledger);
  assert.equal(busy(two).length, 2);
  assert.equal(startable(two, throttled).length, 0, 'no room while both are live');

  const one = settle(two, a.job.id, { kind: 'reported', report: good() }, NOW + 100);
  assert.deepEqual(startable(one, throttled).map(job => job.id), [c.job.id], 'a slot frees as one settles');
});

test('a report decides the outcome only after it validates', () => {
  const { job, ledger } = accept(emptyLedger('s1'));
  const live1 = running(starting(ledger, job.id, NOW), job.id);

  const bad = settle(live1, job.id, { kind: 'reported', report: { outcome: 'completed' } as any }, NOW + 5);
  assert.equal(find(bad, job.id)?.state, 'failed');
  assert.match(find(bad, job.id)?.reason ?? '', /does not match the contract/);
  assert.equal(find(bad, job.id)?.report, undefined, 'an invalid report is never stored as one');

  const ok = settle(live1, job.id, { kind: 'reported', report: good(), usage: { cost: 0.02 } }, NOW + 5);
  assert.equal(find(ok, job.id)?.state, 'completed');
  assert.equal(find(ok, job.id)?.usage?.cost, 0.02);
  assert.equal(find(ok, job.id)?.report?.criteria[0].met, 'no');
});

test('a blocked child ends, and its blocker becomes the parent’s open work', () => {
  const { job, ledger } = accept(emptyLedger('s1'));
  const open = running(starting(ledger, job.id, NOW), job.id);
  const blocked: Report = {
    ...good(), outcome: 'blocked',
    blockers: ['src/importer.ts imports a module outside the given scope; I need it passed in.'],
  };
  const done = settle(open, job.id, { kind: 'reported', report: blocked }, NOW + 20);

  assert.equal(isTerminal(find(done, job.id)!.state), true, 'the process always ends');
  assert.equal(find(done, job.id)?.state, 'completed');
  assert.deepEqual(unresolved(done).map(item => item.id), [job.id],
    'the job is over and the need is not: the parent owns it');
});

test('each way of dying keeps its own reason', () => {
  const { job, ledger } = accept(emptyLedger('s1'));
  const open = running(starting(ledger, job.id, NOW), job.id);
  for (const kind of ['failed', 'cancelled', 'timed_out', 'interrupted'] as const) {
    const done = settle(open, job.id, { kind, reason: `because ${kind}` }, NOW + 1);
    assert.equal(find(done, job.id)?.state, kind);
    assert.equal(find(done, job.id)?.reason, `because ${kind}`);
  }
});

test('a settled job never settles again, whatever arrives late', () => {
  const { job, ledger } = accept(emptyLedger('s1'));
  const open = running(starting(ledger, job.id, NOW), job.id);
  const first = settle(open, job.id, { kind: 'cancelled', reason: 'you asked' }, NOW + 1);
  const late = settle(first, job.id, { kind: 'reported', report: good() }, NOW + 900);
  assert.equal(find(late, job.id)?.state, 'cancelled', 'a late report does not reopen a closed job');
  assert.equal(stopping(late, job.id, 'again'), late, 'nor does a late stop');
});

test('the parent is told once, and a reload does not tell it twice', () => {
  const { job, ledger } = accept(emptyLedger('s1'));
  const done = settle(running(starting(ledger, job.id, NOW), job.id),
    job.id, { kind: 'reported', report: good() }, NOW + 10);
  assert.deepEqual(undelivered(done).map(item => item.id), [job.id]);

  const told = markDelivered(done, [job.id], NOW + 11);
  assert.deepEqual(undelivered(told), []);
  assert.equal(find(told, job.id)?.delivered, NOW + 11);
});

test('a restart interrupts what was open and replays nothing', () => {
  const a = accept(emptyLedger('s1'));
  const b = accept(a.ledger);
  const mixed = settle(running(starting(b.ledger, a.job.id, NOW), a.job.id),
    a.job.id, { kind: 'reported', report: good() }, NOW + 5);

  const back = recover(mixed, NOW + 1000);
  assert.equal(find(back, a.job.id)?.state, 'completed', 'what finished stays finished');
  assert.equal(find(back, b.job.id)?.state, 'interrupted');
  assert.match(find(back, b.job.id)?.reason ?? '', /restarted while it was open/);
  assert.deepEqual(live(back), [], 'nothing is left running after a restart');
});

test('the clock belongs to the tree, not to each node in it', () => {
  const root = accept(emptyLedger('s1'));
  // A child admitted late still dies with its root's clock, or depth would
  // multiply the wall time the person agreed to.
  const late = accept(root.ledger, { depth: 1, parentJobId: root.job.id },
    NOW + DEFAULT_LIMITS.timeoutMs - 1000);

  assert.deepEqual(expired(late.ledger, NOW + 1000).map(job => job.id), [], 'nothing expires early');
  const past = expired(late.ledger, NOW + DEFAULT_LIMITS.timeoutMs + 1);
  assert.deepEqual(past.map(job => job.id).sort(), [root.job.id, late.job.id].sort(),
    'the child goes with the root even though it started a moment ago');
});

test('two live jobs never share a name', () => {
  const taken = ['Nadia', 'Theo'];
  const picked = distinctName('j_deadbeef', taken);
  assert.ok(!taken.includes(picked));
  assert.equal(distinctName('j_deadbeef', []), nameFor('j_deadbeef'), 'with nothing taken it is the natural one');
});

test('a report shaped like a verdict without evidence is not a report', () => {
  assert.equal(checkReport(good()), true);
  assert.equal(checkReport({ ...good(), outcome: 'approved' }), false, 'a child does not approve anything');
  assert.equal(checkReport({ ...good(), summary: '' }), false);
  assert.equal(checkReport({ ...good(), criteria: 'looks fine' }), false);
  assert.equal(checkReport({ ...good(), criteria: [{ criterion: 'it works', met: true, evidence: '' }] }), false,
    'met is three-valued: a boolean cannot say “I could not check”');
  assert.equal(checkReport({ outcome: 'completed', summary: 'ok' }), false, 'criteria and findings are not optional');
});

/** A root with a child under it, both open. */
const tree = () => {
  const root = accept(emptyLedger('s1'));
  const child = accept(root.ledger, { depth: 1, parentJobId: root.job.id });
  const grand = accept(child.ledger, { depth: 1, parentJobId: child.job.id });
  return { root: root.job, child: child.job, grand: grand.job, ledger: grand.ledger };
};

test('a job knows its tree, however deep it was admitted', () => {
  const { root, child, grand, ledger } = tree();
  assert.deepEqual(descendants(ledger, root.id).map(job => job.id), [child.id, grand.id]);
  assert.deepEqual(descendants(ledger, grand.id), []);
  assert.equal(rootOf(ledger, grand).id, root.id, 'the budget and the clock belong to this one');
});

test('a tree spends one budget, and says so when it is gone', () => {
  const start = accept(emptyLedger('s1'));
  const full = Array.from({ length: DEFAULT_LIMITS.descendants }).reduce<Ledger>(
    ledger => accept(ledger, { depth: 1, parentJobId: start.job.id }).ledger, start.ledger);

  const refused = admit(full, ask({ depth: 1, parentJobId: start.job.id }) as any, NOW);
  assert.equal(refused.ok, false);
  assert.match((refused as any).reason, /spent its 4 delegations/);
  // The budget is the tree's, so asking from a grandchild spends the same one.
  const deeper = descendants(full, start.job.id)[0];
  const again = admit(full, ask({ depth: 1, parentJobId: deeper.id }) as any, NOW);
  assert.equal(again.ok, false);
});

test('nothing is admitted under a job that has already ended', () => {
  const { root, ledger } = tree();
  const done = settle(ledger, root.id, { kind: 'cancelled', reason: 'you asked' }, NOW + 5);
  const refused = admit(done, ask({ depth: 1, parentJobId: root.id }) as any, NOW + 6);
  assert.equal(refused.ok, false);
  assert.match((refused as any).reason, /has already ended, so nothing is waiting/);
  assert.match((admit(done, ask({ depth: 1, parentJobId: 'j_nothing' }) as any, NOW) as any).reason,
    /not in this session/);
});

test('ending a job ends what it asked for, all the way down', () => {
  const { root, child, grand, ledger } = tree();
  const open = running(starting(ledger, root.id, NOW), root.id);
  assert.equal(closable(open, root.id), false, 'a node with live work under it is not finished');

  const done = settle(open, root.id, { kind: 'reported', report: good() }, NOW + 10);
  assert.equal(find(done, root.id)?.state, 'completed');
  for (const job of [child, grand]) {
    assert.equal(find(done, job.id)?.state, 'cancelled', 'nobody was left to read it');
    assert.match(find(done, job.id)?.reason ?? '', /ended, so there was nobody left to read this/);
  }
  assert.deepEqual(live(done), [], 'a settled tree leaves nothing running');
  assert.equal(closable(done, root.id), true);
});

test('a settled branch is not re-settled when its parent goes', () => {
  const { root, child, ledger } = tree();
  const reported = settle(ledger, child.id, { kind: 'reported', report: good() }, NOW + 1);
  const after = settle(reported, root.id, { kind: 'timed_out', reason: 'the clock ran out' }, NOW + 2);
  assert.equal(find(after, child.id)?.state, 'completed', 'what finished keeps its own ending');
  assert.equal(find(after, child.id)?.settled, NOW + 1);
});

test('a job keeps the tools it was admitted with; an old job stays read-only', () => {
  const { job } = accept(emptyLedger('s1'), { tools: ['read', 'bash', 'edit', 'write'] });
  assert.deepEqual(job.tools, ['read', 'bash', 'edit', 'write']);
  assert.equal(accept(emptyLedger('s2')).job.tools, undefined);
});

test('a child that chooses its model changes what the job says it runs on', () => {
  const accepted = accept(emptyLedger('s1'));
  const next = remodel(accepted.ledger, accepted.job.id, 'anthropic', 'claude-opus-4-5');
  assert.equal(find(next, accepted.job.id)?.modelId, 'claude-opus-4-5');
  const closedLedger = settle(next, accepted.job.id, { kind: 'cancelled', reason: 'done' }, NOW);
  assert.equal(remodel(closedLedger, accepted.job.id, 'x', 'y'), closedLedger, 'a settled job is not redecorated');
});

test('a root names its tree after itself, and a child inherits the wire', () => {
  const first = accept(emptyLedger('s1'));
  assert.equal(first.job.wire, first.job.id);
  const second = accept(first.ledger, { parentJobId: first.job.id, depth: 1, wire: first.job.wire });
  assert.equal(second.job.wire, first.job.id, 'the whole tree talks on one file');
});

test('a retained session admits only one active continuation', () => {
  const first = accept(emptyLedger('s1'), { resumedFrom: 'old', resumeSession: '/history/session.jsonl' });
  const duplicate = admit(first.ledger, ask({ resumedFrom: 'old', resumeSession: '/history/session.jsonl' }) as any, NOW);
  assert.equal(duplicate.ok, false);
  assert.match((duplicate as any).reason, /active continuation/);
});

test('only finished, delivered, resolved jobs with nothing standing under them are purgeable', () => {
  const done = (ledger: Ledger, id: string, report: Report = good()) =>
    settle(ledger, id, { kind: 'reported', report }, NOW);
  const a = accept(emptyLedger('s1'));
  const b = accept(a.ledger);
  const c = accept(b.ledger);
  const child = accept(c.ledger, { parentJobId: c.job.id, depth: 1 });
  const d = accept(child.ledger);
  const blocked: Report = { ...good(), outcome: 'blocked', blockers: ['needs a decision'] };
  const settled = done(done(done(d.ledger, a.job.id), c.job.id), d.job.id, blocked);
  // b is still running; a, c and d finished; c has a live child.
  const delivered = markDelivered(settled, [a.job.id, c.job.id, d.job.id], NOW);
  assert.deepEqual(purgeable(delivered).map(job => job.id), [a.job.id],
    'a live job, a job with a live child, and an unresolved blocker all stay');
  assert.deepEqual(purgeable(settled).map(job => job.id), [], 'an undelivered report is never purged');
  assert.deepEqual(purgeable(delivered, [d.job.id]).map(job => job.id), [d.job.id], 'a named blocker can be purged');
  assert.deepEqual(purgeable(delivered, [b.job.id]), [], 'naming a live job purges nothing');
  const after = purge(delivered, [a.job.id]);
  assert.equal(after.jobs.length, delivered.jobs.length - 1);
  assert.equal(find(after, a.job.id), undefined);
});
