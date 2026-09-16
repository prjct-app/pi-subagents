import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { plain } from './text.ts';
import type { Job, JobState, Ledger, Report } from './schema.ts';

/**
 * How jobs read, in the terminal and in the message that reaches the model.
 *
 * Everything a child wrote passes through `plain()` before it is shown: a
 * report is text from a model running in another process, and a renderer is
 * never the thing that puts control codes on someone's screen.
 *
 * Both forms are bounded. The transcript form is free but unreadable past a
 * few lines; the delivered form is paid on every later turn, so it carries the
 * evidence and drops the prose.
 */
const SUMMARY = 600;
const CRITERIA = 6;
const FINDINGS = 8;
const BLOCKERS = 5;
const JOBS = 4;
const LINE = 160;

const one = (text: unknown, limit = LINE): string =>
  plain(text).replace(/\s+/g, ' ').trim().slice(0, limit);

/** The theme color a state reads in: one glance, no legend. */
export const stateColor = (state: JobState): 'accent' | 'dim' | 'error' | 'muted' | 'success' | 'warning' =>
  state === 'completed' ? 'success'
    : state === 'failed' || state === 'timed_out' ? 'error'
    : state === 'cancelled' || state === 'interrupted' ? 'muted'
    : state === 'running' ? 'accent'
    : state === 'starting' || state === 'stopping' ? 'warning'
    : 'dim';

export const seconds = (job: Job): string => {
  const from = job.started ?? job.admitted;
  const to = job.settled ?? Date.now();
  const elapsed = Math.max(0, Math.round((to - from) / 1000));
  return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s` : `${elapsed}s`;
};

export const spent = (job: Job): string =>
  job.usage?.cost === undefined ? '' : ` · $${job.usage.cost < 0.01 ? job.usage.cost.toFixed(4) : job.usage.cost.toFixed(2)}`;

/** One job, one line: who, what, how it is going. */
export const jobLine = (job: Job): string =>
  `${one(job.name, 24)} · ${job.role} · ${job.state} · ${one(job.subject, 60)} · ${seconds(job)}${spent(job)}`;

/**
 * The whole ledger, nested under the job that asked for each piece.
 *
 * Provenance is the point: a line indented under another is work that one
 * delegated, which is the same shape the panel draws.
 */
export function ledgerLines(ledger: Ledger | undefined): string[] {
  const jobs = ledger?.jobs ?? [];
  if (jobs.length === 0) return ['No delegated jobs.'];
  const under = (parentJobId: string | undefined, depth: number): string[] =>
    jobs.filter(job => job.parentJobId === parentJobId).flatMap(job => [
      `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}${jobLine(job)}`,
      ...under(job.id, depth + 1),
    ]);
  return under(undefined, 0);
}

const met = (report: Report | undefined, value: 'yes' | 'no' | 'unknown'): number =>
  (report?.criteria ?? []).filter(item => item.met === value).length;

/** What a finished job found, as evidence rather than as an opinion. */
export function reportLines(job: Job): string[] {
  const report = job.report;
  if (!report) return [job.reason ? `Ended: ${one(job.reason)}` : `Ended as ${job.state}.`];
  const criteria = (report.criteria ?? []).filter(item => item.met !== 'yes').slice(0, CRITERIA)
    .map(item => `- ${item.met === 'no' ? 'not met' : 'unknown'}: ${one(item.criterion)}${item.evidence ? ` — ${one(item.evidence)}` : ''}`);
  const findings = (report.findings ?? []).slice(0, FINDINGS)
    .map(item => `- ${one(item.detail)}${item.file ? ` (${one(item.file, 200)}${item.line ? `:${item.line}` : ''})` : ''}`);
  const blockers = (report.blockers ?? []).slice(0, BLOCKERS).map(item => `- ${one(item)}`);
  return [
    `Summary: ${one(report.summary, SUMMARY)}`,
    `Criteria: ${met(report, 'yes')} met, ${met(report, 'no')} not met, ${met(report, 'unknown')} unknown`,
    ...criteria,
    ...(findings.length > 0 ? ['Findings:', ...findings] : []),
    ...(blockers.length > 0 ? ['Blockers:', ...blockers] : []),
  ];
}

/** The collapsed line every tool result and entry opens as. */
export function collapsed(heading: string) {
  return {
    invalidate() {},
    render(width: number) { return [truncateToWidth(`${heading} · Ctrl+O details`, width)]; },
  };
}

/** One job, one line, in the session's own colors. */
export function themedJobLine(job: Job, theme: Theme): string {
  return `${theme.bold(plain(job.name))} ${theme.fg('muted', job.role)} ${theme.fg(statusOf(job).color, statusOf(job).label)} `
    + `${plain(job.subject)} ${theme.fg('dim', `${seconds(job)}${spent(job)}`)}`;
}

export function jobView(job: Job | undefined, expanded: boolean, theme?: Theme) {
  if (!job || typeof job.subject !== 'string') return new Text('Job unavailable', 0, 0);
  const heading = theme ? `▸ ${themedJobLine(job, theme)}` : `▸ ${jobLine(job)}`;
  if (!expanded) return collapsed(heading);
  return new Text([heading, ...reportLines(job)].join('\n'), 1, 0);
}

export function ledgerView(ledger: Ledger | undefined, expanded: boolean, theme?: Theme) {
  const jobs = ledger?.jobs ?? [];
  const open = jobs.filter(job => job.state === 'running' || job.state === 'starting' || job.state === 'queued').length;
  const heading = `▸ jobs · ${jobs.length} delegated · ${open} open`;
  if (theme) {
    const titled = theme.fg('toolTitle', theme.bold(heading));
    if (!expanded) return collapsed(titled);
    return new Text([titled, ...ledgerLines(ledger)].join('\n'), 1, 0);
  }
  if (!expanded) return collapsed(heading);
  return new Text([heading, ...ledgerLines(ledger)].join('\n'), 1, 0);
}

/**
 * What the parent is told when jobs finish.
 *
 * It says plainly that this is data and not a verdict, and it names what the
 * parent now owes: a job that came back blocked is unresolved work, and the
 * task it belongs to cannot be called done while it is open.
 */
export function resultContent(jobs: readonly Job[]): string {
  const shown = jobs.slice(0, JOBS);
  const rest = jobs.length - shown.length;
  const blocked = jobs.filter(job => (job.report?.blockers?.length ?? 0) > 0);
  return [
    `${jobs.length} job${jobs.length === 1 ? '' : 's'} finished (evidence, not a verdict).`,
    ...shown.flatMap(job => [
      `${one(job.name, 24)} (${job.role}) · ${one(job.subject, 60)} · ${job.state}`,
      ...reportLines(job),
    ]),
    ...(rest > 0 ? [`${rest} more; agent_jobs status.`] : []),
    ...(blocked.length > 0 ? ['Blocked jobs are unresolved. Do not call this task done while they are open.'] : []),
  ].join('\n').trim();
}

/** UI status is an outcome, not merely the runner's terminal state. */
export function statusOf(job: Job): { label: string; icon: string; color: ReturnType<typeof stateColor> } {
  if (job.continuedBy) return { label: 'Continued', icon: '↗', color: 'dim' };
  if (job.question || job.report?.outcome === 'blocked' || (job.report?.blockers.length ?? 0) > 0) return { label: 'Needs attention', icon: '!', color: 'warning' };
  const labels: Record<JobState, string> = { queued: 'Queued', starting: 'Starting', running: 'Running', stopping: 'Stopping', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
  return { label: labels[job.state], icon: job.state === 'completed' ? '✓' : job.state === 'running' ? '●' : ['failed', 'timed_out'].includes(job.state) ? '×' : '○', color: stateColor(job.state) };
}
export const needsAttention = (job: Job): boolean => !job.continuedBy && (statusOf(job).color === 'warning' && Boolean(job.question || job.report?.outcome === 'blocked' || job.report?.blockers.length) || ['failed', 'timed_out', 'interrupted'].includes(job.state));
