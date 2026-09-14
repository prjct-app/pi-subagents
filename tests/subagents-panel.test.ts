import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsPanel, rows } from '../src/panel.ts';
import { newJobId, type Job, type Ledger } from '../src/schema.ts';

/** A job, with only what the panel reads. */
const job = (over: Partial<Job> = {}): Job => ({
  id: newJobId(), role: 'explorer', name: 'Nadia', subject: 'map the store',
  task: 'Read it.', context: '', provider: 'openai-codex', modelId: 'gpt-5.4-mini',
  cwd: '/work', state: 'running', depth: 0, admitted: 1, started: 2, ...over,
});

const ledger = (jobs: Job[]): Ledger => ({ v: 1, session: 's1', jobs });

/** Theme and TUI doubles: color is identity, rendering is counted. */
const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tui = () => {
  const state = { renders: 0 };
  return { state, tui: { requestRender: () => { state.renders += 1; } } as any };
};

test('rows come in tree order with the depth they are drawn at', () => {
  const root = job({ name: 'Ada' });
  const child = job({ name: 'Omar', parentJobId: root.id, depth: 1 });
  const grandchild = job({ name: 'Iris', parentJobId: child.id, depth: 2 });
  const other = job({ name: 'Rhea' });
  // Roots keep ledger order; children nest under their parent wherever it sits.
  const all = rows(ledger([grandchild, other, child, root]));
  assert.deepEqual(all.map(row => row.job.name), ['Rhea', 'Ada', 'Omar', 'Iris']);
  assert.deepEqual(all.map(row => row.depth), [0, 0, 1, 2]);
  assert.deepEqual(rows(undefined), []);
});

test('the panel renders the ledger, moves, unfolds a report, and closes on escape', () => {
  const done = job({ name: 'Ada', state: 'completed', settled: 10,
    report: { outcome: 'completed', summary: 'Mapped it.', criteria: [], findings: [], blockers: [] } });
  const live = job({ name: 'Omar' });
  const { state, tui: t } = tui();
  const closed: null[] = [];
  const panel = agentsPanel({ ledger: () => ledger([done, live]), cancel: async () => {} }, t, theme, () => closed.push(null));
  const text = panel.render(100).join('\n');
  assert.match(text, /2 live · 2 total|1 live · 2 total/);
  assert.match(text, /Ada/);
  assert.match(text, /Omar/);
  // Down to Omar, back up to Ada, unfold her report, fold it again.
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[A');
  panel.handleInput('\r');
  assert.match(panel.render(100).join('\n'), /Mapped it\./);
  panel.handleInput('\r');
  assert.doesNotMatch(panel.render(100).join('\n'), /Mapped it\./);
  panel.handleInput('\x1b');
  assert.equal(closed.length, 1, 'escape closes the panel');
  assert.ok(state.renders > 0, 'every key repaints');
  panel.dispose();
});

test('x stops the selected live job through the same cancel path, never a settled one', async () => {
  const settled = job({ name: 'Ada', state: 'completed', settled: 10 });
  const live = job({ name: 'Omar' });
  const stopped: { id: string; reason: string }[] = [];
  const { tui: t } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([settled, live]),
    cancel: async (jobId, reason) => { stopped.push({ id: jobId, reason }); },
  }, t, theme, () => {});
  panel.handleInput('x');
  assert.deepEqual(stopped, [], 'a settled job is not stopped again');
  panel.handleInput('\x1b[B');
  panel.handleInput('x');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stopped, [{ id: live.id, reason: 'Stopped from the agents panel.' }]);
  panel.dispose();
});
