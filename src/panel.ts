import { DynamicBorder, type Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import { reportLines, seconds, spent, stateColor } from './render.ts';
import { isTerminal, type Job, type Ledger } from './schema.ts';
import { plain } from './text.ts';

/**
 * The /agents panel: the ledger, live, with a person's hands on it.
 *
 * It reads the same ledger everything else reads, so the panel, the widget,
 * the tools and `/agents` can never disagree about what is running. Control is
 * one deliberate key: `x` stops the selected job and everything under it,
 * through the same cancel path the model's own agent_jobs tool uses.
 */
export type PanelSource = {
  ledger: () => Ledger | undefined;
  cancel: (jobId: string, reason: string) => Promise<void>;
};

/** One visible row: a job and the depth it is drawn at, in tree order. */
export function rows(ledger: Ledger | undefined): { job: Job; depth: number }[] {
  const jobs = ledger?.jobs ?? [];
  const under = (parentJobId: string | undefined, depth: number): { job: Job; depth: number }[] =>
    jobs.filter(job => job.parentJobId === parentJobId)
      .flatMap(job => [{ job, depth }, ...under(job.id, depth + 1)]);
  return under(undefined, 0);
}

/** How often the view repaints, so elapsed times move while nothing changes. */
const REPAINT_MS = 500;

export function agentsPanel(source: PanelSource, tui: TUI, theme: Theme, done: () => void): Component & { dispose(): void; handleInput(data: string): void } {
  const state = {
    selected: 0,
    /** The job whose report is unfolded, by id. One at a time is enough. */
    expanded: undefined as string | undefined,
    notice: '',
  };
  const border = new DynamicBorder((s: string) => theme.fg('accent', s));
  const repaint = setInterval(() => tui.requestRender(), REPAINT_MS);

  const line = ({ job, depth }: { job: Job; depth: number }, selected: boolean): string => {
    const marker = selected ? theme.fg('accent', '›') : ' ';
    const indent = `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}`;
    const name = selected ? theme.bold(plain(job.name)) : plain(job.name);
    return `${marker} ${indent}${name} ${theme.fg('muted', job.role)} ${theme.fg(stateColor(job.state), job.state)} `
      + `${plain(job.subject)} ${theme.fg('dim', job.modelId)} ${theme.fg('dim', `${seconds(job)}${spent(job)}`)}`;
  };

  const render = (width: number): string[] => {
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
    const footer = theme.fg('dim', `${state.notice ? `${state.notice} · ` : ''}↑↓ move · enter details · x stop · esc close`);
    return [
      ...border.render(width),
      truncateToWidth(theme.fg('accent', theme.bold(head)), width),
      ...body.map(text => truncateToWidth(text, width)),
      truncateToWidth(footer, width),
      ...border.render(width),
    ];
  };

  const handleInput = (data: string): void => {
    const all = rows(source.ledger());
    if (matchesKey(data, Key.escape) || data === 'q') { done(); return; }
    if (matchesKey(data, Key.up)) state.selected = Math.max(0, state.selected - 1);
    else if (matchesKey(data, Key.down)) state.selected = Math.min(Math.max(0, all.length - 1), state.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      const target = all[state.selected]?.job;
      if (target && (target.report || target.reason)) {
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
