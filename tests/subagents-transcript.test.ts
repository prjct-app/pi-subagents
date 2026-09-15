import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTranscript } from '../src/transcript.ts';

const line = (role: string, ...content: unknown[]) =>
  JSON.stringify({ type: 'message', message: { role, content } });

test('a session file reads as a bounded, labeled transcript', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'child.jsonl');
  await writeFile(file, [
    '{"type":"custom","customType":"noise","data":{}}',
    line('user', { type: 'text', text: 'Map the store and report how state flows.' }),
    line('assistant', { type: 'text', text: 'Reading src/store first.' }, { type: 'toolCall', name: 'read' }),
    line('toolResult', { type: 'text', text: 'export function makeStore' }),
    'not json at all',
    line('assistant', { type: 'text', text: 'The store owns the queue.' }),
  ].join('\n'));
  const entries = await readTranscript(file);
  assert.deepEqual(entries.map(entry => entry.who), ['task', 'agent', 'agent', 'tool', 'agent']);
  assert.match(entries.at(-1)?.text ?? '', /The store owns the queue/);
  assert.equal(entries[2].text, '→ read', 'a tool call is one compact line');
});

test('a missing or empty file is an empty transcript, never an error', async () => {
  assert.deepEqual(await readTranscript('/no/such/file.jsonl'), []);
});
