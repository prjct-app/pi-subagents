import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_CHOICES, childPrompt, choiceHint, eligible, findChoice, modelKey, neutralCatalogue, resolveWorkDir, roleBrief,
} from '../src/context.ts';
import { REPORT_TOOL } from '../src/schema.ts';

const model = (provider: string, id: string, input: number, output: number) =>
  ({ provider, id, name: id, cost: { input, output }, contextWindow: 200_000, reasoning: true });

const CATALOGUE = [
  model('anthropic', 'claude-opus-4-5', 5, 25),
  model('openai-codex', 'gpt-5.4-mini', 0.25, 2),
  model('openai-codex', 'gpt-5.6-luna', 1.25, 10),
];

test('the list a parent chooses from is the session’s, cheapest first', () => {
  const choices = eligible({ available: CATALOGUE });
  assert.deepEqual(choices.map(choice => choice.key),
    ['openai-codex/gpt-5.4-mini', 'openai-codex/gpt-5.6-luna', 'anthropic/claude-opus-4-5']);
  assert.equal(choices[0].in, 0.25);
  assert.equal(findChoice(choices, modelKey('anthropic', 'claude-opus-4-5'))?.label, 'claude-opus-4-5');
  assert.equal(findChoice(choices, 'anthropic/nothing-like-it'), undefined,
    'a model outside the list is not a model, whatever asked for it');
});

test('a scoped session scopes its children too', () => {
  const scoped = [model('openai-codex', 'gpt-5.4-mini', 0.25, 2)];
  const choices = eligible({ available: CATALOGUE, scoped });
  assert.deepEqual(choices.map(choice => choice.key), ['openai-codex/gpt-5.4-mini'],
    'a person who scoped their session did not scope it for everything except its children');
  assert.equal(eligible({ available: CATALOGUE, scoped: [] }).length, 3,
    'an empty scope is the host saying “everything”, not “nothing”');
});

test('the list is deduplicated and bounded, whatever the catalogue does', () => {
  const many = Array.from({ length: 40 }, (_, index) => model('p', `m${index}`, index, index));
  const choices = eligible({ available: [...many, ...many] });
  assert.equal(choices.length, MAX_CHOICES);
  assert.equal(new Set(choices.map(choice => choice.key)).size, MAX_CHOICES);
  // The cap keeps the cheap end, which is the end a parent should reach for.
  assert.equal(choices.at(-1)?.key, `p/m${MAX_CHOICES - 1}`);
});

test('the hint prices the two ends, because the middle is in the list already', () => {
  const hint = choiceHint(eligible({ available: CATALOGUE }));
  assert.match(hint, /Cheapest openai-codex\/gpt-5\.4-mini \(\$0\.25\/\$2 per Mtok\)/);
  assert.match(hint, /most capable anthropic\/claude-opus-4-5 \(\$5\/\$25 per Mtok\)/);
  assert.match(choiceHint([]), /no model to offer/, 'and it says so rather than offering nothing');
});

test('a child is told its task and what it was handed, and nothing else', () => {
  const prompt = childPrompt({
    name: 'Nadia', role: 'reviewer',
    subject: 'review the importer',
    task: 'Read src/importer.ts and report the gaps.',
    context: 'The retry path was rewritten last week.',
  });

  assert.match(prompt, /You are Nadia/);
  assert.ok(prompt.includes(roleBrief('reviewer')));
  assert.match(prompt, /Read src\/importer\.ts and report the gaps\./);
  assert.match(prompt, /The retry path was rewritten last week\./);
  assert.match(prompt, new RegExp(`Calling ${REPORT_TOOL} ends this session`));
  assert.match(prompt, /not a verdict/, 'a child returns evidence; the parent judges');
  assert.match(prompt, /report it as a blocker/, 'and it never waits for anyone');
  assert.match(prompt, /no extensions, no skills/);
  assert.match(prompt, /^- read —/m);
  assert.match(prompt, /^- grep —/m);
  assert.match(prompt, /^- find —/m);
  assert.match(prompt, /^- ls —/m);
  assert.match(prompt, new RegExp(`- ${REPORT_TOOL} —`));
  assert.doesNotMatch(prompt, /subagent_delegate/, 'the tool is absent, not forbidden in prose');
  assert.match(prompt, /do not have write, edit, or an unrestricted shell/);
});

test('a child that may delegate is told the tool exists, and one that may not is not', () => {
  const base = { name: 'Ada', role: 'explorer' as const, subject: 'map it', task: 'Map src/.' };
  const allowed = childPrompt({ ...base, canDelegate: true });
  const refused = childPrompt({ ...base, canDelegate: false });
  assert.match(allowed, /subagent_delegate/);
  assert.doesNotMatch(refused, /subagent_delegate/);
});

test('the prompt is a function of the job, so no environment can leak into it', () => {
  const job = { name: 'Theo', role: 'explorer' as const, subject: 'map it', task: 'Map src/.' };
  const before = childPrompt(job);
  process.env.PI_TEAM_SECRET_UNDER_TEST = 'sk-live-must-not-travel';
  process.env.PI_SUBAGENTS_DEPTH = '1';
  try {
    assert.equal(childPrompt(job), before, 'same job, same prompt, whatever the parent’s environment holds');
    assert.equal(before.includes('sk-live-must-not-travel'), false);
    assert.match(before, /Nothing beyond the task above/, 'no context given is said, not invented');
  } finally {
    delete process.env.PI_TEAM_SECRET_UNDER_TEST;
    delete process.env.PI_SUBAGENTS_DEPTH;
  }
});

test('a job is fenced to a real directory, or refused', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-cwd-'));
  assert.deepEqual(resolveWorkDir(root), { cwd: root }, 'omitted means the parent session\'s directory');
  assert.deepEqual(resolveWorkDir(root, '.'), { cwd: root });
  const missing = resolveWorkDir(root, 'no-such-folder');
  assert.equal('refused' in missing, true);
  await writeFile(join(root, 'a-file'), 'x');
  const file = resolveWorkDir(root, 'a-file');
  assert.equal('refused' in file, true);
});

test('a child prompt names the tools it was actually given', () => {
  const worker = childPrompt({ name: 'Nadia', role: 'explorer', subject: 's', task: 't',
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'] });
  assert.match(worker, /edit — change a file/);
  assert.match(worker, /same tools as the session that asked/);
  assert.doesNotMatch(worker, /do not have write/);
  const reader = childPrompt({ name: 'Nadia', role: 'explorer', subject: 's', task: 't' });
  assert.match(reader, /do not have write, edit, or an unrestricted shell/);
});

test('the catalogue a child chooses from carries facts, never advice', () => {
  const text = neutralCatalogue(eligible({ available: CATALOGUE }));
  assert.ok(text.indexOf('anthropic/claude-opus-4-5') < text.indexOf('openai-codex/gpt-5.4-mini'));
  assert.doesNotMatch(text, /cheapest|most capable/i);
  assert.match(text, /\$0.25\/\$2 per Mtok, 400k window|0\.25/);
  assert.match(childPrompt({ name: 'Nadia', role: 'explorer', subject: 's', task: 't' }), /subagent_model/);
});
