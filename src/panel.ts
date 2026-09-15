import { DynamicBorder, type Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { reportLines, seconds, spent, stateColor } from './render.ts';
import { isTerminal, type Job, type Ledger } from './schema.ts';
import { plain } from './text.ts';
import { readTranscript, type TranscriptEntry } from './transcript.ts';

/**
 * The /agents panel: the ledger, live, with a person's hands on it.
 *
 * It reads the same ledger everything else reads, so the panel, the widget,
 * the tools and `/agents` can never disagree about what is running. Control is
 * deliberate: `x` stops the selected job and everything under it, and `enter`
 * on a live job takes over its view — the child's own transcript, live, with a
 * line to steer it by. What a person types there travels the same steer path
 * the wire and the escalation use.
 */
export type PanelSource = {
  ledger: () => Ledger | undefined;
  cancel: (jobId: string, reason: string) => Promise<void>;
  /** Words for a live child. False when there is nobody to hear them. */
  steer: (jobId: string, message: string) => Promise<boolean>;
};

/** One visible row: a job and the depth it is drawn at, in tree order. */
export function rows(ledger: Ledger | undefined): { job: Job; depth: number }[] {
  const jobs = ledger?.jobs ?? [];
  const under = (parentJobId: string | undefined, depth: number): { job: Job; depth: number }[] =>
    jobs.filter(job => job.parentJobId === parentJobId)
      .flatMap(job => [{ job, depth }, ...under(job.id, depth + 1)]);
  return under(undefined, 0);
}

/** How often the view repaints, so elapsed times and transcripts move. */
const REPAINT_MS = 500;
/** How much of the transcript the takeover shows. */
const TRANSCRIPT_LINES = 12;

export function agentsPanel(source: PanelSource, tui: TUI, theme: Theme, done: () => void): Component & { dispose(): void; handleInput(data: string): void } {
  const state = {
    selected: 0,
    /** The settled job whose report is unfolded, by id. One at a time is enough. */
    expanded: undefined as string | undefined,
    notice: '',
    /** Takeover: the live job being watched, and the words being typed to it. */
    watching: undefined as string | undefined,
    draft: '',
    transcript: [] as TranscriptEntry[],
  };
  const border = new DynamicBorder((s: string) => theme.fg('accent', s));

  const watched = (): Job | undefined =>
    state.watching ? rows(source.ledger()).find(row => row.job.id === state.watching)?.job : undefined;

  const repaint = setInterval(() => {
    // A takeover refreshes its transcript from the file, which is the honest
    // record; a job whose file never appeared keeps its panel, not a live view.
    const job = watched();
    if (job?.sessionFile && !isTerminal(job.state)) {
      void readTranscript(job.sessionFile).then(entries => { state.transcript = entries; }).catch(() => undefined);
    }
    tui.requestRender();
  }, REPAINT_MS);
  // A timer that keeps a session alive on its own is a leak, not a feature.
  repaint.unref?.();

  const line = ({ job, depth }: { job: Job; depth: number }, selected: boolean): string => {
    const marker = selected ? theme.fg('accent', '›') : ' ';
    const indent = `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}`;
    const name = selected ? theme.bold(plain(job.name)) : plain(job.name);
    return `${marker} ${indent}${name} ${theme.fg('muted', job.role)} ${theme.fg(stateColor(job.state), job.state)} `
      + `${plain(job.subject)} ${theme.fg('dim', job.modelId)} ${theme.fg('dim', `${seconds(job)}${spent(job)}`)}`;
  };

  const renderList = (width: number): string[] => {
    const all = rows(source.ledger());
    const liveCount = all.filter(row => !isTerminal(row.job.state)).length;
    const head = ` Agents · ${liveCount} live · ${all.length} total `;
    const body = all.length === 0
      ? [theme.fg('dim', 'No delegated jobs.')]
      : all.flatMap((row, index) => {
        const main = line(row, index === state.selected);
        if (state.expanded !== row.job.id) return [main];
        return [main, ...reportLines(row.job).map(detail => `${'  '.repeat(row.depth + 2)}${theme.fg('dim', detail)}`)];
      });
    const footer = theme.fg('dim', `${state.notice ? `${state.notice} · ` : ''}↑↓ move · enter watch/report · x stop · esc close`);
    return [
      ...border.render(width),
      truncateToWidth(theme.fg('accent', theme.bold(head)), width),
      ...body.map(text => truncateToWidth(text, width)),
      truncateToWidth(footer, width),
      ...border.render(width),
    ];
  };

  const renderTakeover = (job: Job, width: number): string[] => {
    const head = ` ${plain(job.name)} · ${job.role} · ${job.state} · ${job.modelId} · ${seconds(job)}${spent(job)} `;
    const who = (entry: TranscriptEntry): string =>
      entry.who === 'task' ? theme.fg('muted', ' task ')
        : entry.who === 'agent' ? theme.fg('accent', ' agent')
        : theme.fg('dim', ' tool ');
    const body = state.transcript.length === 0
      ? [theme.fg('dim', job.sessionFile ? 'Nothing on the transcript yet.' : 'This job never said where its transcript lives.')]
      : state.transcript.slice(-TRANSCRIPT_LINES).map(entry => `${who(entry)} ${plain(entry.text)}`);
    const draft = `${theme.fg('accent', '›')} ${state.draft}▏`;
    const footer = theme.fg('dim', `${state.notice ? `${state.notice} · ` : ''}type to steer · enter send · esc back`);
    return [
      ...border.render(width),
      truncateToWidth(theme.fg('accent', theme.bold(head)), width),
      ...body.map(text => truncateToWidth(text, width)),
      truncateToWidth(draft, width),
      truncateToWidth(footer, width),
      ...border.render(width),
    ];
  };

  const render = (width: number): string[] => {
    const job = watched();
    return job ? renderTakeover(job, width) : renderList(width);
  };

  const takeOverKeys = (data: string): void => {
    const job = watched();
    if (!job) { state.watching = undefined; state.transcript = []; state.draft = ''; return; }
    if (matchesKey(data, Key.escape)) {
      state.watching = undefined;
      state.transcript = [];
      state.draft = '';
      state.notice = '';
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const words = state.draft.trim();
      if (words) {
        state.draft = '';
        void source.steer(job.id, words).then(
          sent => { state.notice = sent ? 'Steered.' : `${plain(job.name)} could not hear it.`; },
          () => { state.notice = `${plain(job.name)} could not hear it.`; },
        );
      }
      return;
    }
    if (data === '\x7f') { state.draft = state.draft.slice(0, -1); return; }
    // Printable input — single keys and pasted runs alike — is draft text.
    if (!data.startsWith('\x1b') && !data.includes('\x00')) state.draft += data;
  };

  const listKeys = (data: string): void => {
    const all = rows(source.ledger());
    if (matchesKey(data, Key.escape) || data === 'q') { done(); return; }
    if (matchesKey(data, Key.up)) state.selected = Math.max(0, state.selected - 1);
    else if (matchesKey(data, Key.down)) state.selected = Math.min(Math.max(0, all.length - 1), state.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      const target = all[state.selected]?.job;
      if (!target) return;
      if (!isTerminal(target.state) && target.sessionFile) {
        state.watching = target.id;
        state.notice = '';
        return;
      }
      if (!isTerminal(target.state)) {
        state.notice = `${plain(target.name)} has not said where its transcript lives yet.`;
        return;
      }
      if (target.report || target.reason) {
        state.expanded = state.expanded === target.id ? undefined : target.id;
      }
    } else if (data === 'x') {
      const target = all[state.selected]?.job;
      if (target && !isTerminal(target.state)) {
        // The same cancel the agent_jobs tool uses: the job, its subtree, and
        // every process below it, settled with a reason a person wrote.
        void source.cancel(target.id, 'Stopped from the agents panel.').then(
          () => { state.notice = `${plain(target.name)} stopped.`; },
          () => { state.notice = `${plain(target.name)} could not be stopped.`; },
        );
      }
    }
  };

  const handleInput = (data: string): void => {
    if (state.watching) takeOverKeys(data);
    else listKeys(data);
    tui.requestRender();
  };

  return {
    render,
    handleInput,
    invalidate() {},
    dispose() { clearInterval(repaint); },
  };
}

/** The command's half: an overlay panel in a terminal, lines anywhere else. */
export async function openAgentsPanel(ctx: ExtensionCommandContext, source: PanelSource): Promise<void> {
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) => agentsPanel(source, tui, theme, () => done(null)),
    { overlay: true, overlayOptions: { width: '80%', minWidth: 60, maxHeight: '80%' } },
  );
}
