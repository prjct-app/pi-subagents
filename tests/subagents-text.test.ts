import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipGraphemes, plain } from '../src/text.ts';
import { resultContent, statusOf } from '../src/render.ts';
import type { Job } from '../src/schema.ts';

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

test('parent delivery retains every report and final prose beyond terminal preview limits', () => {
  const jobs = Array.from({ length: 7 }, (_, index): Job => ({
    id: `j_${index}`, name: `Agent ${index}`, subject: 'Evidence', role: 'reviewer', state: 'completed',
    task: 'Inspect', context: '', provider: 'offline', modelId: 'fixture', cwd: '/fixture', depth: 0, admitted: 1,
    report: { outcome: 'unassessed', summary: 'Result\n'.repeat(200) + `TAIL_${index}`, criteria: [], findings: [], blockers: [] },
  }));
  const delivered = resultContent(jobs);
  for (const job of jobs) assert.ok(delivered.includes(job.report!.summary));
  assert.equal(statusOf(jobs[0]!).label, 'Returned');
  const structured = { ...jobs[0]!, report: { ...jobs[0]!.report!, outcome: 'completed' as const,
    findings: Array.from({ length: 41 }, (_, index) => ({ detail: `Finding ${index}` })),
    criteria: [{ criterion: 'Preserve evidence', met: 'yes' as const, evidence: 'VERIFICATION_RECEIPT' }] } };
  assert.match(resultContent([structured]), /Finding 40/);
  assert.match(resultContent([structured]), /VERIFICATION_RECEIPT/);
});
