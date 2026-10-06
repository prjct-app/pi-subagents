import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { post } from '../src/wire.ts';
import { wireForwarder } from '../src/forward-wire.ts';

test('long-lived children receive beyond 24 messages; failed delivery retries without duplicates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wire-forward-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let n = 0; n < 60; n++) await post(root, 'tree', {
    id: String(n), from: 'sender', to: 'child', subject: 'Correction', body: `Evidence ${n}`, at: n,
  });
  const delivered: string[] = [];
  let reject = true;
  const poll = wireForwarder(root, 'tree', 'child', async message => {
    await new Promise(resolve => setTimeout(resolve, 1));
    if (message.id === '25' && reject) { reject = false; return false; }
    delivered.push(message.id);
    return true;
  }, () => false);
  await Promise.all([poll(), poll()]);
  assert.equal(delivered.length, 25);
  await poll();
  await poll();
  assert.deepEqual(delivered, Array.from({ length: 60 }, (_, n) => String(n)));
});
