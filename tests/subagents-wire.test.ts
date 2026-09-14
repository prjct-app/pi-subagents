import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { post, read, recent, wireFile } from '../src/wire.ts';

const message = (over: Record<string, unknown> = {}) => ({
  id: `m_${Math.random().toString(36).slice(2)}`, from: 'Ada', to: 'Omar',
  subject: 'the store', body: 'state flows down', at: 1, ...over,
});

test('a message reaches only who it addresses, and a broadcast reaches everyone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await post(root, 't1', message({ id: 'a', to: 'Omar' }));
  await post(root, 't1', message({ id: 'b', from: 'Omar', to: '*' }));
  assert.deepEqual((await read(root, 't1', 0, 'Omar')).messages.map(m => m.id), ['a', 'b']);
  assert.deepEqual((await read(root, 't1', 0, 'Ada')).messages.map(m => m.id), ['b']);
  assert.deepEqual((await read(root, 't1', 0, 'Nobody')).messages.map(m => m.id), ['b'],
    'a broadcast reaches even a name nobody chose');
});

test('byte offsets make a second read repeat nothing, and a torn tail is left for later', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await post(root, 't1', message({ id: 'a' }));
  const first = await read(root, 't1', 0, 'Omar');
  assert.deepEqual(first.messages.map(m => m.id), ['a']);
  assert.deepEqual((await read(root, 't1', first.offset, 'Omar')).messages, [], 'nothing is read twice');
  await post(root, 't1', message({ id: 'b' }));
  assert.deepEqual((await read(root, 't1', first.offset, 'Omar')).messages.map(m => m.id), ['b']);

  // A writer that died mid-line: the reader does not choke and does not skip it.
  await appendFile(wireFile(root, 't1'), '{"id":"torn"');
  const torn = await read(root, 't1', 0, 'Omar');
  assert.ok(!torn.messages.some(m => m.id === 'torn'));
  await writeFile(wireFile(root, 't1'),
    (await import('node:fs/promises').then(fs => fs.readFile(wireFile(root, 't1'), 'utf8'))) + ',"from":"A","to":"Omar","subject":"s","body":"b","at":2}\n');
  const healed = await read(root, 't1', torn.offset, 'Omar');
  assert.deepEqual(healed.messages.map(m => m.id), ['torn']);
});

test('concurrent posts from two writers both land, in some order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 10 }, (_, i) => post(root, 't1', message({ id: `w${i}`, to: '*' }))));
  assert.equal((await read(root, 't1', 0, 'Omar')).messages.length, 10);
});

test('an oversized message is refused, and recent bounds what a pull returns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await post(root, 't1', message({ body: 'x'.repeat(32 * 1024) })), false);
  for (const i of Array.from({ length: 25 }, (_, i) => i)) await post(root, 't1', message({ id: `m${i}` }));
  const last = await recent(root, 't1', 'Omar');
  assert.equal(last.length, 20);
  assert.equal(last.at(-1)?.id, 'm24');
});
