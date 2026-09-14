import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnRunner } from '../src/runner.ts';
import { newJobId, type Job } from '../src/schema.ts';

/**
 * The cascade, against the operating system rather than against a fake.
 *
 * No model, no credential and no `pi` here. What is under test is that a job
 * signalled as a group takes with it a process its child started, which is the
 * brake the recursion design rests on — and it is the one claim a fake child
 * cannot support, because the thing being checked is what the kernel does.
 */
const job = (cwd: string): Job => ({
  id: newJobId(), role: 'explorer', name: 'Nadia', subject: 'stand still',
  task: 'Wait.', context: '', provider: 'p', modelId: 'm',
  cwd, state: 'queued', depth: 0, admitted: Date.now(),
});

/**
 * A stand-in that speaks just enough RPC to be started and stopped, and that
 * starts a child of its own the way a delegating subagent would.
 */
const TREE = `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.PI_TEAM_TEST_PIDS, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  const state = { buffer: '' };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    state.buffer += chunk;
    const parts = state.buffer.split('\\n');
    state.buffer = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: 'response', command: message.type, id: message.id, success: true }) + '\\n');
    }
  });
  setInterval(() => {}, 1000);
`;

/** Signal 0 asks whether a process is there without touching it. */
const gone = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; } catch { return true; }
};
const until = async (what: string, ready: () => boolean | Promise<boolean>): Promise<void> => {
  for (const _ of Array.from({ length: 100 })) {
    if (await ready()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`gave up waiting for: ${what}`);
};

test('stopping a job kills what its child started, not only the child', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-group-'));
  const file = join(root, 'pids.json');
  const previous = process.env.PI_TEAM_TEST_PIDS;
  process.env.PI_TEAM_TEST_PIDS = file;
  const pids: { child?: number; grandchild?: number } = {};
  try {
    const runner = spawnRunner({
      guardPath: '/unused/guard.ts',
      invoke: () => ({ command: process.execPath, args: ['-e', TREE] }),
      spawnProcess: spawn,
    });
    const handle = await runner(job(root), () => undefined);

    await until('the tree reports its pids', async () => {
      const written = await readFile(file, 'utf8').catch(() => '');
      if (!written) return false;
      Object.assign(pids, JSON.parse(written));
      return true;
    });
    assert.ok(pids.child && pids.grandchild, 'both processes exist to begin with');
    assert.equal(gone(pids.grandchild!), false, 'the grandchild is running');

    await handle.stop('you asked');
    await until('the child is gone', () => gone(pids.child!));
    await until('the grandchild is gone with it', () => gone(pids.grandchild!));
  } finally {
    // Whatever happened above, nothing of this test outlives it.
    for (const pid of [pids.child, pids.grandchild]) {
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (previous === undefined) delete process.env.PI_TEAM_TEST_PIDS;
    else process.env.PI_TEAM_TEST_PIDS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
