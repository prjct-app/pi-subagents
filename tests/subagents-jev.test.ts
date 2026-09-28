import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COMPLEX_MIN, ruledOut } from '../src/auto.ts';
import { askJev, headline, questionFor, readFiles, summarize } from '../src/ask-jev.ts';
import type { Jev, JevAnswer } from '../src/jev.ts';

const noul = (p: number): JevAnswer => ({ type: 'noul', noul: p });

test('only an answer below the line rules the plan out; no answer never does', () => {
  assert.equal(ruledOut(undefined), false);
  assert.equal(ruledOut(COMPLEX_MIN - 0.01), true);
  assert.equal(ruledOut(COMPLEX_MIN), false);
  assert.equal(ruledOut(0.97), false);
});

test('the question shape follows the input: yes/no by default, a pick-one with an exit, a score', () => {
  assert.deepEqual(questionFor({ question: 'Does `content` log secrets?' }), { answer: { type: 'noul', instructions: 'Does `content` log secrets?' } });
  const pick = questionFor({ question: 'Which layer?', options: { ui: 'renders', data: 'stores' } }).answer as any;
  assert.equal(pick.type, 'choice');
  assert.deepEqual(Object.keys(pick.criteria), ['ui', 'data', 'other'], 'an exit is added');
  const kept = questionFor({ question: 'Which?', options: { a: 'x', other: 'mine' } }).answer as any;
  assert.equal(kept.criteria.other, 'mine', 'an exit the model wrote is kept');
  const scale = questionFor({ question: 'How risky?', levels: ['isolated', 'shared', 'core'] }).answer as any;
  assert.deepEqual(scale, { type: 'score', instructions: 'How risky?', criteria: ['isolated', 'shared', 'core'] });
});

test('answers come back short: the decision, its weight, and the nearest level in words', () => {
  assert.deepEqual(summarize(noul(0.934), { question: 'q' }), { answer: 'yes', p_yes: 0.93 });
  assert.deepEqual(summarize(noul(0.12), { question: 'q' }), { answer: 'no', p_yes: 0.12 });
  assert.deepEqual(
    summarize({ type: 'choice', choice: 'data', confidence: 0.71, probabilities: { data: 0.71, ui: 0.24, other: 0.05 } }, { question: 'q', options: { ui: '', data: '' } }),
    { choice: 'data', confidence: 0.71, also: [{ label: 'ui', p: 0.24 }] });
  assert.deepEqual(
    summarize({ type: 'score', score: 1.6, confidence: 0.8, probabilities: {}, legend: {} }, { question: 'q', levels: ['low', 'mid', 'high'] }),
    { score: 1.6, of: 2, level: 'high', confidence: 0.8 });
  assert.equal(headline({ answer: 'yes', p_yes: 0.93 }), 'yes 0.93');
  assert.equal(headline({ results: [{ answer: 'yes' }, { answer: 'no' }, { answer: 'yes' }] }), '2 of 3 yes');
});

test('secrets, binaries and directories are never sent, and each says why', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-jev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;');
  await writeFile(join(dir, '.env'), 'TOKEN=abc');
  await writeFile(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
  await mkdir(join(dir, 'src'));
  const { files, skipped } = await readFiles(['a.ts', '.env', 'blob.bin', 'src', 'missing.ts'], dir);
  assert.deepEqual(files, [{ path: 'a.ts', content: 'export const a = 1;' }]);
  assert.deepEqual(skipped.map(item => [item.path, item.reason]), [
    ['.env', 'looks like a secret; not sent'], ['blob.bin', 'binary'], ['src', 'a directory; pass its files'], ['missing.ts', 'not readable'],
  ]);
});

test('one call judges the files together; each=true asks per file in parallel and never returns the file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-jev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'auth.ts'), 'verify(token)');
  await writeFile(join(dir, 'seed.ts'), 'insert rows');
  const states: any[] = [];
  const jev: Jev = async state => {
    states.push(state);
    return { answer: noul(String((state as any).content ?? '').includes('verify') ? 0.95 : 0.1) };
  };

  const one = await askJev(jev, { question: 'Does `content` validate tokens?', paths: ['auth.ts'] }, dir);
  assert.deepEqual(one, { answer: 'yes', p_yes: 0.95 });
  assert.deepEqual(states[0], { path: 'auth.ts', content: 'verify(token)' });

  const each = await askJev(jev, { question: 'Does `content` validate tokens?', paths: ['auth.ts', 'seed.ts', '.env'], each: true }, dir);
  assert.deepEqual(each, {
    results: [{ path: 'auth.ts', answer: 'yes', p_yes: 0.95 }, { path: 'seed.ts', answer: 'no', p_yes: 0.1 }],
    skipped: [{ path: '.env', reason: 'looks like a secret; not sent' }],
  });
  assert.equal(JSON.stringify(each).includes('verify(token)'), false, 'the file never comes back');

  assert.deepEqual(await askJev(jev, { question: 'q' }, dir), { error: 'give paths or text to judge' });
});
