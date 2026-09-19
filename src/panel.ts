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
    paste: false, pasteValue: '', pasteOversize: false, confirmStop: '',
  };
  const collapsed = new Set<string>();
  const expandedTools = new Set<string>();
  const drafts = new Map<string, string>();
  const histories = new Map<string, History>();
  const dim = (text: string): string => theme.fg('dim', text);
  const accent = (text: string): string => theme.fg('accent', text);
  const request = (): void => { if (!state.disposed) tui.requestRender(); };
  // Keep the editor inside the panel's current height. Define these overrides directly:
  // pi supplies a forwarding Proxy whose setter would otherwise mutate the real TUI.
  const editorTerminal = Object.create(tui.terminal, {
    rows: { get: () => Math.max(5, Math.min(12, state.height - 5)) },
  });
  const editorTui = Object.create(tui, {
    terminal: { value: editorTerminal },
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
  const resetView = (): void => { state.scroll = 0; state.follow = true; state.history = false; state.notice = ''; state.confirmStop = ''; };
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
    if (state.confirmStop && (!job || job.id !== state.confirmStop || isTerminal(job.state))) { state.confirmStop = ''; state.notice = ''; }
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
    return [accent(theme.bold('SUMMARY')), ...paragraphs(value.summary, width),
      ...(value.criteria.length ? ['', accent(theme.bold('CRITERIA')), ...value.criteria.flatMap(item => [theme.fg(item.met === 'yes' ? 'success' : 'warning', `${item.met === 'yes' ? '✓' : item.met === 'no' ? '×' : '?'} ${plain(item.criterion)}`), ...paragraphs(item.evidence, width).map(dim)])] : []),
      ...(value.findings.length ? ['', accent(theme.bold('FINDINGS')), ...value.findings.flatMap(item => [...paragraphs(item.detail, width), ...(item.file ? [dim(`${plain(item.file)}${item.line ? `:${item.line}` : ''}`)] : [])])] : []),
      ...(value.blockers.length ? ['', theme.fg('warning', theme.bold('NEEDS ATTENTION')), ...value.blockers.flatMap(text => paragraphs(text, width))] : [])];
  };
  const activityLines = (job: Job, width: number): string[] => {
    const activity = state.history ? [] : source.activity?.(job.id) ?? [];
    if (activity.length) return activity.flatMap(entry => {
      if (entry.kind === 'tool') {
        const open = expandedTools.has(entry.id);
        return [theme.fg(entry.status === 'error' ? 'error' : 'muted', `${open ? '▾' : '▸'} ${entry.text}  ${entry.status ?? ''}`), ...(open && entry.detail ? paragraphs(entry.detail, width).map(dim) : [])];
      }
      const prefix = entry.kind === 'state' ? '○ ' : entry.kind === 'question' ? '! ' : '';
      return paragraphs(`${prefix}${entry.text}`, width).map(text => entry.kind === 'state' ? dim(text) : entry.kind === 'question' ? theme.fg('warning', text) : text);
    });
    const cache = history(job.id);
    if (cache.error) return [theme.fg('warning', cache.error)];
    if (!cache.entries.length) return [dim(cache.reading ? 'Loading history…' : 'Waiting for activity…'), ...paragraphs(job.task, width).map(dim)];
    return [dim(cache.more ? 'PgUp at the top loads earlier history' : 'Beginning of retained history'), ...cache.entries.flatMap((entry, index) => {
      const key = `history:${job.id}:${index}`;
      if (entry.who === 'tool' && !expandedTools.has(key)) return [dim(`▸ tool  ${entry.text.split('\n')[0]}`)];
      return [accent(entry.who === 'task' ? 'TASK' : entry.who === 'agent' ? 'AGENT' : 'TOOL'), ...paragraphs(entry.text, width)];
    })];
  };
  const detail = (job: Job | undefined, width: number, height: number): string[] => {
    if (!job) {
      state.pageHeight = height;
      state.contentHeight = 2;
      return [theme.bold('No agents yet'), theme.fg('muted', 'Turn delegation on with /agents on, then ask for work that splits into separate tasks.')];
    }
    const status = statusOf(job);
    const detailFocus = state.focus === 'detail' ? accent(theme.bold('›')) : ' ';
    const identity = `${detailFocus} ${theme.fg(status.color, status.icon)} ${accent(theme.bold(job.name))} ${dim(`· ${job.agent ?? job.role} · ${status.label} · ${seconds(job)}${spent(job)}`)}`;
    const title = dim(plain(job.subject));
    if (state.composing) {
      state.pageHeight = 0;
      state.contentHeight = 0;
      const label = `${state.composing === 'resume' ? 'CONTINUE' : 'MESSAGE'} ${accent(theme.bold(job.name))} ${dim(`· ${editor.getExpandedText().length}/${MAX_DRAFT}`)}`;
      return [label, ...editor.render(width)].slice(0, height);
    }
    const tabs = ['Activity', 'Result', 'Details'].map((tab, index) => index === state.tab ? accent(theme.bold(`[${index + 1} ${tab}]`)) : dim(`${index + 1} ${tab}`)).join('  ');
    const header = [identity, title, tabs];
    const content = state.tab === 0 ? activityLines(job, width) : state.tab === 1 ? report(job, width) : [
      accent('TASK'), ...paragraphs(job.task, width), '', accent('EXECUTION'), ...paragraphs(`ID: ${job.id}\nDirectory: ${job.cwd}${job.sourceCwd ? `\nSource: ${job.sourceCwd}` : ''}${job.patchFile ? `\nPatch: ${job.patchFile}` : ''}\nModel: ${job.provider}/${job.modelId}\nRunner: ${job.runner ?? 'process'}\nTools: ${(job.tools ?? []).join(', ')}\nSession: ${job.sessionFile ?? 'not created yet'}${job.resumedFrom ? `\nContinues: ${job.resumedFrom}` : ''}`, width),
      ...(source.limits ? ['', accent('LIMITS'), ...paragraphs(`${source.ledger()?.jobs.length ?? 0}/${source.limits().jobs} runs · ${source.limits().concurrency} concurrent\n${source.limits().timeoutMs / 1000}s per tree · depth ${source.limits().depth} · ${source.limits().descendants} descendants`, width)] : [])];
    const wrapped = content.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
    const room = Math.max(1, height - header.length);
    state.pageHeight = room;
    state.contentHeight = wrapped.length;
    if (state.follow && state.tab === 0) state.scroll = Math.max(0, wrapped.length - room);
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, wrapped.length - room)));
    return [...header, ...wrapped.slice(state.scroll, state.scroll + room)];
  };
  const tree = (width: number, height: number, showSubject: boolean): string[] => {
    const list = visible();
    const focus = selected();
    const index = list.findIndex(row => row.job.id === focus?.id);
    const head = state.searching ? search.render(width) : state.query ? [dim(`/ ${plain(state.query)} · ${list.length} match${list.length === 1 ? '' : 'es'}`)] : [];
    const capacity = Math.max(1, height - head.length);
    const from = Math.max(0, Math.min(index - Math.floor(capacity / 2), Math.max(0, list.length - capacity)));
    const body = list.slice(from, from + capacity).map(({ job, depth }) => {
      const status = statusOf(job);
      const chosen = job.id === focus?.id;
      const branch = allRows().some(row => row.job.parentJobId === job.id) ? collapsed.has(job.id) ? '▸' : '▾' : depth ? '└' : ' ';
      const lead = chosen && state.focus === 'tree' ? accent(theme.bold('›')) : ' ';
      const name = chosen ? accent(theme.bold(job.name)) : plain(job.name);
      const subject = showSubject ? dim(` — ${plain(job.subject)}`) : '';
      return `${lead} ${' '.repeat(Math.min(depth, 3))}${dim(branch)} ${theme.fg(status.color, status.icon)} ${name} ${dim(`· ${status.label} ${seconds(job)}`)}${subject}`;
    });
    return [...head, ...(body.length ? body : state.query || state.filter ? [dim('No matching agents. esc clears.')] : [])];
  };
  const render = (width: number): string[] => {
    state.width = width;
    const all = source.ledger()?.jobs ?? [];
    const terminalHeight = tui.terminal?.rows ?? 30;
    if (width <= 0 || terminalHeight <= 0) { state.height = 0; return []; }
    const wide = width >= 96;
    const compactTreeHeight = all.length + 4 + (state.searching || state.query ? 1 : 0);
    const draftWidth = Math.max(1, width - 4);
    const draftRows = editor.getExpandedText().split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(visibleWidth(line) / draftWidth)), 0);
    const composeHeight = 7 + Math.min(5, draftRows);
    const preferredHeight = state.help ? (width < 56 ? 12 : 11) : state.composing ? composeHeight
      : !wide && state.focus === 'tree' ? Math.max(8, Math.min(24, compactTreeHeight))
      : wide ? Math.max(12, Math.min(24, all.length + 10)) : 14;
    state.height = Math.min(preferredHeight, Math.max(1, terminalHeight));
    if (width < 24 || state.height < 6) {
      return [accent(theme.bold('Esc close')), dim('Need a 24×6 terminal')].slice(0, state.height).map(line => fit(` ${line}`, width));
    }
    const active = all.filter(job => !isTerminal(job.state) && job.state !== 'queued').length;
    const queue = all.filter(job => job.state === 'queued').length;
    const attention = all.filter(needsAttention).length;
    const filter = ['ALL', 'ACTIVE', 'ATTENTION'][state.filter];
    const stats = width < 56
      ? `${accent(`●${active}`)}  ${dim(`○${queue}`)}  ${attention ? theme.fg('warning', `!${attention}`) : dim('!0')}`
      : `${accent(`● ${active} running`)}  ${dim(`○ ${queue} queued`)}  ${attention ? theme.fg('warning', `! ${attention} attention`) : dim('! 0 attention')}`;
    const title = ` ${accent(theme.bold('Agents'))}  ${stats}  ${theme.fg('muted', filter.toLowerCase())}`;
    const find = state.searching || state.query ? '' : dim('/ search ');
    const head = `${title}${' '.repeat(Math.max(2, width - visibleWidth(title) - visibleWidth(find)))}${find}`;
    const bodyHeight = Math.max(2, state.height - 4);
    const leftWidth = wide ? Math.min(34, Math.max(26, Math.floor(width * 0.3))) : Math.max(1, width - 2);
    const rightWidth = wide ? Math.max(1, width - leftWidth - 3) : Math.max(1, width - 2);
    const job = selected();
    const left = tree(leftWidth, bodyHeight, !wide && rightWidth >= 56);
    const right = detail(job, rightWidth, bodyHeight);
    const help = width < 56
      ? ['↑↓/jk  move / scroll', 'Enter  open selected', 'Tab  agents / detail', '1/2/3  switch view', '/ search · f filter', 's message · r continue', 'x x stop · h history · t tools', 'Esc  back / close']
      : ['↑↓ / j k  move or scroll · Enter open · Tab switch pane', '1 / 2 / 3  activity, result, details', '/ search · f filter agents', 's message · r continue · x x stop', 'h retained history · t expand tool output', 'PgUp / PgDn page · Home top · End follow', 'Esc back or close · ? toggle help'];
    const body = Array.from({ length: bodyHeight }, (_, index) => {
      if (state.help) return ` ${fit(index < help.length ? plain(help[index]) : '', Math.max(1, width - 2))} `;
      if (!wide) return ` ${fit((state.focus === 'tree' && !state.composing ? left : right)[index] ?? '', Math.max(1, width - 2))} `;
      return `${fit(left[index] ?? '', leftWidth)} ${dim('│')} ${fit(right[index] ?? '', rightWidth)}`;
    });
    const position = state.contentHeight > state.pageHeight && state.pageHeight > 0
      ? `${Math.min(state.contentHeight, state.scroll + 1)}–${Math.min(state.contentHeight, state.scroll + state.pageHeight)}/${state.contentHeight}`
      : '';
    const narrow = width < 56;
    const hints = state.help ? narrow ? '↑↓ scroll · ?/Esc close' : 'Esc close help'
      : state.searching ? narrow ? '/ find · Enter done · Esc clear' : 'Type to filter · Enter apply · Esc cancel'
      : state.composing ? narrow ? 'Ctrl+S send · Esc save draft' : 'Enter newline · Ctrl+Enter / Ctrl+S send · Esc save draft'
      : state.focus === 'tree' ? narrow ? '↑↓ move · enter open · / find · esc' : 'enter open · s message · x stop · f filter · / search · ? keys · esc'
      : narrow ? `↑↓ ${position || 'scroll'} · s msg · Esc back` : `↑↓ scroll${position ? ` ${position}` : ''} · Tab agents · 1–3 view · s message · x stop · Esc back`;
    // Same grammar as every other panel: the key in accent, then what it does.
    const keyed = (text: string): string => text.split(' · ').map(part => {
      const match = part.match(/^(\S+(?: \/ \S+)?)(\s+.*)?$/u);
      return match ? `${accent(match[1]!)}${dim(match[2] ?? '')}` : dim(part);
    }).join(dim(' · '));
    const footer = state.pending ? accent(state.pending) : state.notice ? theme.fg('warning', state.notice) : keyed(hints);
    return [fit(head, width), dim('─'.repeat(width)), ...body, dim('─'.repeat(width)), fit(` ${footer}`, width)];
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
    if (state.confirmStop && matchesKey(data, Key.escape)) { state.confirmStop = ''; state.notice = ''; request(); return; }
    if (state.confirmStop && data !== 'x') { state.confirmStop = ''; state.notice = ''; }
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
      if (state.confirmStop !== job.id) {
        state.confirmStop = job.id;
        state.notice = `Stop ${job.name}${descendants ? ` + ${descendants} descendant${descendants === 1 ? '' : 's'}` : ''}? x confirm · Esc cancel`;
      } else {
        state.confirmStop = '';
        state.pending = `Stopping ${job.name}${descendants ? ` and its subtree (${descendants} descendants)` : ''}…`;
        void source.cancel(job.id, 'Stopped from the agents panel.').then(() => { state.notice = `${job.name} stopped.`; }, error => { state.notice = plain(String(error)); }).finally(() => { state.pending = ''; request(); });
      }
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

/** Docked like every other panel: it takes the editor's place, esc gives it back. */
export async function openAgentsPanel(ctx: ExtensionCommandContext, source: PanelSource): Promise<void> {
  await ctx.ui.custom<null>((tui, theme, _keys, done) => agentsPanel(source, tui, theme, () => done(null)));
}
