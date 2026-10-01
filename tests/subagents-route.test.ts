import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTE_MIN, ROUTE_QUESTION, TASK_LEVELS, modelFor, routeFor, type RouteChoice } from '../src/route.ts';
import type { Jev, JevAnswer } from '../src/jev.ts';

const choices = (ids: readonly string[]): RouteChoice[] => ids.map(modelId => ({ provider: 'test', modelId }));
const judge = (answer: JevAnswer | Error): Jev => async () => {
  if (answer instanceof Error) throw answer;
  return { level: answer };
};
const task = { subject: 'map the store', task: 'Read src/store.ts and report what it holds.' };

test('a level picks across the models this session has, cheapest first', () => {
  const one = choices(['only']);
  assert.equal(modelFor('reading', one), 'only');
  assert.equal(modelFor('reasoning', one), 'only');
  const two = choices(['cheap', 'strong']);
  assert.equal(modelFor('reading', two), 'cheap');
  assert.equal(modelFor('implementation', two), 'strong', 'with two, the middle is the stronger one');
  assert.equal(modelFor('reasoning', two), 'strong');
  const three = choices(['cheap', 'mid', 'strong']);
  assert.deepEqual(TASK_LEVELS.map(level => modelFor(level, three)), ['cheap', 'mid', 'strong']);
  const four = choices(['cheap', 'a', 'b', 'strong']);
  assert.deepEqual(TASK_LEVELS.map(level => modelFor(level, four)), ['cheap', 'b', 'strong']);
});

test('no judge, no answer or no choice runs the session\'s own model', async () => {
  for (const routed of [
    await routeFor(task, choices(['cheap']), undefined),
    await routeFor(task, [], judge({ type: 'choice', choice: 'reading', confidence: 1, probabilities: {} })),
  ]) assert.deepEqual(routed, { basis: 'session' });
});

test('an answer worth trusting routes to the level\'s model', async () => {
  const routed = await routeFor(task, choices(['cheap', 'strong']), judge({
    type: 'choice', choice: 'reading', confidence: 0.9, probabilities: { reading: 0.9 },
  }));
  assert.deepEqual(routed, { level: 'reading', confidence: 0.9, wanted: 'cheap', basis: 'routed' });
});

test('an unsure judge, an unknown level or a failure falls back to the session', async () => {
  const known = (choice: string, confidence: number): JevAnswer => ({ type: 'choice', choice, confidence, probabilities: {} });
  for (const answer of [
    known('reading', ROUTE_MIN - 0.01),
    known('a level this code does not know', 1),
    { type: 'noul', noul: 1 },
    known('reading', Number.NaN),
    new Error('the endpoint is down'),
  ]) {
    const routed = await routeFor(task, choices(['cheap', 'strong']), judge(answer as JevAnswer));
    assert.deepEqual(routed, { basis: 'session' }, JSON.stringify(answer));
  }
});

test('the judge is asked about the task, and nothing else', async () => {
  let asked: unknown;
  const jev: Jev = async (state, questions) => {
    asked = { state, questions };
    return { level: { type: 'choice', choice: 'reasoning', confidence: 1, probabilities: {} } };
  };
  const routed = await routeFor(task, choices(['cheap', 'strong']), jev);
  assert.equal(routed.wanted, 'strong');
  assert.deepEqual(asked, {
    state: { subject: task.subject, task: task.task },
    questions: ROUTE_QUESTION,
  });
});
