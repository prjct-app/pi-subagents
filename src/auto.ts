import { ROLES, type Role } from './schema.ts';

/**
 * The triage that decides whether a prompt earns parallel experts.
 *
 * Delegation is not a tool the session calls: pi itself launches subagents
 * when the task is complex, because the point is context economy — several
 * small experts reading in parallel, each with a fresh window, returning only
 * bounded evidence. Launching one for a prompt a single lookup would answer is
 * the opposite of that, so the bar is high and the default is "not complex".
 *
 * Everything here is pure: the model call is injected, so a test never needs
 * one. The extension owns when to triage and what to do with the answer.
 */
export type Subtask = { role: Role; subject: string; task: string };
export type Triage = { complex: boolean; subtasks: Subtask[] };

/** Shorter than this and the triage call costs more than the reading would. */
export const MIN_CHARS = 160;
/** Auto-launched subagents per prompt, capped before the ledger's own limits. */
export const AUTO_MAX = 3;

/** Whether a prompt is even worth the triage call. */
export function worthTriaging(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_CHARS && !trimmed.startsWith('/');
}

export const TRIAGE_SYSTEM = `You decide whether a software task is complex enough to be split for parallel expert subagents, and if so, how.

Answer with JSON and nothing else: {"complex": boolean, "subtasks": [{"role": "explorer" | "reviewer", "subject": "...", "task": "..."}]}

Complex means the task spans several files or areas that can be investigated independently, and reading them all in one context would cost more than splitting it saves. Not complex: questions, single-file changes, commands, explanations, anything one lookup answers.

At most 3 subtasks. Each must stand alone: name the directories or files to read and exactly what to report back. Never split what one reader would read in one pass. When in doubt, not complex.`;

/** The model's answer, parsed strictly; anything unreadable is "not complex". */
export function parseTriage(raw: string): Triage {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { complex: false, subtasks: [] };
  const parsed: unknown = (() => { try { return JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; } })();
  if (!parsed || typeof parsed !== 'object' || (parsed as { complex?: unknown }).complex !== true) {
    return { complex: false, subtasks: [] };
  }
  const list = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(list)) return { complex: false, subtasks: [] };
  const subtasks = list.flatMap(item => {
    const subtask = item as { role?: unknown; subject?: unknown; task?: unknown };
    if (typeof subtask?.subject !== 'string' || !subtask.subject.trim()) return [];
    if (typeof subtask.task !== 'string' || !subtask.task.trim()) return [];
    const role: Role = (['explorer', 'reviewer'] as readonly string[]).includes(String(subtask.role)) ? subtask.role as Role : 'explorer';
    return [{ role, subject: subtask.subject.slice(0, 160), task: subtask.task.slice(0, 4000) }];
  }).slice(0, AUTO_MAX);
  return { complex: subtasks.length > 0, subtasks };
}
