import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGuard } from '../src/child.ts';

test('isolated children protect PII discovered after delegation at both model boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-child-privacy-'));
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerTool() {} };
  try {
    installGuard(pi as never, { PI_SUBAGENTS_CHILD: '1', PRJCT_HOME: root });
    const ctx = { abort: () => assert.fail('clean keychain must not cancel') };
    const content = [{ role: 'toolResult', content: [{ type: 'text', text: 'person@example.com' }] }];
    const context = await handlers.get('context')!({ messages: content }, ctx);
    assert.ok(JSON.stringify(context).includes('p**********@****.com'));
    assert.ok(!JSON.stringify(context).includes('person@example.com'));
    const payload = await handlers.get('before_provider_request')!({ payload: { messages: content } }, ctx);
    assert.ok(!JSON.stringify(payload).includes('person@example.com'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
