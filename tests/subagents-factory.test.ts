import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { MultiSelectChecklist } from '../src/checklist.ts';
import { FACTORY_AGENTS, factoryCatalogue, loadFactoryAgent } from '../src/factory.ts';
import { cleanupExternalWorkspaces, createExternalWorkspace, finalizeExternalWorkspace } from '../src/workspace.ts';
import { artifactRoot, storageRoot, workspaceRoot } from '../src/storage.ts';

test('every factory agent loads only its package-owned profile and playbooks', () => {
  const profiles = FACTORY_AGENTS.map(name => loadFactoryAgent(name));
  assert.equal(profiles.length, 7);
  assert.deepEqual(profiles.map(profile => profile.name), [...FACTORY_AGENTS]);
  assert.ok(profiles.every(profile => profile.instructions.includes('## Assigned playbooks')));
  assert.equal(profiles.find(profile => profile.name === 'product-documenter')?.explicitOnly, true);
  assert.equal(profiles.find(profile => profile.name === 'implementer')?.workspace, 'isolated');
  assert.match(factoryCatalogue(), /bug-triager/);
  assert.match(factoryCatalogue(), /product-documenter.*explicit user request/i);
});

test('package state defaults outside Pi and separates state, workspaces, and artifacts', () => {
  assert.match(storageRoot('/home/test/.prjct'), /\.prjct\/subagents\/state$/);
  assert.match(workspaceRoot('/home/test/.prjct'), /\.prjct\/subagents\/workspaces$/);
  assert.match(artifactRoot('/home/test/.prjct'), /\.prjct\/subagents\/artifacts$/);
});

test('specification clarification supports selecting one or many topics', () => {
  const selected: Array<string[] | undefined> = [];
  const checklist = new MultiSelectChecklist({ terminal: { rows: 12 }, requestRender() {} } as any, { fg: (_: string, text: string) => text, bold: (text: string) => text } as any, value => selected.push(value));
  checklist.handleInput('\r'); assert.deepEqual(selected, []); assert.match(checklist.render(40).join('\n'), /Select at least one/);
  checklist.handleInput(' ');
  checklist.handleInput('\x1b[B');
  checklist.handleInput(' ');
  checklist.handleInput('\r');
  assert.deepEqual(selected, [['Problem and scope', 'Users and journeys']]);
  assert.ok(checklist.render(40).every(line => visibleWidth(line) <= 40));
  for (const _ of Array.from({ length: 12 })) checklist.handleInput('\x1b[B');
  const compact = checklist.render(40);
  assert.ok(compact.length <= 10); assert.match(compact.join('\n'), /Edge cases/);
});

test('external workspaces preserve the client and materialize a complete patch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagents-workspace-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'client'); await mkdir(source);
  await writeFile(join(source, 'tracked.txt'), 'before\n');
  await writeFile(join(source, '.gitignore'), 'ignored.txt\n');
  execFileSync('git', ['init', '--quiet'], { cwd: source });
  execFileSync('git', ['add', '--all'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'base'], { cwd: source });
  await writeFile(join(source, 'tracked.txt'), 'current client state\n');
  await writeFile(join(source, 'untracked.txt'), 'included\n');
  await writeFile(join(source, 'ignored.txt'), 'excluded\n');

  const workspace = await createExternalWorkspace(source, join(root, '.prjct', 'workspaces'));
  assert.equal(await readFile(join(workspace.cwd, 'tracked.txt'), 'utf8'), 'current client state\n');
  assert.equal(await readFile(join(workspace.cwd, 'untracked.txt'), 'utf8'), 'included\n');
  await assert.rejects(() => readFile(join(workspace.cwd, 'ignored.txt'), 'utf8'));

  await writeFile(join(workspace.cwd, 'tracked.txt'), 'implemented\n');
  await writeFile(join(workspace.cwd, 'new.txt'), 'new file\n');
  assert.equal(await finalizeExternalWorkspace(workspace), workspace.patchFile);
  const patch = await readFile(workspace.patchFile, 'utf8');
  assert.match(patch, /tracked\.txt/); assert.match(patch, /new\.txt/); assert.match(patch, /implemented/);
  assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'current client state\n');
  await cleanupExternalWorkspaces(join(root, '.prjct', 'workspaces'), 24, Date.now() + 25 * 3_600_000);
  assert.equal(await stat(workspace.workspace).catch(() => undefined), undefined);
});
