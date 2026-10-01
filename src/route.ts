import type { Jev } from './jev.ts';

/**
 * Which of this session's models a delegated job runs on, when the caller
 * names none.
 *
 * A child starts with clean context, so choosing its model costs nothing —
 * unlike the main session, where a model switch mid-session breaks the prompt
 * cache and costs more than it saves. Jev reads the task and rates what it
 * needs; the level picks from the models this session has, cheapest first.
 * Nothing here names a model, and every way this can fail lands on the
 * session's own model: no key, a slow answer, an unknown level, or low
 * confidence.
 *
 * Pure, like auto.ts: the judge call is injected, so a test never needs one.
 * The caller logs every decision beside the job's outcome, so the thresholds
 * are tuned from what happens instead of a separate experiment.
 */

/** The work delegated, from the cheapest model that can do it to the strongest. */
export const TASK_LEVELS = ['reading', 'implementation', 'reasoning'] as const;
export type TaskLevel = (typeof TASK_LEVELS)[number];

export const ROUTE_QUESTION = {
  level: {
    type: 'choice' as const,
    instructions: 'What level of model does the delegated `task` need? Judge the task itself: the child is told what to do and reads only what the task names.',
    criteria: {
      reading: 'Reading and mapping: find, list, summarize, compare, or report what is already there. One reader with plain tool use answers it.',
      implementation: 'Bounded implementation: change this, in these files, to meet that. The scope and what acceptance means are in the task; no design question is open.',
      reasoning: 'Hard design or reasoning: the cause is unknown, the approach is a trade-off, or the task crosses areas it does not name. A wrong call costs more than the cheaper model saved.',
    },
  },
};

/** Below this, the session's own model: the same line the auto-triage draws. */
export const ROUTE_MIN = 0.6;

export type RouteChoice = { provider: string; modelId: string };

export type Routing = {
  /** Absent when nothing was routed: no judge, no answer worth trusting, no choice. */
  level?: TaskLevel;
  confidence?: number;
  /** The model to resolve for; absent means this session's own. */
  wanted?: string;
  basis: 'routed' | 'session';
};

/** Cheapest for reading, strongest for reasoning, the middle for the rest. */
export function modelFor(level: TaskLevel, choices: readonly RouteChoice[]): string | undefined {
  if (choices.length === 0) return undefined;
  const index = level === 'reading'
    ? 0
    : level === 'reasoning'
      ? choices.length - 1
      : Math.ceil((choices.length - 1) / 2);
  return choices[index]?.modelId;
}

const session = (): Routing => ({ basis: 'session' });

/** One delegation's model. Anything unanswerable is a decision to use the session's own. */
export async function routeFor(
  task: { subject: string; task: string },
  choices: readonly RouteChoice[],
  jev: Jev | undefined,
): Promise<Routing> {
  if (!jev || choices.length === 0) return session();
  try {
    const answer = (await jev({ subject: task.subject.slice(0, 400), task: task.task.slice(0, 8000) }, ROUTE_QUESTION)).level;
    const level = answer?.type === 'choice' && (TASK_LEVELS as readonly string[]).includes(answer.choice)
      ? answer.choice as TaskLevel
      : undefined;
    const confidence = answer?.type === 'choice' && Number.isFinite(answer.confidence) ? answer.confidence : 0;
    if (!level || confidence < ROUTE_MIN) return session();
    const wanted = modelFor(level, choices);
    return wanted ? { level, confidence, wanted, basis: 'routed' } : session();
  } catch {
    return session();
  }
}
