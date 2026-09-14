import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MAX, MIN_CHARS, parseTriage, worthTriaging } from '../src/auto.ts';

test('short prompts and commands are not worth a triage call', () => {
  assert.equal(worthTriaging('fix the typo'), false);
  assert.equal(worthTriaging('/agents'), false);
  assert.equal(worthTriaging(` ${'x'.repeat(MIN_CHARS)}`), true);
  assert.equal(worthTriaging('x'.repeat(MIN_CHARS - 1)), false);
});

test('a complex answer parses, capped and sanitized', () => {
  const plan = parseTriage(`{"complex": true, "subtasks": [
    {"role": "explorer", "subject": "map the store", "task": "Read src/store/."},
    {"role": "nonsense", "subject": "review the runner", "task": "Read src/runner.ts."},
    {"role": "reviewer", "subject": "", "task": "no subject is dropped"},
    {"role": "explorer", "subject": "third", "task": "Read src/jobs.ts."},
    {"role": "explorer", "subject": "fourth", "task": "Past the cap."}
  ]}`);
  assert.equal(plan.complex, true);
  assert.equal(plan.subtasks.length, AUTO_MAX, 'hard cap before the ledger sees anything');
  assert.equal(plan.subtasks[1].role, 'explorer', 'an unknown role is a reader, never a made-up one');
});

test('anything unreadable, or a "no", launches nothing', () => {
  for (const raw of ['', 'not json', '{}', '{"complex": false, "subtasks": []}',
    '{"complex": true}', '{"complex": true, "subtasks": "many"}', '[{"complex": true}]',
    '{"complex": true, "subtasks": [{"role": "explorer", "subject": "s", "task": ""}]}']) {
    assert.deepEqual(parseTriage(raw), { complex: false, subtasks: [] }, raw || '(empty)');
  }
});
