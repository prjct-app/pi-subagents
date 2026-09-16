import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { visibleWidth } from '@earendil-works/pi-tui';
import { agentsPanel, rows, type PanelSource } from '../src/panel.ts';
import { statusOf } from '../src/render.ts';
import { newJobId, type Job, type Ledger } from '../src/schema.ts';
import type { Activity } from '../src/activity.ts';

const job = (over: Partial<Job> = {}): Job => ({ id: newJobId(), role: 'worker', name: 'Omar', subject: 'Implement cancellation', task: 'Fix the cancellation race and validate the result.', context: '', provider: 'test', modelId: 'local', cwd: '/work', state: 'running', depth: 0, admitted: Date.now(), started: Date.now(), ...over });
const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(jobs: Job[] = [job()], over: Partial<PanelSource> = {}, height = 40) {
  const store = { jobs, closed: 0, renders: 0, listener: () => {}, activity: [] as Activity[], steers: [] as string[], stops: [] as string[] };
  const source: PanelSource = {
    ledger: (): Ledger => ({ v: 2, session: 'test', jobs: store.jobs }),
    steer: async (_id, message) => { store.steers.push(message); return true; },
    cancel: async id => { store.stops.push(id); },
    activity: () => store.activity,
    subscribe: listener => { store.listener = listener; return () => { store.listener = () => {}; }; },
    ...over,
  };
  const panel = agentsPanel(source, { terminal: { rows: height }, requestRender: () => { store.renders += 1; } } as any, theme, () => { store.closed += 1; });
  return { panel, store, text: (width = 120) => panel.render(width).join('\n') };
}

test('editor render requests do not overwrite pi forwarding TUI proxies', t => {
  const renders = { count: 0 };
  const target = { terminal: { rows: 40 }, requestRender: () => { renders.count += 1; } };
  const originalRequestRender = target.requestRender;
  const tui = new Proxy({} as any, {
    get: (_target, property) => {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
    },
    set: (_target, property, value) => Reflect.set(target, property, value, target),
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
  });
  const source: PanelSource = { ledger: () => ({ v: 2, session: 'test', jobs: [] }), cancel: async () => {}, steer: async () => true };
  const panel = agentsPanel(source, tui, theme, () => {}); t.after(() => panel.dispose());

  assert.equal(target.requestRender, originalRequestRender);
  assert.doesNotThrow(() => panel.handleInput('?'));
  assert.equal(renders.count, 1);
});

test('tree order survives missing parents and malicious cycles', () => {
  const a = job({ id: 'a' }); const b = job({ id: 'b', parentJobId: 'a' }); const c = job({ id: 'c', parentJobId: 'b' });
  assert.deepEqual(rows({ v: 2, session: 's', jobs: [c, b, a] }).map(row => [row.job.id, row.depth]), [['a', 0], ['b', 1], ['c', 2]]);
  assert.equal(rows({ v: 2, session: 's', jobs: [{ ...a, parentJobId: 'c' }, b, c] }).length, 3);
});

test('responsive views fit each supported terminal and a long Unicode task', t => {
  for (const [width, height] of [[60, 20], [80, 24], [120, 40], [160, 50]]) {
    const h = harness([job({ subject: '検証 👩🏽‍💻 é '.repeat(30) })], {}, height); t.after(() => h.panel.dispose());
    for (const key of ['', '\t', '2', '3', 's']) {
      if (key) h.panel.handleInput(key);
      const lines = h.panel.render(width);
      assert.ok(lines.length <= Math.floor(height * 0.9));
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}x${height}: ${lines.find(line => visibleWidth(line) > width)}`);
    }
  }
});

test('wide view shows tree and detail; narrow view switches without losing selection', t => {
  const h = harness([job({ name: 'Ada' }), job({ name: 'Nadia', subject: 'Audit evidence' })]); t.after(() => h.panel.dispose());
  h.panel.handleInput('j');
  assert.match(h.text(), /Nadia worker/);
  h.panel.handleInput('\t');
  assert.match(h.text(60), /Audit evidence/);
  h.panel.handleInput('\x1b');
  assert.match(h.text(60), /›\s+Nadia/);
});

test('blocked reports are attention, never green completed', t => {
  const blocked = job({ state: 'completed', report: { outcome: 'blocked', summary: 'Need an API decision.', criteria: [], findings: [], blockers: ['Which endpoint?'] } });
  assert.equal(statusOf(blocked).color, 'warning');
  const h = harness([blocked]); t.after(() => h.panel.dispose());
  assert.match(h.text(), /1 need attention/);
  h.panel.handleInput('2');
  assert.match(h.text(), /Which endpoint/);
});

test('filters, search and selection remain tied to IDs during changes', t => {
  const a = job({ name: 'Ada', state: 'completed' }); const b = job({ name: 'Nadia' });
  const h = harness([a, b]); t.after(() => h.panel.dispose());
  h.panel.handleInput('f'); assert.match(h.text(), /Nadia worker/);
  h.store.jobs = [job({ name: 'Zoe' }), b, a]; h.store.listener();
  assert.match(h.text(), /Nadia worker/);
  h.panel.handleInput('/'); h.panel.handleInput('Ada'); h.panel.handleInput('\r');
  assert.match(h.text(), /No matching agents/);
  h.panel.handleInput('\x1b'); h.panel.handleInput('f'); h.panel.handleInput('f');
  assert.match(h.text(), /Ada/);
});

test('tree nodes fold without hiding unrelated agents', t => {
  const a = job({ id: 'a', name: 'Ada' }); const b = job({ name: 'Nadia', parentJobId: 'a' });
  const h = harness([a, b]); t.after(() => h.panel.dispose());
  h.panel.handleInput('\x1b[D'); assert.doesNotMatch(h.text(), /Nadia/);
  h.panel.handleInput('\x1b[C'); assert.match(h.text(), /Nadia/);
});

test('scrolling pauses follow and incoming activity does not move the viewport', t => {
  const h = harness(); t.after(() => h.panel.dispose());
  h.store.activity = Array.from({ length: 100 }, (_, i) => ({ id: String(i), at: i, kind: 'message', text: `entry ${i}` }));
  h.panel.handleInput('1'); h.text(); h.panel.handleInput('\x1b[H');
  const before = h.text(); assert.match(before, /entry 0/);
  h.store.activity.push({ id: 'last', at: 100, kind: 'message', text: 'new arrival' }); h.store.listener();
  assert.match(h.text(), /entry 0/); assert.doesNotMatch(h.text(), /new arrival/);
  h.panel.handleInput('\x1b[F'); assert.match(h.text(), /new arrival/);
});

test('messages are multiline, preserve draft on failure, and never fire navigation commands', async t => {
  const sends: string[] = [];
  const h = harness(undefined, { steer: async (_id, text) => { sends.push(text); return sends.length > 1; } }); t.after(() => h.panel.dispose());
  h.panel.handleInput('s'); h.panel.handleInput('x'); h.panel.handleInput('\r'); h.panel.handleInput('Please inspect the queue');
  h.panel.handleInput('\x13'); await tick();
  assert.deepEqual(sends, ['x\nPlease inspect the queue']); assert.deepEqual(h.store.stops, []);
  assert.match(h.text(), /draft was kept/);
  h.panel.handleInput('\x13'); await tick(); assert.equal(sends.length, 2); assert.match(h.text(), /Message delivered/);
});

test('escape retains a draft for the same agent and does not leak it to another', t => {
  const h = harness([job({ name: 'Ada' }), job({ name: 'Nadia' })]); t.after(() => h.panel.dispose());
  h.panel.handleInput('s'); h.panel.handleInput('Keep this draft'); h.panel.handleInput('\x1b'); h.panel.handleInput('\x1b');
  h.panel.handleInput('j'); h.panel.handleInput('s'); assert.doesNotMatch(h.text(), /Keep this draft/);
  h.panel.handleInput('\x1b'); h.panel.handleInput('\x1b'); h.panel.handleInput('k'); h.panel.handleInput('s'); assert.match(h.text(), /Keep this draft/);
});

test('oversized and unterminated pastes are bounded and rejected, never silently truncated', async t => {
  const h = harness(); t.after(() => h.panel.dispose());
  h.panel.handleInput('s'); h.panel.handleInput('\x1b[200~');
  for (const _ of Array.from({ length: 100 })) h.panel.handleInput('x'.repeat(1000));
  h.panel.handleInput('\x1b[201~'); h.panel.handleInput('\x13'); await tick();
  assert.match(h.text(), /Paste rejected/); assert.deepEqual(h.store.steers, []);
  h.panel.handleInput('\x1b[200~unfinished'); h.panel.handleInput('\x1b'); h.panel.handleInput('s');
  h.panel.handleInput('ok'); h.panel.handleInput('\x13'); await tick(); assert.deepEqual(h.store.steers, ['ok']);
});

test('pasted controls are sanitized, newlines and Unicode are preserved', async t => {
  const h = harness(); t.after(() => h.panel.dispose());
  h.panel.handleInput('s'); h.panel.handleInput('\x1b[200~read\n👩🏽‍💻 \x1b[31mqueue\x07\x1b[201~'); h.panel.handleInput('\x13'); await tick();
  assert.deepEqual(h.store.steers, ['read\n👩🏽‍💻 queue']);
});

test('resume selects the new execution and preserves the old report', async t => {
  const a = job({ state: 'completed', name: 'Ada' }); const next = job({ name: 'Nadia' });
  const h = harness([a], { resume: async () => { h.store.jobs.push(next); return next; } }); t.after(() => h.panel.dispose());
  h.panel.handleInput('r'); h.panel.handleInput('Use the new endpoint'); h.panel.handleInput('\x13'); await tick();
  assert.match(h.text(), /Nadia worker/); assert.equal(a.state, 'completed');
});

test('cancel goes through the common controller and cannot target a terminal job', async t => {
  const a = job(); const h = harness([a]); t.after(() => h.panel.dispose());
  h.panel.handleInput('x'); await tick(); assert.deepEqual(h.store.stops, [a.id]);
  h.store.jobs = [{ ...a, state: 'completed' }]; h.panel.handleInput('x'); assert.equal(h.store.stops.length, 1);
});

test('history errors remain retryable, and disposal unsubscribes', async t => {
  const a = job({ sessionFile: '/fake' }); const count = { value: 0 };
  const h = harness([a], { transcript: async () => { if (++count.value === 1) throw new Error('busy'); return [{ who: 'agent', text: 'Recovered history' }]; } });
  t.after(() => h.panel.dispose());
  h.panel.handleInput('h'); await tick(); assert.match(h.text(), /History is unavailable/);
  h.panel.handleInput('h'); await tick(); assert.match(h.text(), /Recovered history/);
  h.panel.dispose(); const renders = h.store.renders; h.store.listener(); assert.equal(h.store.renders, renders);
});

test('empty state and help fit small terminals and escape returns before closing', t => {
  const h = harness([], {}, 24); t.after(() => h.panel.dispose());
  assert.match(h.text(), /Delegate a focused task/);
  h.panel.handleInput('?'); assert.match(h.text(80), /NAVIGATION/);
  h.panel.handleInput('\x1b'); assert.equal(h.store.closed, 0);
  h.panel.handleInput('\x1b'); assert.equal(h.store.closed, 1);
});

test('64-job navigation and rendering stay under 100 ms per interaction', t => {
  const h = harness(Array.from({ length: 64 }, (_, i) => job({ name: `Agent ${i}` }))); t.after(() => h.panel.dispose());
  h.text();
  const times = Array.from({ length: 30 }, () => { const start = performance.now(); h.panel.handleInput('j'); h.text(160); return performance.now() - start; });
  assert.ok(Math.max(...times) < 100, `Slowest interaction ${Math.max(...times)}ms`);
});
