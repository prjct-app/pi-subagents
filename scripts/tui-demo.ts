import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { CURSOR_MARKER, ProcessTerminal, TuiAltScreen } from '@earendil-works/pi-tui';
import { agentsPanel } from '../src/panel.ts';
import { DEFAULT_LIMITS } from '../src/manager.ts';
import type { Job, Ledger } from '../src/schema.ts';
import type { Activity } from '../src/activity.ts';

const now = Date.now();
const base: Job = { id: 'worker', name: 'Omar', role: 'worker', subject: 'Make cancellation reliable', task: 'Fix the cancellation race. Preserve existing reports and verify that a stopped tree leaves no active descendants.', context: '', provider: 'openai', modelId: 'gpt-5.4', cwd: '/workspace/project', state: 'running', admitted: now - 74000, started: now - 72000, depth: 0, tools: ['read', 'grep', 'edit', 'write'], runner: 'process' };
const jobs: Job[] = [base,
  { ...base, id: 'reader', name: 'Nadia', role: 'reviewer', parentJobId: 'worker', depth: 1, subject: 'Review lifecycle boundaries', modelId: 'claude-sonnet', started: now - 32000, tools: ['read', 'grep'] },
  { ...base, id: 'blocked', name: 'Iris', role: 'explorer', state: 'completed', settled: now - 10000, subject: 'Check provider compatibility', report: { outcome: 'blocked', summary: 'The built-in providers are compatible. The custom proxy needs an explicit package configuration before a child can use it.', criteria: [{ criterion: 'Resolve installed providers', met: 'yes', evidence: 'Verified the model catalogue and SDK initialization.' }, { criterion: 'Validate the custom proxy', met: 'unknown', evidence: 'The proxy extension is not in the child allowlist.' }], findings: [{ detail: 'Child sessions correctly reject unavailable providers rather than changing models.', file: 'src/runner.ts', line: 516 }], blockers: ['Choose the proxy extension package to enable for children.'] } },
  { ...base, id: 'queued', name: 'Ada', role: 'reviewer', state: 'queued', subject: 'Validate retained history', started: undefined },
  { ...base, id: 'done', name: 'Theo', role: 'reviewer', state: 'completed', settled: now - 18000, subject: 'Audit tool permissions', usage: { cost: 0.018, tokens: 12400 }, report: { outcome: 'completed', summary: 'Readers cannot acquire write tools or an unrestricted shell. Worker capabilities remain bounded by the parent.', criteria: [{ criterion: 'Readers are read-only', met: 'yes', evidence: 'The role allowlist excludes edit, write and bash.' }], findings: [], blockers: [] } },
];
const activities: Activity[] = [
  { id: 'a1', at: now - 74000, kind: 'state', text: 'Starting focused implementation' },
  { id: 'a2', at: now - 72000, kind: 'tool', text: 'read  src/jobs.ts', detail: 'Inspect the lifecycle controller and cancellation transitions.', status: 'done' },
  { id: 'a3', at: now - 45000, kind: 'message', text: 'The cancellation race occurs when a slot is released before the child has stopped. I am keeping the slot reserved until teardown completes.' },
  { id: 'a4', at: now - 32000, kind: 'tool', text: 'edit  src/jobs.ts', detail: 'Move terminal settlement after the process group stops. Preserve the original cancellation reason.', status: 'done' },
  { id: 'a5', at: now - 20000, kind: 'message', text: 'The lifecycle change is in place. Nadia is checking the boundary cases while I validate delivery retries and retained sessions.' },
  { id: 'a6', at: now - 1000, kind: 'tool', text: 'read  tests/subagents-jobs.test.ts', detail: 'Checking failure, cancellation and timeout coverage.', status: 'running' },
];
const listeners = new Set<() => void>();
const source = { ledger: (): Ledger => ({ v: 2, session: 'demo', jobs }), limits: () => DEFAULT_LIMITS,
  activity: (id: string) => id === 'worker' ? activities : [], subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  cancel: async (id: string) => { const job = jobs.find(job => job.id === id); if (job) job.state = 'cancelled'; for (const fn of listeners) fn(); },
  steer: async (_id: string, message: string) => { activities.push({ id: `a${activities.length}`, at: Date.now(), kind: 'message', text: `You: ${message}` }); for (const fn of listeners) fn(); return true; },
  resume: async (id: string, task: string) => { const original = jobs.find(job => job.id === id)!; const next = { ...original, id: `${id}-resumed`, name: 'Rhea', task, state: 'queued' as const, report: undefined, resumedFrom: id }; jobs.push(next); for (const fn of listeners) fn(); return next; },
};
const colors: Record<string, string> = { accent: '104;211;190', dim: '131;145;164', muted: '178;190;207', success: '142;204;146', warning: '239;191;109', error: '243;135;135' };
const theme: any = { fg: (color: string, text: string) => `\x1b[38;2;${colors[color] ?? '220;226;234'}m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function ansiHtml(text: string): string {
  const state = { color: '#dce2ea', bold: false };
  return text.split(CURSOR_MARKER).join('').split(/(\x1b\[[0-9;]*m)/).map(part => {
    if (part.startsWith('\x1b[')) {
      const code = part.slice(2, -1);
      if (code.startsWith('38;2;')) state.color = `rgb(${code.slice(5).split(';').join(',')})`;
      else if (code === '39' || code === '0') state.color = '#dce2ea';
      if (code === '1') state.bold = true;
      if (code === '22' || code === '0') state.bold = false;
      return '';
    }
    return `<span style="color:${state.color};font-weight:${state.bold ? 700 : 400}">${escape(part)}</span>`;
  }).join('');
}
if (process.argv.includes('--snapshot')) {
  const cards: string[] = [];
  const metrics: number[] = [];
  for (const [width, height, key, title] of [[120, 40, '', 'Live overview · 120 × 40'], [120, 40, 'result', 'Evidence and blockers'], [80, 24, '', 'Compact terminal · 80 × 24'], [60, 20, 'message', 'Multiline message · 60 × 20'], [160, 50, '', 'Wide terminal · 160 × 50']] as const) {
    const panel = agentsPanel(source, { terminal: { rows: height }, requestRender() {} } as any, theme, () => {});
    if (key === 'result') { panel.handleInput('j'); panel.handleInput('j'); panel.handleInput('2'); }
    if (key === 'message') { panel.handleInput('s'); panel.handleInput('Check the shutdown race\nand keep the report intact.'); }
    const start = performance.now(); const lines = panel.render(width); metrics.push(performance.now() - start); panel.dispose();
    cards.push(`<section><h2>${title}</h2><pre>${ansiHtml(lines.join('\n'))}</pre></section>`);
  }
  await mkdir('build', { recursive: true });
  await writeFile('build/tui-preview.html', `<!doctype html><html><meta charset="utf-8"><title>pi-subagents · terminal render review</title><style>body{background:#0b0e13;color:#dce2ea;margin:40px;font:14px system-ui}h1{font-size:24px}h2{font-size:14px;color:#9cacc1;font-weight:500}section{margin:36px 0}pre{display:inline-block;background:#11161e;border:1px solid #293242;border-radius:10px;padding:20px;font:13px/1.6 Menlo,monospace;white-space:pre}p{color:#9cacc1}</style><h1>pi-subagents</h1><p>Actual component output · deterministic fixtures · no model calls</p>${cards.join('')}</html>`);
  console.log(JSON.stringify({ snapshots: cards.length, renderMs: metrics, path: 'build/tui-preview.html' }));
} else {
  const terminal = new ProcessTerminal(); const tui = new TuiAltScreen(terminal);
  const panel = agentsPanel(source, tui, theme, () => { panel.dispose(); tui.stop(); process.exit(0); });
  tui.addChild(panel); tui.setFocus(panel); tui.start();
}
