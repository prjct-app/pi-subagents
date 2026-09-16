import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { Editor, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';
import { stat } from 'node:fs/promises';
import { needsAttention, seconds, spent, statusOf } from './render.ts';
import { isTerminal, type Job, type Ledger } from './schema.ts';
import { plain } from './text.ts';
import { readTranscriptPage, type TranscriptEntry } from './transcript.ts';
import type { Activity } from './activity.ts';
import { descendants as jobDescendants, type Limits } from './manager.ts';

export type PanelSource = {
  ledger: () => Ledger | undefined;
  cancel: (jobId: string, reason: string) => Promise<void>;
  steer: (jobId: string, message: string) => Promise<boolean>;
  resume?: (jobId: string, message: string) => Promise<Job>;
  activity?: (jobId: string) => Activity[];
  subscribe?: (listener: () => void) => () => void;
  limits?: () => Limits;
  transcript?: (file: string) => Promise<TranscriptEntry[]>;
};

/** Corrupt cycles or missing ancestors must not hide a job or recurse forever. */
export function rows(ledger: Ledger | undefined): { job: Job; depth: number }[] {
  const jobs = ledger?.jobs ?? [];
  const seen = new Set<string>();
  const walk = (job: Job, depth: number): { job: Job; depth: number }[] => {
    if (seen.has(job.id)) return [];
    seen.add(job.id);
    return [{ job, depth }, ...jobs.filter(child => child.parentJobId === job.id).flatMap(child => walk(child, depth + 1))];
  };
  return [...jobs.filter(job => !job.parentJobId || !jobs.some(parent => parent.id === job.parentJobId)).flatMap(job => walk(job, 0)), ...jobs.flatMap(job => walk(job, 0))];
}

type History = { entries: TranscriptEntry[]; before?: number; next?: number; size: number; more: boolean; reading: boolean; final?: boolean; error?: string };
const MAX_DRAFT = 4000;
const safeDraft = (text: string): string => plain(text).replace(/\r\n?/g, '\n');

export function agentsPanel(source: PanelSource, tui: TUI, theme: Theme, done: () => void): Component & Focusable & { dispose(): void; handleInput(data: string): void } {
  const state = {
    selected: undefined as string | undefined, focus: 'tree' as 'tree' | 'detail', tab: 0, filter: 0,
    query: '', searching: false, help: false, notice: '', pending: '',
    composing: undefined as 'steer' | 'resume' | undefined, scroll: 0, follow: true,
    width: 100, height: 24, pageHeight: 10, contentHeight: 0, disposed: false, history: false,
    paste: false, pasteValue: '', pasteOversize: false,
  };
  const collapsed = new Set<string>();
  const expandedTools = new Set<string>();
  const drafts = new Map<string, string>();
  const histories = new Map<string, History>();
  const dim = (text: string): string => theme.fg('dim', text);
  const accent = (text: string): string => theme.fg('accent', text);
  const request = (): void => { if (!state.disposed) tui.requestRender(); };
  // A small editor viewport preserves space for activity even with a long draft.
  // Define overrides directly: pi supplies a forwarding Proxy whose setter would otherwise
  // replace the real TUI's requestRender and make request() recurse into itself.
  const editorTui = Object.create(tui, {
    terminal: { value: { rows: 16 } },
    requestRender: { value: request },
  }) as TUI;
  const editor = new Editor(editorTui, { borderColor: dim, selectList: { selectedPrefix: accent, selectedText: accent, description: dim, scrollInfo: dim, noMatch: dim } }, { paddingX: 0 });
  editor.disableSubmit = true;
  const search = new Input({ prompt: '/ ' });
  const allRows = () => rows(source.ledger());
  const visible = () => {
    const all = allRows();
    const hidden = new Set<string>();
    return all.filter(({ job }) => {
      if (job.parentJobId && (hidden.has(job.parentJobId) || collapsed.has(job.parentJobId))) { hidden.add(job.id); if (!state.query && state.filter === 0) return false; }
      if (state.filter === 1 && isTerminal(job.state)) return false;
      if (state.filter === 2 && !needsAttention(job)) return false;
      return `${job.name} ${job.subject} ${job.id}`.toLowerCase().includes(state.query.toLowerCase());
    });
  };
  const selected = (): Job | undefined => {
    const list = visible();
    if (!list.some(row => row.job.id === state.selected)) state.selected = list[0]?.job.id;
    return list.find(row => row.job.id === state.selected)?.job;
  };
  const resetView = (): void => { state.scroll = 0; state.follow = true; state.history = false; state.notice = ''; };
  const history = (id: string): History => {
    const cached = histories.get(id);
    if (cached) return cached;
    const fresh: History = { entries: [], size: -1, more: false, reading: false };
    histories.set(id, fresh);
    return fresh;
  };
  const loadHistory = async (job: Job, older = false): Promise<void> => {
    if (!job.sessionFile || state.disposed) return;
    const cache = history(job.id);
    if (cache.reading || (older && !cache.more)) return;
    cache.reading = true;
    try {
      if (source.transcript) {
        cache.entries = await source.transcript(job.sessionFile);
        cache.size = 0;
      } else {
        const size = (await stat(job.sessionFile)).size;
        if (!older && size === cache.size) { cache.final = isTerminal(job.state); return; }
        // Existing historical pages are stable; refresh only the current tail.
        const incremental = !older && cache.size >= 0 && size >= cache.size;
        const page = await readTranscriptPage(job.sessionFile, older ? cache.before : undefined, incremental ? cache.next : undefined);
        if (state.disposed) return;
        if (older) {
          cache.entries = [...page.entries, ...cache.entries].slice(0, 3000);
          cache.before = page.before;
        } else if (incremental) {
          cache.entries = [...cache.entries, ...page.entries].slice(-3000);
        } else {
          cache.entries = page.entries;
          cache.before = page.before;
        }
        if (!incremental) cache.more = page.hasMore && cache.entries.length < 3000;
        if (!older) { cache.size = page.next < size ? page.next : size; cache.next = page.next; }
      }
      cache.error = undefined;
      cache.final = isTerminal(job.state);
    } catch { cache.error = 'History is unavailable; live activity and the saved result remain below.'; }
    finally { cache.reading = false; request(); }
  };
  const refresh = (): void => {
    const job = selected();
    if (job && (state.history || !source.activity?.(job.id).length)) {
      // While browsing older pages, incoming text must not replace the viewport.
      if (state.follow || history(job.id).size === -1) void loadHistory(job);
    }
    request();
  };
  const unsubscribe = source.subscribe?.(refresh);
  const timer = setInterval(() => {
    const job = selected();
    if (job && (!isTerminal(job.state) || !history(job.id).final)) refresh();
  }, 1000);
  timer.unref?.();

  const fit = (text: string, width: number): string => {
    const clipped = truncateToWidth(text, Math.max(1, width));
    return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
  };
  const paragraphs = (text: string, width: number): string[] => plain(text).split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
  const report = (job: Job, width: number): string[] => {
    const value = job.report;
    if (!value) return [dim(isTerminal(job.state) ? job.reason ?? 'No report was returned.' : 'The report will appear when this agent finishes.'), ...paragraphs(job.question ?? '', width)];
    return [accent(theme.bold('SUMMARY')), ...paragraphs(value.summary, width), '', accent(theme.bold('ACCEPTANCE CRITERIA')),
      ...value.criteria.flatMap(item => [theme.fg(item.met === 'yes' ? 'success' : 'warning', `${item.met === 'yes' ? '✓' : item.met === 'no' ? '×' : '?'} ${plain(item.criterion)}`), ...paragraphs(item.evidence, width).map(dim), '']),
      ...(value.findings.length ? [accent(theme.bold('FINDINGS')), ...value.findings.flatMap(item => [...paragraphs(item.detail, width), ...(item.file ? [dim(`${plain(item.file)}${item.line ? `:${item.line}` : ''}`)] : []), ''])] : []),
      ...(value.blockers.length ? [theme.fg('warning', theme.bold('NEEDS ATTENTION')), ...value.blockers.flatMap(text => paragraphs(text, width))] : [])];
  };
  const activityLines = (job: Job, width: number): string[] => {
    const activity = state.history ? [] : source.activity?.(job.id) ?? [];
    if (activity.length) return activity.flatMap(entry => {
      if (entry.kind === 'tool') {
        const open = expandedTools.has(entry.id);
        return [theme.fg(entry.status === 'error' ? 'error' : 'muted', `${open ? '▾' : '▸'} ${entry.text}  ${entry.status ?? ''}`), ...(open && entry.detail ? paragraphs(entry.detail, width).map(dim) : [])];
      }
      const prefix = entry.kind === 'state' ? '○ ' : entry.kind === 'question' ? '! ' : '';
      return [...paragraphs(`${prefix}${entry.text}`, width).map(text => entry.kind === 'state' ? dim(text) : entry.kind === 'question' ? theme.fg('warning', text) : text), ''];
    });
    const cache = history(job.id);
    if (cache.error) return [theme.fg('warning', cache.error)];
    if (!cache.entries.length) return [dim(cache.reading ? 'Loading history…' : 'Waiting for activity…'), '', ...paragraphs(job.task, width).map(dim)];
    return [dim(cache.more ? 'PgUp at the top loads earlier history' : 'Beginning of retained history'), '', ...cache.entries.flatMap((entry, index) => {
      const key = `history:${job.id}:${index}`;
      if (entry.who === 'tool' && !expandedTools.has(key)) return [dim(`▸ tool  ${entry.text.split('\n')[0]}`)];
      return [accent(entry.who === 'task' ? 'TASK' : entry.who === 'agent' ? 'AGENT' : 'TOOL'), ...paragraphs(entry.text, width), ''];
    })];
  };
  const detail = (job: Job | undefined, width: number, height: number): string[] => {
    if (!job) return [accent('Delegate a focused task'), '', ...paragraphs('Agents will appear here with their live activity, evidence and controls.', width).map(dim)];
    const status = statusOf(job);
    const header = [theme.bold(plain(job.subject)), `${accent(job.name)} ${dim(job.role)} · ${theme.fg(status.color, status.label)}`, dim(`${job.modelId} · ${seconds(job)}${spent(job) || ' · cost unknown'}`), '',
      ['Activity', 'Result', 'Details'].map((tab, index) => index === state.tab ? accent(theme.bold(`${index + 1} ${tab}`)) : dim(`${index + 1} ${tab}`)).join('   '), dim('─'.repeat(width))];
    const top = state.composing ? header.slice(0, 2) : header;
    const content = state.tab === 0 ? activityLines(job, width) : state.tab === 1 ? report(job, width) : [
      accent('TASK'), ...paragraphs(job.task, width), '', accent('EXECUTION'), ...paragraphs(`ID: ${job.id}\nDirectory: ${job.cwd}\nModel: ${job.provider}/${job.modelId}\nRunner: ${job.runner ?? 'process'}\nTools: ${(job.tools ?? []).join(', ')}\nSession: ${job.sessionFile ?? 'not created yet'}${job.resumedFrom ? `\nContinues: ${job.resumedFrom}` : ''}`, width), '',
      ...(source.limits ? [accent('LIMITS'), ...paragraphs(`${source.ledger()?.jobs.length ?? 0}/${source.limits().jobs} session runs · ${source.limits().concurrency} concurrent\n${source.limits().timeoutMs / 1000}s per tree · depth ${source.limits().depth} · ${source.limits().descendants} descendants`, width)] : [])];
    const wrapped = content.flatMap(line => wrapTextWithAnsi(line, width));
    const draft = state.composing ? [accent(`${state.composing === 'resume' ? 'CONTINUE' : 'MESSAGE'} ${job.name} · ${editor.getExpandedText().length}/${MAX_DRAFT}`), ...editor.render(width)] : [];
    const room = Math.max(1, height - top.length - draft.length - 1);
    state.pageHeight = room;
    state.contentHeight = wrapped.length;
    if (state.follow && state.tab === 0) state.scroll = Math.max(0, wrapped.length - room);
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, wrapped.length - room)));
    const body = wrapped.slice(state.scroll, state.scroll + room);
    const position = `${Math.min(wrapped.length, state.scroll + 1)}–${Math.min(wrapped.length, state.scroll + room)} / ${wrapped.length}`;
    return [...top, ...body, ...Array.from({ length: Math.max(0, room - body.length) }, () => ''), dim(`${state.follow && state.tab === 0 ? 'Following' : 'Browsing'} · ${position}${state.tab === 0 ? ' · h history · t tool details' : ''}`), ...draft];
  };
  const tree = (width: number, height: number): string[] => {
    const list = visible();
    const focus = selected();
    const index = list.findIndex(row => row.job.id === focus?.id);
    const capacity = Math.max(1, Math.floor((height - 2) / 3));
    const from = Math.max(0, Math.min(index - Math.floor(capacity / 2), list.length - capacity));
    const head = state.searching ? search.render(width) : [dim(state.query ? `/ ${plain(state.query)}` : '/ Search agents')];
    const body = list.slice(from, from + capacity).flatMap(({ job, depth }) => {
      const status = statusOf(job);
      const chosen = job.id === focus?.id;
      const branch = allRows().some(row => row.job.parentJobId === job.id) ? collapsed.has(job.id) ? '▸' : '▾' : depth ? '└' : ' ';
      const name = `${chosen ? '›' : ' '} ${' '.repeat(Math.min(depth, 4))}${branch} ${job.name}`;
      return [chosen ? accent(theme.bold(name)) : plain(name), `   ${theme.fg(status.color, `${status.icon} ${status.label}`)} ${dim(seconds(job))}`, `   ${dim(plain(job.subject))}`];
    });
    return [...head, '', ...(body.length ? body : [dim('No matching agents.')])];
  };
  const render = (width: number): string[] => {
    state.width = width;
    const terminalHeight = tui.terminal?.rows ?? 30;
    state.height = Math.max(8, Math.floor(terminalHeight * 0.9));
    const all = source.ledger()?.jobs ?? [];
    const active = all.filter(job => !isTerminal(job.state) && job.state !== 'queued').length;
    const queue = all.filter(job => job.state === 'queued').length;
    const attention = all.filter(needsAttention).length;
    const head = ` ${theme.bold('AGENTS')}  ${accent(`${active} active`)}  ${dim(`${queue} queued`)}  ${attention ? theme.fg('warning', `${attention} need attention`) : dim('All clear')}`;
    const filters = ['All', 'Active', 'Attention'].map((text, index) => index === state.filter ? accent(`[${text}]`) : dim(text)).join('  ');
    const bodyHeight = Math.max(2, state.height - 6);
    const wide = width >= 100;
    const leftWidth = Math.min(40, Math.floor(width * 0.34));
    const rightWidth = wide ? width - leftWidth - 4 : width - 4;
    const job = selected();
    const left = tree(wide ? leftWidth - 2 : width - 4, bodyHeight);
    const right = detail(job, Math.max(1, rightWidth), bodyHeight);
    const help = ['NAVIGATION', '↑↓ / j k  Move or scroll', 'Tab  Switch tree / detail', '← →  Fold / unfold tree', '1 2 3  Activity / Result / Details', 'f  All / Active / Attention', '/  Search · Esc clear / return', 'PgUp/PgDn  Scroll · End follow', 'h  Retained history · t tool details', '', 'ACTIONS', 's  Message a live agent', 'r  Continue a retained conversation', 'x  Stop selected agent and descendants', 'Ctrl+Enter / Ctrl+S  Send message', 'Enter  New line while composing', 'Esc  Keep draft and return', '?  Close help'];
    const body = Array.from({ length: bodyHeight }, (_, index) => {
      if (state.help) return `  ${fit(index < help.length ? plain(help[index]) : '', width - 4)}  `;
      if (!wide) return `  ${fit((state.focus === 'tree' && !state.composing ? left : right)[index] ?? '', width - 4)}  `;
      return ` ${fit(left[index] ?? '', leftWidth - 1)} ${dim('│')} ${fit(right[index] ?? '', rightWidth)} `;
    });
    const footer = state.composing ? 'Enter new line · Ctrl+Enter / Ctrl+S send · Esc keep draft' : 'Tab focus · / search · f filter · s message · r resume · x stop · ? help';
    return [fit(head, width), fit(` ${filters}  ${dim(`${all.length}/${source.limits?.().jobs ?? 64} runs`)} ${dim(state.focus === 'tree' ? '· Agents' : '· Detail')}`, width), dim('─'.repeat(width)), ...body, dim('─'.repeat(width)), fit(` ${state.pending || state.notice || footer}`, width), fit(` ${state.pending || state.notice ? footer : '↑↓ navigate · 1 2 3 views · Esc back / close'}`, width)];
  };

  const leaveEditor = (): void => {
    const job = selected();
    if (job) drafts.set(`${job.id}:${state.composing}`, editor.getExpandedText());
    state.composing = undefined;
    editor.focused = false;
    state.paste = false; state.pasteValue = ''; state.pasteOversize = false;
  };
  const compose = (mode: 'steer' | 'resume'): void => {
    const job = selected();
    if (!job || state.pending) return;
    if (mode === 'steer' && isTerminal(job.state)) { state.notice = 'This agent finished. Press r to continue it.'; return; }
    if (mode === 'resume' && (!isTerminal(job.state) || !source.resume)) { state.notice = 'Resume is available for finished agents with retained history.'; return; }
    state.composing = mode; state.focus = 'detail';
    editor.setText(drafts.get(`${job.id}:${mode}`) ?? ''); editor.focused = true;
    state.notice = '';
  };
  const send = (): void => {
    const job = selected();
    const mode = state.composing;
    const text = safeDraft(editor.getExpandedText()).trim();
    if (!job || !mode || state.pending || !text) return;
    if (text.length > MAX_DRAFT) { state.notice = 'Message exceeds 4,000 characters. Shorten it before sending.'; return; }
    state.pending = `${mode === 'resume' ? 'Continuing' : 'Sending to'} ${job.name}…`;
    const action = mode === 'resume' ? source.resume!(job.id, text) : source.steer(job.id, text);
    void action.then(result => {
      if (result === false) throw new Error('The agent is no longer reachable. Your draft was kept.');
      drafts.delete(`${job.id}:${mode}`);
      editor.setText(''); state.composing = undefined; editor.focused = false;
      if (typeof result === 'object') { state.selected = result.id; state.filter = 0; state.query = ''; resetView(); }
      state.notice = mode === 'resume' ? `Continued ${job.name}.` : `Message delivered to ${job.name}.`;
    }).catch(error => { state.notice = plain((error as Error).message); }).finally(() => { state.pending = ''; request(); });
  };
  const editorInput = (data: string): void => {
    if (matchesKey(data, Key.escape)) { leaveEditor(); return; }
    if (state.pending) return;
    if (matchesKey(data, Key.ctrl('enter')) || matchesKey(data, Key.ctrl('s'))) { send(); return; }
    // Bracketed paste is accumulated here, bounded even when its closing marker never arrives.
    for (const token of data.split(/(\x1b\[200~|\x1b\[201~)/)) {
      if (token === '\x1b[200~') { state.paste = true; state.pasteValue = ''; state.pasteOversize = false; }
      else if (token === '\x1b[201~' && state.paste) {
        if (state.pasteOversize || editor.getExpandedText().length + state.pasteValue.length > MAX_DRAFT) state.notice = 'Paste rejected: the 4,000-character limit would be exceeded.';
        else editor.insertTextAtCursor(safeDraft(state.pasteValue));
        state.paste = false; state.pasteValue = '';
      } else if (state.paste) {
        if (state.pasteValue.length + token.length > MAX_DRAFT) state.pasteOversize = true;
        if (!state.pasteOversize) state.pasteValue += token;
      } else if (token) {
        const before = editor.getExpandedText();
        if (matchesKey(token, Key.enter)) editor.insertTextAtCursor('\n');
        else editor.handleInput(token);
        const text = safeDraft(editor.getExpandedText());
        if (text.length > MAX_DRAFT) { editor.setText(before); state.notice = 'Message limit: 4,000 characters.'; }
        else if (text !== editor.getExpandedText()) editor.setText(text);
      }
    }
  };
  const handleInput = (data: string): void => {
    if (state.composing) { editorInput(data); request(); return; }
    if (state.help) { if (data === '?' || matchesKey(data, Key.escape)) state.help = false; request(); return; }
    if (state.searching) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { state.searching = false; search.focused = false; }
      else { search.handleInput(data); search.setValue(plain(search.getValue()).slice(0, 160)); state.query = search.getValue(); resetView(); }
      request(); return;
    }
    const job = selected();
    if (matchesKey(data, Key.escape) || data === 'q') {
      if (state.query) { state.query = ''; search.setValue(''); }
      else if (state.focus === 'detail') state.focus = 'tree';
      else done();
    } else if (data === '?') state.help = true;
    else if (data === '/') { state.searching = true; search.focused = true; search.setValue(state.query); }
    else if (data === 'f') { state.filter = (state.filter + 1) % 3; resetView(); }
    else if (matchesKey(data, Key.tab)) state.focus = state.focus === 'tree' ? 'detail' : 'tree';
    else if (['1', '2', '3'].includes(data)) { state.tab = Number(data) - 1; state.focus = 'detail'; resetView(); }
    else if (data === 's') compose('steer');
    else if (data === 'r') compose('resume');
    else if (data === 'x' && job && !isTerminal(job.state) && !state.pending) {
      const ledger = source.ledger();
      const descendants = ledger ? jobDescendants(ledger, job.id).length : 0;
      state.pending = `Stopping ${job.name}${descendants ? ` and its subtree (${descendants} descendants)` : ''}…`;
      void source.cancel(job.id, 'Stopped from the agents panel.').then(() => { state.notice = `${job.name} stopped.`; }, error => { state.notice = plain(String(error)); }).finally(() => { state.pending = ''; request(); });
    } else if (matchesKey(data, Key.enter)) { state.focus = 'detail'; if (job && isTerminal(job.state)) state.tab = 1; resetView(); }
    else if (matchesKey(data, Key.left) && job && state.focus === 'tree') collapsed.add(job.id);
    else if (matchesKey(data, Key.right) && job && state.focus === 'tree') collapsed.delete(job.id);
    else if (data === 'h' && job) { state.history = true; state.tab = 0; state.focus = 'detail'; void loadHistory(job); }
    else if (data === 't' && job) {
      const entries = source.activity?.(job.id).filter(entry => entry.kind === 'tool') ?? [];
      const ids = state.history || !entries.length ? history(job.id).entries.map((_, index) => `history:${job.id}:${index}`) : entries.map(entry => entry.id);
      const open = ids.some(id => !expandedTools.has(id));
      for (const id of ids) { if (open) expandedTools.add(id); else expandedTools.delete(id); }
    } else if (matchesKey(data, Key.end)) { state.follow = true; state.scroll = Math.max(0, state.contentHeight - state.pageHeight); if (job && state.history) void loadHistory(job); }
    else if (matchesKey(data, Key.home)) { state.follow = false; state.scroll = 0; }
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data === 'j' || data === 'k' || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const up = matchesKey(data, Key.up) || data === 'k' || matchesKey(data, Key.pageUp);
      const page = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown);
      if (state.focus === 'tree' && !page) {
        const list = visible();
        const index = list.findIndex(row => row.job.id === job?.id);
        state.selected = list[Math.max(0, Math.min(list.length - 1, index + (up ? -1 : 1)))]?.job.id;
        resetView();
      } else {
        state.focus = 'detail'; state.follow = false;
        if (up && state.scroll === 0 && job && state.tab === 0) { state.history = true; void loadHistory(job, history(job.id).size !== -1); }
        state.scroll = Math.max(0, state.scroll + (up ? -1 : 1) * (page ? state.pageHeight : 1));
      }
    }
    refresh();
  };
  return {
    render, handleInput, invalidate() { editor.invalidate(); search.invalidate(); },
    dispose() { state.disposed = true; clearInterval(timer); unsubscribe?.(); },
    get focused() { return state.searching ? search.focused : editor.focused; },
    set focused(value: boolean) { search.focused = value && state.searching; editor.focused = value && Boolean(state.composing); },
  };
}

export async function openAgentsPanel(ctx: ExtensionCommandContext, source: PanelSource): Promise<void> {
  await ctx.ui.custom<null>((tui, theme, _keys, done) => agentsPanel(source, tui, theme, () => done(null)),
    { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%' } });
}
