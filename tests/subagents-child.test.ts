import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { contains, installGuard, readAnswer } from '../src/child.ts';
import { ASK_PREFIX, DELEGATE_TOOL, READ_ONLY_TOOLS, REPORT_TOOL } from '../src/schema.ts';

/** The slice of the host a guard touches, and nothing else. */
function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  } as any;
  const call = (event: unknown, cwd: string) =>
    (handlers.get('tool_call') ?? []).map(handler => handler(event, { cwd })).at(-1);
  return { pi, tools, handlers, call };
}

const CHILD = { PI_SUBAGENTS_CHILD: '1' } as NodeJS.ProcessEnv;
const DELEGATOR = { PI_SUBAGENTS_CHILD: '1', PI_SUBAGENTS_CAN_DELEGATE: '1' } as NodeJS.ProcessEnv;
const report = (over: Record<string, unknown> = {}) => ({
  outcome: 'completed', summary: 'Read the importer.',
  criteria: [{ criterion: 'the retry path is covered', met: 'no', evidence: 'src/importer.ts:88' }],
  findings: [{ detail: 'the retry path swallows the error', file: 'src/importer.ts', line: 88 }],
  blockers: [], ...over,
});

test('loaded anywhere but inside a child, the guard does nothing at all', () => {
  const { pi, tools, handlers } = fakePi();
  assert.equal(installGuard(pi, {} as NodeJS.ProcessEnv), false);
  assert.equal(tools.size, 0, 'it never takes a tool away from a person who passed the wrong path');
  assert.equal(handlers.size, 0);
});

test('a report that does not match the contract is thrown back at the child, not sent', async () => {
  const { pi, tools } = fakePi();
  installGuard(pi, CHILD);
  const tool = tools.get(REPORT_TOOL);
  assert.ok(tool, 'the child has exactly one way to be heard');

  // Throwing is what marks a tool result as an error, and the parent forwards
  // only a report the child's own guard accepted.
  await assert.rejects(() => tool.execute('call_1', { outcome: 'approved', summary: 'looks good' }),
    /does not match the contract.*outcome/s);
  await assert.rejects(() => tool.execute('call_2', report({ criteria: 'all of them' })),
    /criteria/);

  const accepted = await tool.execute('call_3', report());
  assert.deepEqual(accepted.details, report(), 'an accepted report travels as it was written');
  assert.match(accepted.content[0].text, /session is over/);
});

test('a child that reaches for more than reading is told to report it, not killed', () => {
  const { pi, call } = fakePi();
  installGuard(pi, CHILD);

  const blocked = call({ toolName: 'bash', input: { command: 'npm test' } }, '/work');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, new RegExp(`call ${REPORT_TOOL} with it as a blocker`));
  assert.notEqual(blocked.terminate, true,
    'a child killed mid-task reports nothing, and the blocker is the thing the parent needs');

  for (const tool of READ_ONLY_TOOLS) {
    assert.equal(call({ toolName: tool, input: {} }, '/work'), undefined, `${tool} is allowed`);
  }
  assert.equal(call({ toolName: REPORT_TOOL, input: {} }, '/work'), undefined);
});

test('nothing outside the directory it was given, symlinks included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-subagents-guard-'));
  try {
    const work = join(root, 'work');
    const secret = join(root, 'private', 'auth.json');
    await mkdir(join(root, 'private'), { recursive: true });
    await mkdir(join(work, 'src'), { recursive: true });
    await writeFile(secret, '{"key":"sk-live"}');
    await writeFile(join(work, 'src', 'importer.ts'), 'export const importer = 1;\n');
    await symlink(secret, join(work, 'shortcut.json'));

    assert.equal(contains(work, 'src/importer.ts'), true);
    assert.equal(contains(work, './src'), true);
    assert.equal(contains(work), true, 'a tool with no path means the directory itself');
    assert.equal(contains(work, '../private/auth.json'), false);
    assert.equal(contains(work, secret), false, 'an absolute path out of the tree is still out of it');
    assert.equal(contains(work, 'shortcut.json'), false,
      'a symlink is judged by where it leads, not by the name it was given');

    const { pi, call } = fakePi();
    installGuard(pi, CHILD);
    const refused = call({ toolName: 'read', input: { path: secret } }, work);
    assert.equal(refused.block, true);
    assert.match(refused.reason, new RegExp(`call ${REPORT_TOOL} with that as a blocker`));
    assert.equal(call({ toolName: 'read', input: { path: 'src/importer.ts' } }, work), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the tools a child may call are ways of reading, and one way of reporting', () => {
  assert.deepEqual([...READ_ONLY_TOOLS], ['read', 'grep', 'find', 'ls']);
  assert.equal(READ_ONLY_TOOLS.some(tool => /write|edit|bash|apply|patch/.test(tool)), false);
});

test('a child only has a way to ask for a child where its parent allowed one', () => {
  const bottom = fakePi();
  installGuard(bottom.pi, CHILD);
  assert.equal(bottom.tools.has(DELEGATE_TOOL), false, 'absent, not merely discouraged');
  const blocked = bottom.call({ toolName: DELEGATE_TOOL, input: {} }, '/work');
  assert.equal(blocked.block, true, 'and blocked even if something calls it anyway');

  const middle = fakePi();
  installGuard(middle.pi, DELEGATOR);
  assert.equal(middle.tools.has(DELEGATE_TOOL), true);
  assert.equal(middle.call({ toolName: DELEGATE_TOOL, input: {} }, '/work'), undefined);
});

test('delegating asks the parent, and returns what the parent actually said', async () => {
  const { pi, tools } = fakePi();
  installGuard(pi, DELEGATOR);
  const asked: string[] = [];
  const ctx = {
    ui: {
      input: async (title: string) => {
        asked.push(title);
        return JSON.stringify({ ok: false, text: 'This tree has spent its 4 delegations.' });
      },
    },
  };

  const ask = { role: 'explorer', subject: 'map it', task: 'Map src/.' };
  const result = await tools.get(DELEGATE_TOOL).execute('call_1', ask, undefined, undefined, ctx);
  assert.equal(asked[0], `${ASK_PREFIX}${JSON.stringify(ask)}`, 'the parent is asked, in words it can parse');
  assert.equal(result.content[0].text, 'This tree has spent its 4 delegations.',
    'a refusal the parent made is what the child is told, not a local “accepted”');
  assert.equal(result.details.ok, false);
});

test('a parent that never answers is a refusal, not a wait', () => {
  // The dialog auto-dismisses on its timeout and comes back undefined.
  assert.equal(readAnswer(undefined).ok, false);
  assert.match(readAnswer(undefined).text, /did not answer, so nothing was started/);
  assert.equal(readAnswer('not json').ok, false);
  assert.equal(readAnswer('{"ok":"yes"}').ok, false, 'a shape it cannot read is a refusal too');
  assert.deepEqual(readAnswer('{"ok":true,"text":"Accepted."}'), { ok: true, text: 'Accepted.' });
});

test('a child with edit or write is a worker; its shell is unrestricted', () => {
  const { pi, call } = fakePi();
  installGuard(pi, { PI_SUBAGENTS_CHILD: '1', PI_SUBAGENTS_TOOLS: 'read,bash,edit,write,subagent_report' });
  assert.equal(call({ toolName: 'edit', input: { path: 'src/a.ts' } }, '/work'), undefined);
  assert.equal(call({ toolName: 'bash', input: { command: 'rm -rf dist' } }, '/work'), undefined,
    'a worker keeps the shell its parent had');
});

test('a child without edit and write is a reader, and its shell answers read-only commands only', () => {
  const { pi, call } = fakePi();
  installGuard(pi, { PI_SUBAGENTS_CHILD: '1', PI_SUBAGENTS_TOOLS: 'read,bash,grep,find,ls,subagent_report' });
  const blocked = call({ toolName: 'bash', input: { command: 'rm -rf dist' } }, '/work');
  assert.match(String(blocked?.reason), /read-only/);
  assert.equal(call({ toolName: 'bash', input: { command: 'git status' } }, '/work'), undefined);
  const edit = call({ toolName: 'edit', input: { path: 'src/a.ts' } }, '/work');
  assert.match(String(edit?.reason), /not available here/, 'edit was never in the allowlist');
});

test('without the environment list the child is read-only, as it was always promised', () => {
  const { pi, call } = fakePi();
  installGuard(pi, CHILD);
  assert.match(String(call({ toolName: 'bash', input: { command: 'ls' } }, '/work')?.reason), /not available here/);
});
