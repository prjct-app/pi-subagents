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

test('paged history preserves paragraphs and incremental reads wait for complete frames', async t => {
  const { appendFile } = await import('node:fs/promises');
  const { readTranscriptPage } = await import('../src/transcript.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-history-pages-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const text = 'First paragraph\nSecond paragraph ' + 'evidence '.repeat(50);
  await writeFile(file, line('assistant', { type: 'text', text }) + '\n');
  const page = await readTranscriptPage(file);
  assert.equal(page.entries[0].text, text);
  await appendFile(file, '{"type":"message","message":');
  const partial = await readTranscriptPage(file, undefined, page.next);
  assert.equal(partial.entries.length, 0); assert.equal(partial.next, page.next);
  await appendFile(file, '{"role":"assistant","content":[{"type":"text","text":"New evidence"}]}}\n');
  const next = await readTranscriptPage(file, undefined, partial.next);
  assert.equal(next.entries[0].text, 'New evidence');
});

test('older transcript pages have no duplicated boundary entries', async t => {
  const { readTranscriptPage } = await import('../src/transcript.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-history-boundary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  await writeFile(file, Array.from({ length: 600 }, (_, index) => line('assistant', { type: 'text', text: `${index}: ${'x'.repeat(700)}` })).join('\n') + '\n');
  const last = await readTranscriptPage(file); assert.ok(last.hasMore);
  const first = await readTranscriptPage(file, last.before);
  const texts = [...first.entries, ...last.entries].map(entry => entry.text);
  assert.equal(texts.length, 600); assert.equal(new Set(texts).size, 600);
});
