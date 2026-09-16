import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultSettings, loadSettings, roleTools } from '../src/config.ts';
import { cleanupStorage, prepareSession, retainSettlement, resumable, sessionRoot } from '../src/storage.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { newJobId, type Job } from '../src/schema.ts';

const fixture = async (t: any) => { const root = await mkdtemp(join(tmpdir(), 'agents-settings-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const job = (cwd: string): Job => ({ id: newJobId(), name: 'Ada', role: 'reviewer', subject: 'review', task: 'review', context: '', provider: 'p', modelId: 'm', cwd, state: 'running', depth: 0, admitted: Date.now() });

test('layered settings validate every field and preserve lower-layer values', async t => {
  const root = await fixture(t); const home = join(root, 'home'); const project = join(root, 'project');
  await mkdir(home); await mkdir(join(project, '.pi'), { recursive: true });
  await writeFile(join(home, 'prjct-subagents.json'), JSON.stringify({ limits: { concurrency: 3, jobs: 80 }, retentionDays: 14, runner: 'in-process' }));
  await writeFile(join(project, '.pi', 'prjct-subagents.json'), JSON.stringify({ limits: { jobs: 120, concurrency: -1, nonsense: 2 }, retentionDays: 0, runner: 'process', extensionPackages: ['test', 'test'] }));
  const warnings: string[] = []; const settings = loadSettings(project, home, text => warnings.push(text));
  assert.equal(settings.limits.concurrency, 3); assert.equal(settings.limits.jobs, 120); assert.equal(settings.retentionDays, 14);
  assert.equal(settings.runner, 'process'); assert.deepEqual(settings.extensionPackages, ['test']); assert.equal(warnings.length, 3);
  await writeFile(join(project, '.pi', 'prjct-subagents.json'), '{broken');
  assert.equal(loadSettings(project, home, () => {}).runner, 'in-process');
  assert.deepEqual(loadSettings('/nonexistent', '/nonexistent', () => {}), defaultSettings());
});

test('readers cannot gain mutation, shell or unknown extension capabilities', () => {
  const active = ['read', 'grep', 'edit', 'write', 'bash', 'remote_mutation', 'agent_reply', 'subagent_send'];
  assert.deepEqual(roleTools('reviewer', active, true), ['read', 'grep']);
  assert.deepEqual(roleTools('explorer', active, true), ['read', 'grep']);
  assert.deepEqual(roleTools('worker', active, false), ['read', 'grep', 'edit', 'write', 'remote_mutation']);
  assert.ok(roleTools('worker', active, true).includes('bash'));
  assert.deepEqual(roleTools('worker', ['read', 'bash'], true), ['read']);
});

test('retained continuation forks a conversation without changing its source', async t => {
  const root = await fixture(t); const original = job(root); const dir = sessionRoot('parent', root);
  const file = await prepareSession(original, dir);
  const manager = SessionManager.open(file, undefined, root);
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Original evidence' }], api: 'openai-completions', provider: 'p', model: 'm', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
  const ended = { ...original, state: 'completed' as const, settled: Date.now(), sessionFile: file };
  assert.equal(await resumable(ended, 7), file);
  const second = await prepareSession({ ...job(root), resumedFrom: original.id, resumeSession: file }, dir);
  assert.notEqual(second, file);
  assert.match(JSON.stringify(SessionManager.open(second).getEntries()), /Original evidence/);
  await assert.rejects(() => resumable({ ...ended, settled: Date.now() - 8 * 86_400_000 }, 7), /expired/);
  await assert.rejects(() => resumable(original, 7), /still active/);
});

test('retention removes only expired owned terminal jobs, never active or symlinked directories', async t => {
  const root = await fixture(t); const dir = sessionRoot('parent', root);
  const old = job(root); const active = job(root); const fresh = job(root);
  await prepareSession(old, dir); await prepareSession(active, dir); await prepareSession(fresh, dir);
  const now = Date.now();
  await retainSettlement({ ...old, state: 'completed', settled: now - 8 * 86_400_000 }, dir);
  await retainSettlement({ ...fresh, state: 'completed', settled: now }, dir);
  const external = join(root, 'external'); await mkdir(external); await writeFile(join(external, 'keep'), 'keep');
  await symlink(external, join(dir, newJobId()));
  await cleanupStorage(root, 7, now);
  assert.equal(await stat(join(dir, old.id)).catch(() => undefined), undefined);
  assert.ok(await stat(join(dir, active.id))); assert.ok(await stat(join(dir, fresh.id))); assert.ok(await stat(join(external, 'keep')));
});
