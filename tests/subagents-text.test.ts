import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipGraphemes, plain } from '../src/text.ts';

test('a cap counts what a person sees, never UTF-16 units', () => {
  assert.equal(clipGraphemes('a'.repeat(300), 240).length, 240);
  // A ZWJ family is one grapheme made of five code points.
  assert.equal(clipGraphemes('👨‍👩‍👧x', 1), '👨‍👩‍👧');
  // A combining accent belongs to the letter it modifies.
  assert.equal(clipGraphemes('ébc', 1), 'é');
  assert.equal(clipGraphemes('ab', 10), 'ab', 'a short text is returned whole');
  assert.equal(clipGraphemes('abc', 0), '', 'zero means no graphemes, not one');
  assert.equal(clipGraphemes('abc', -1), '', 'a negative limit is empty too');
  assert.equal(clipGraphemes('', 5), '');
});

test('plain removes OSC and CSI runs and bare controls', () => {
  assert.equal(plain('a\x1b[31mb\x07c'), 'abc');
  assert.equal(plain('a\x1b]0;title\x07b'), 'ab');
  assert.equal(plain(undefined), '');
});
