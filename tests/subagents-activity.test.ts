import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityOf, activityStore } from '../src/activity.ts';

test('streamed text updates the same activity entry and excludes thinking', () => {
  const store = activityStore(() => {});
  const partial = { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Reading' }] };
  store.add('j', activityOf({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', partial } })!);
  store.add('j', activityOf({ type: 'message_end', message: { ...partial, content: [{ type: 'text', text: 'Reading finished' }] } })!);
  assert.equal(store.get('j').length, 1); assert.equal(store.get('j')[0].text, 'Reading finished');
  assert.equal(activityOf({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', partial } }), undefined);
});

test('activity storage bounds memory, preserves tool identity and sanitizes text', () => {
  const store = activityStore(() => {});
  for (const index of Array.from({ length: 400 }, (_, index) => index)) store.add('j', { kind: 'message', text: 'x'.repeat(16000), messageId: String(index) });
  assert.ok(store.get('j').reduce((sum, item) => sum + item.text.length, 0) <= 256 * 1024);
  store.add('j', { kind: 'tool', text: '\x1b[31mread', toolCallId: 'tool', status: 'running' });
  const id = store.get('j').at(-1)!.id;
  store.add('j', { kind: 'tool', text: 'read', toolCallId: 'tool', status: 'done' });
  assert.equal(store.get('j').at(-1)!.id, id); assert.equal(store.get('j').at(-1)!.text, 'read');
});
