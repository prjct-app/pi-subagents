import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { inProcessRunner } from '../src/in-process.ts';
import { spawnRunner, type RunnerEvent, type Handle } from '../src/runner.ts';
import { newJobId, type Job } from '../src/schema.ts';
import { prepareSession } from '../src/storage.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/mock-provider.ts', import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const job = (cwd: string, over: Partial<Job> = {}): Job => ({ id: newJobId(), name: 'Ada', role: 'reviewer', subject: 'SDK smoke test', task: 'Return a report.', context: '', provider: 'subagents-fixture', modelId: 'offline', cwd, state: 'starting', depth: 0, admitted: Date.now(), tools: ['read'], ...over });
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!ready()) { assert.ok(Date.now() < deadline, 'native runner timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
for (const backend of ['process', 'in-process'] as const) {
  test(`${backend}: actual Pi reports with an offline provider and retained conversation`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-native-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const handles: Handle[] = [];
    t.after(async () => { for (const handle of handles) await handle.stop('test over'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(directory, { recursive: true, force: true }); });
    const events: RunnerEvent[] = [];
    const factory = backend === 'process' ? spawnRunner : inProcessRunner;
    const runner = factory({ guardPath: join(root, 'src', 'child.ts'), verifyCapabilities: true, extensionPaths: [fixture],
      invoke: args => ({ command: process.execPath, args: [cli, ...args] }), prepare: child => prepareSession(child, join(directory, 'sessions')) });
    const child = job(directory);
    handles.push(await runner(child, event => events.push(event)));
    await until(() => events.some(event => event.type === 'settled' || event.type === 'failed'));
    const failed = events.find(event => event.type === 'failed'); assert.equal(failed, undefined, JSON.stringify(failed));
    const settled = events.find(event => event.type === 'settled') as Extract<RunnerEvent, { type: 'settled' }>;
    assert.match(JSON.stringify(settled.report), /Offline SDK execution succeeded/);
    assert.ok(events.some(event => event.type === 'activity'));
    const session = events.find(event => event.type === 'session') as Extract<RunnerEvent, { type: 'session' }>;
    assert.ok(session.file.startsWith(directory));
    await handles[0].stop('completed');
    assert.match(await readFile(session.file, 'utf8'), /subagent_report/);
    const continuationEvents: RunnerEvent[] = [];
    handles.push(await runner(job(directory, { resumeSession: session.file, resumedFrom: child.id, task: 'Continue with a new report.' }), event => continuationEvents.push(event)));
    await until(() => continuationEvents.some(event => event.type === 'settled' || event.type === 'failed'));
    assert.ok(continuationEvents.some(event => event.type === 'settled'), JSON.stringify(continuationEvents));
  });

  test(`${backend}: unavailable model fails explicitly and cancellation stops a native turn`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-native-stop-'));
    const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
    const handles: Handle[] = [];
    t.after(async () => { for (const handle of handles) await handle.stop('test over'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(directory, { recursive: true, force: true }); });
    const factory = backend === 'process' ? spawnRunner : inProcessRunner;
    const runner = factory({ guardPath: join(root, 'src', 'child.ts'), verifyCapabilities: true, extensionPaths: [fixture], invoke: args => ({ command: process.execPath, args: [cli, ...args] }) });
    const failed: RunnerEvent[] = [];
    handles.push(await runner(job(directory, { modelId: 'missing' }), event => failed.push(event)));
    assert.ok(failed.some(event => event.type === 'failed'));
    const events: RunnerEvent[] = [];
    handles.push(await runner(job(directory, { task: 'fixture-wait' }), event => events.push(event)));
    await until(() => events.some(event => event.type === 'running' || event.type === 'failed'));
    assert.ok(events.some(event => event.type === 'running'), JSON.stringify(events));
    await handles[1].stop('cancelled');
    assert.equal(await handles[1].steer?.('late message'), false);
  });
}

for (const backend of ['process', 'in-process'] as const) {
  test(`${backend}: capability handshake rejects missing tools and nested delegation reaches the parent`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-native-capabilities-'));
    const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
    const handles: Handle[] = [];
    t.after(async () => { for (const handle of handles) await handle.stop('test over'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(directory, { recursive: true, force: true }); });
    const delegated: string[] = [];
    const factory = backend === 'process' ? spawnRunner : inProcessRunner;
    const runner = factory({ guardPath: join(root, 'src', 'child.ts'), verifyCapabilities: true, extensionPaths: [fixture], invoke: args => ({ command: process.execPath, args: [cli, ...args] }),
      onDelegate: async (_parent, ask) => { delegated.push(ask.subject); return { ok: true, text: 'Accepted a separate reader. Continue.' }; } });
    const missing: RunnerEvent[] = [];
    handles.push(await runner(job(directory, { role: 'worker', tools: ['read', 'unavailable-tool'] }), event => missing.push(event)));
    assert.ok(missing.some(event => event.type === 'failed' && /capabilit/i.test(event.reason)), JSON.stringify(missing));
    assert.equal(missing.some(event => event.type === 'running'), false);
    const events: RunnerEvent[] = [];
    handles.push(await runner(job(directory, { task: 'fixture-delegate' }), event => events.push(event)));
    await until(() => events.some(event => event.type === 'settled' || event.type === 'failed'));
    assert.ok(events.some(event => event.type === 'settled'), JSON.stringify(events));
    assert.deepEqual(delegated, ['Read contracts']);
  });
}
