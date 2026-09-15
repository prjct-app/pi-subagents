import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
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

test('the panel renders the ledger, moves, unfolds a report, and closes on escape', (t) => {
  const done = job({ name: 'Ada', state: 'completed', settled: 10,
    report: { outcome: 'completed', summary: 'Mapped it.', criteria: [], findings: [], blockers: [] } });
  const live = job({ name: 'Omar' });
  const { state, tui: tt } = tui();
  const closed: null[] = [];
  const panel = agentsPanel({ ledger: () => ledger([done, live]), cancel: async () => {}, steer: async () => true }, tt, theme, () => closed.push(null));
  t.after(() => panel.dispose());
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
});

test('x stops the selected live job through the same cancel path, never a settled one', async (t) => {
  const settled = job({ name: 'Ada', state: 'completed', settled: 10 });
  const live = job({ name: 'Omar' });
  const stopped: { id: string; reason: string }[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([settled, live]),
    cancel: async (jobId, reason) => { stopped.push({ id: jobId, reason }); },
    steer: async () => true,
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('x');
  assert.deepEqual(stopped, [], 'a settled job is not stopped again');
  panel.handleInput('\x1b[B');
  panel.handleInput('x');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stopped, [{ id: live.id, reason: 'Stopped from the agents panel.' }]);
});

test('enter on a live job takes over its transcript, typing steers it, esc returns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-takeover-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, [
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Map the store.' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading src/store.' }] } }),
  ].join('\n'));
  const live = job({ name: 'Omar', sessionFile: file });
  const steered: string[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([live]),
    cancel: async () => {},
    steer: async (_id, message) => { steered.push(message); return true; },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());

  panel.handleInput('\r');
  // The transcript loads from the file, asynchronously, on open and on repaint.
  const deadline = Date.now() + 1_000;
  while (panel.render(100).join('\n').includes('Nothing on the transcript yet.')) {
    assert.ok(Date.now() < deadline, 'the transcript arrived');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const view = panel.render(100).join('\n');
  assert.match(view, /Map the store\./, 'the transcript is the child\'s own file');
  assert.match(view, /Reading src\/store\./);
  assert.match(view, /type to steer/);

  for (const key of 'focus the queue') panel.handleInput(key);
  panel.handleInput('\r');
  assert.deepEqual(steered, ['focus the queue']);

  panel.handleInput('\x1b');
  assert.doesNotMatch(panel.render(100).join('\n'), /type to steer/, 'esc returns to the list');
  await rm(root, { recursive: true, force: true });
});

test('enter on a live job without a transcript says so instead of opening an empty view', (t) => {
  const live = job({ name: 'Omar' });
  const { tui: t2 } = tui();
  const panel = agentsPanel({ ledger: () => ledger([live]), cancel: async () => {}, steer: async () => true }, t2, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  assert.match(panel.render(100).join('\n'), /has not said where its transcript lives/);
});

test('a steered draft is sanitized and capped: no control codes, no epics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-draft-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'work' }] } }));
  const live = job({ name: 'Omar', sessionFile: file });
  const steered: string[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([live]), cancel: async () => {},
    steer: async (_id, message) => { steered.push(message); return true; },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  // Control sequences and control characters never leave the panel: the
  // editor ignores the escape run, and clean() strips the bell.
  for (const key of 'read ') panel.handleInput(key);
  panel.handleInput('\x1b[31m');
  for (const key of 'the queue') panel.handleInput(key);
  panel.handleInput('\x07');
  panel.handleInput('\r');
  assert.equal(steered.length, 1);
  assert.equal(steered[0], 'read the queue', 'controls never reach the child');
  // An epic draft is capped at a sentence.
  panel.handleInput('x'.repeat(600));
  panel.handleInput('\r');
  assert.ok((steered[1]?.length ?? 0) <= 240, 'a steer is a sentence, not a file');
  await rm(root, { recursive: true, force: true });
});

test('a job that settles while watched becomes a report with one way out', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-settled-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'work' }] } }));
  const live = job({ name: 'Omar', sessionFile: file });
  const store = { job: live };
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([store.job]), cancel: async () => {}, steer: async () => true,
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  store.job = { ...live, state: 'completed', settled: 10 };
  const view = panel.render(100).join('\n');
  assert.match(view, /settled as completed/, 'the footer tells the truth about a settled job');
  assert.doesNotMatch(view, /type to steer/);
  panel.handleInput('x');
  panel.handleInput('\x1b');
  assert.doesNotMatch(panel.render(100).join('\n'), /settled as/, 'esc still returns to the list');
  await rm(root, { recursive: true, force: true });
});

test('a bracketed paste carrying control sequences never reaches the screen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-paste-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'work' }] } }));
  const live = job({ name: 'Omar', sessionFile: file });
  const steered: string[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([live]), cancel: async () => {},
    steer: async (_id, message) => { steered.push(message); return true; },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  // A paste block with a color sequence and a bell inside it.
  panel.handleInput('\x1b[200~read\n\t\x1b[31mthe queue\x07 now\x1b[201~');
  // Two things on that line are pi-tui's own, not the draft's: the cursor
  // marker (the renderer strips it to place the hardware cursor) and the
  // reverse-video block it draws as the caret. What must not survive is the
  // payload that came in: the pasted color sequence and the bell.
  const drawn = panel.render(100).join('\n').split(CURSOR_MARKER).join('');
  assert.doesNotMatch(drawn, /\x1b\[31m|\x07/, 'the pasted controls never reach the screen');
  assert.match(drawn, /read the queue now/, 'the words do');
  panel.handleInput('\r');
  assert.equal(steered.length, 1);
  assert.doesNotMatch(steered[0], /[\x00-\x1f\x7f]/, 'and nothing raw reaches the child either');
  await rm(root, { recursive: true, force: true });
});

test('a failed final read is retried, so the takeover shows how the job ended', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-retry-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, 'x');
  const store = { job: job({ name: 'Omar', sessionFile: file }) };
  const calls: number[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([store.job]),
    cancel: async () => {},
    steer: async () => true,
    transcript: async () => {
      calls.push(calls.length + 1);
      if (calls.length === 1) throw new Error('EBUSY');
      return [{ who: 'agent' as const, text: 'the last word' }];
    },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  // The job settles while it is being watched; the first read fails.
  store.job = { ...store.job, state: 'completed', settled: 10 };
  const deadline = Date.now() + 3_000;
  while (!panel.render(100).join('\n').includes('the last word')) {
    assert.ok(Date.now() < deadline, 'a failed read is not the last word');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(calls.length >= 2, 'the retry happened');
  await rm(root, { recursive: true, force: true });
});

test('the panel is Focusable and hands the focus to its embedded editor', () => {
  const live = job({ name: 'Omar' });
  const { tui: tt } = tui();
  const panel = agentsPanel({ ledger: () => ledger([live]), cancel: async () => {}, steer: async () => true }, tt, theme, () => {});
  panel.focused = true;
  assert.equal(panel.focused, true, 'the container reports what the editor holds');
  panel.focused = false;
  assert.equal(panel.focused, false);
  panel.dispose();
});

test('an abandoned transcript read cannot release the next job read lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-read-owner-'));
  const fileA = join(root, 'a.jsonl');
  const fileB = join(root, 'b.jsonl');
  await Promise.all([writeFile(fileA, 'a'), writeFile(fileB, 'b')]);
  const a = job({ name: 'Ada', sessionFile: fileA });
  const b = job({ name: 'Omar', sessionFile: fileB });
  const store = { jobs: [a, b] };
  const deferred = () => {
    const slot = { resolve: (_entries: { who: 'agent'; text: string }[]) => {} };
    const promise = new Promise<{ who: 'agent'; text: string }[]>(resolve => { slot.resolve = resolve; });
    return { promise, resolve: slot.resolve };
  };
  const readA = deferred();
  const readB = deferred();
  const reads: string[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger(store.jobs),
    cancel: async () => {},
    steer: async () => true,
    transcript: file => {
      reads.push(file);
      return file === fileA ? readA.promise : readB.promise;
    },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'the expected repaint happened');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitFor(() => reads.filter(file => file === fileA).length === 1);
  panel.handleInput('\x1b');
  panel.handleInput('\x1b[B');
  panel.handleInput('\r');
  store.jobs = [a, { ...b, state: 'completed', settled: 10 }];
  await waitFor(() => reads.filter(file => file === fileB).length === 1);

  // Ada's abandoned read resolves after Omar owns the lock. It must not clear
  // Omar's lock and allow a second, overlapping read to start.
  readA.resolve([{ who: 'agent', text: 'stale Ada transcript' }]);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(reads.filter(file => file === fileB).length, 1);
  assert.doesNotMatch(panel.render(100).join('\n'), /stale Ada transcript/);

  readB.resolve([{ who: 'agent', text: 'Omar final transcript' }]);
  await waitFor(() => panel.render(100).join('\n').includes('Omar final transcript'));
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(reads.filter(file => file === fileB).length, 1, 'the final read stays final');
  await rm(root, { recursive: true, force: true });
});

test('an unterminated bracketed paste stays bounded and never traps the editor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-open-paste-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, 'x');
  const live = job({ name: 'Omar', sessionFile: file });
  const steered: string[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([live]),
    cancel: async () => {},
    steer: async (_id, message) => { steered.push(message); return true; },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  panel.handleInput('\x1b[200~' + 'x'.repeat(1_000));
  for (const _ of Array.from({ length: 100 })) panel.handleInput('y'.repeat(1_000));
  assert.match(panel.render(100).join('\n'), /paste was too large/);
  panel.handleInput('\x1b[201~');
  panel.handleInput('\r');
  assert.equal(steered[0]?.length, 240, 'the whole unterminated stream retained one bounded steer');
  panel.handleInput('o');
  panel.handleInput('k');
  panel.handleInput('\r');
  assert.equal(steered[1], 'ok', 'the forced boundary did not leave Input in paste mode');
  await rm(root, { recursive: true, force: true });
});

test('escape abandons an unterminated paste and returns to the job list', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-paste-escape-'));
  const file = join(root, 'child.jsonl');
  await writeFile(file, 'x');
  const live = job({ name: 'Omar', sessionFile: file });
  const steered: string[] = [];
  const { tui: tt } = tui();
  const panel = agentsPanel({
    ledger: () => ledger([live]),
    cancel: async () => {},
    steer: async (_id, message) => { steered.push(message); return true; },
  }, tt, theme, () => {});
  t.after(() => panel.dispose());
  panel.handleInput('\r');
  panel.handleInput('\x1b[200~unfinished words');
  panel.handleInput('\x1b');
  assert.doesNotMatch(panel.render(100).join('\n'), /type to steer/, 'escape returned to the list');
  panel.handleInput('\r');
  panel.handleInput('o');
  panel.handleInput('k');
  panel.handleInput('\r');
  assert.deepEqual(steered, ['ok'], 'the abandoned paste leaked nothing into the next takeover');
  await rm(root, { recursive: true, force: true });
});
