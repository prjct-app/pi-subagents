import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Questions } from '@typesafe-ai/sdk';
import { Type, type Static } from 'typebox';
import type { Jev, JevAnswer } from './jev.ts';

/**
 * ask_jev: a judgement about files or text without reading them into context.
 *
 * Code reads the files and sends them to Jev as `content`; the model gets a
 * typed answer with its probability, never the file. It is a tool the model
 * chooses, never a gate: nothing here blocks or rewrites another call.
 */
export const ASK_JEV_TOOL = 'ask_jev';

const MAX_PATHS = 64;
const MAX_FILE_CHARS = 40_000;
const MAX_STATE_CHARS = 160_000;
const PARALLEL = 16;
const OTHER = 'other';

export const AskJevSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2000, description: 'About `content` (the files) or `text`.' }),
  options: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 400 }), { description: 'label: when it applies.' })),
  levels: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { minItems: 2, maxItems: 10, description: 'Low to high.' })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: MAX_PATHS })),
  each: Type.Optional(Type.Boolean({ description: 'One question per path.' })),
  text: Type.Optional(Type.String({ maxLength: 20_000 })),
});
export type AskJevInput = Static<typeof AskJevSchema>;

export const ASK_JEV_DESCRIPTION = 'Ask a fast judge about files or text without reading them: yes/no (default), pick one (options) '
  + 'or a score (levels). `paths` go as `content`; you get the answer and its probability, never the file. Read the file when you need the code; grep for exact lookups.';

type Kind = 'yes_no' | 'choice' | 'score';
export type Skipped = { path: string; reason: string };
type File = { path: string; content: string };

export const kindOf = (input: AskJevInput): Kind =>
  input.options && Object.keys(input.options).length ? 'choice' : input.levels?.length ? 'score' : 'yes_no';

/** One question, keyed `answer`. A pick-one always has an exit, so Jev never forces a wrong label. */
export function questionFor(input: AskJevInput): Questions {
  const kind = kindOf(input);
  if (kind === 'choice') {
    const options = Object.fromEntries(Object.entries(input.options ?? {}).slice(0, 254));
    const criteria = OTHER in options ? options : { ...options, [OTHER]: 'None of the other options fits.' };
    return { answer: { type: 'choice', instructions: input.question, criteria } };
  }
  if (kind === 'score') {
    const [low, high, ...rest] = input.levels ?? [];
    return { answer: { type: 'score', instructions: input.question, criteria: [low!, high!, ...rest] } };
  }
  return { answer: { type: 'noul', instructions: input.question } };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** What the model reads back: the decision and its weight, nothing it has to parse twice. */
export function summarize(answer: JevAnswer | undefined, input: AskJevInput): Record<string, unknown> {
  if (!answer) return { error: 'no answer' };
  if (answer.type === 'noul') return { answer: answer.noul >= 0.5 ? 'yes' : 'no', p_yes: round(answer.noul) };
  if (answer.type === 'choice') {
    const runnersUp = Object.entries(answer.probabilities)
      .filter(([label, p]) => label !== answer.choice && p >= 0.1)
      .sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([label, p]) => ({ label, p: round(p) }));
    return { choice: answer.choice, confidence: round(answer.confidence), ...(runnersUp.length ? { also: runnersUp } : {}) };
  }
  const levels = input.levels ?? [];
  const nearest = levels[Math.min(levels.length - 1, Math.max(0, Math.round(answer.score)))];
  return { score: round(answer.score), of: levels.length - 1, level: nearest, confidence: round(answer.confidence) };
}

/** One-line outcome for the transcript row. */
export function headline(result: Record<string, unknown>): string {
  if (Array.isArray(result.results)) {
    const rows = result.results as Array<Record<string, unknown>>;
    const yes = rows.filter(row => row.answer === 'yes').length;
    return rows.some(row => 'answer' in row) ? `${yes} of ${rows.length} yes` : `${rows.length} answered`;
  }
  if (result.answer) return `${result.answer} ${result.p_yes}`;
  if (result.choice) return `${result.choice} ${result.confidence}`;
  if (result.score !== undefined) return `${result.score} of ${result.of}`;
  return String(result.error ?? '');
}

const secret = (path: string): boolean => /^\.env(\..+)?$/u.test(basename(path)) || /\.(pem|key|p12|pfx)$/u.test(path);

/** Files the code may send. Secrets, binaries and directories stay home, and say why. */
export async function readFiles(paths: readonly string[], cwd: string): Promise<{ files: File[]; skipped: Skipped[] }> {
  const outcomes = await Promise.all(paths.slice(0, MAX_PATHS).map(async (path): Promise<File | Skipped> => {
    if (secret(path)) return { path, reason: 'looks like a secret; not sent' };
    const absolute = resolve(cwd, path);
    try {
      if ((await stat(absolute)).isDirectory()) return { path, reason: 'a directory; pass its files' };
      const raw = await readFile(absolute, 'utf8');
      if (raw.includes('\0')) return { path, reason: 'binary' };
      return { path, content: raw.length > MAX_FILE_CHARS ? `${raw.slice(0, MAX_FILE_CHARS)}\n[truncated]` : raw };
    } catch {
      return { path, reason: 'not readable' };
    }
  }));
  return {
    files: outcomes.filter((outcome): outcome is File => 'content' in outcome),
    skipped: outcomes.filter((outcome): outcome is Skipped => 'reason' in outcome),
  };
}

/** Runs `task` over `items` with at most `limit` in flight, keeping the input order. */
async function pooled<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const batches = Array.from({ length: Math.ceil(items.length / limit) }, (_, index) => items.slice(index * limit, (index + 1) * limit));
  return batches.reduce<Promise<R[]>>(async (done, batch) => [...await done, ...await Promise.all(batch.map(task))], Promise.resolve([]));
}

/**
 * The one call both processes make: resolve the key once, answer, or say why
 * it cannot. The parent and the child register the same tool around this, so
 * a missing key is the same sentence wherever the question is asked.
 */
export async function runAskJev(
  ready: () => Promise<Jev | undefined>,
  input: AskJevInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const jev = await ready();
  if (!jev) throw new Error('No TypeSafe key is set, so Jev cannot answer. Read the files instead.');
  const result = await askJev(jev, input, cwd, signal);
  if ('error' in result && !('results' in result)) throw new Error(String(result.error));
  return result;
}

/** One call over everything, or one call per file when `each` is set. */
export async function askJev(jev: Jev, input: AskJevInput, cwd: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const questions = questionFor(input);
  const { files, skipped } = await readFiles(input.paths ?? [], cwd);
  const extra = skipped.length ? { skipped } : {};
  if (input.paths?.length && files.length === 0 && !input.text) return { error: 'none of the paths could be sent', ...extra };
  if (input.each && files.length > 0) {
    const results = await pooled(files, PARALLEL, async file => {
      try {
        const answers = await jev({ path: file.path, content: file.content, ...(input.text ? { text: input.text } : {}) }, questions, signal);
        return { path: file.path, ...summarize(answers.answer, input) };
      } catch (error) {
        return { path: file.path, error: error instanceof Error ? error.message.slice(0, 200) : 'failed' };
      }
    });
    return { results, ...extra };
  }
  if (files.length === 0 && !input.text) return { error: 'give paths or text to judge' };
  // One state has one budget: later files are cut before the request is.
  const content = Object.fromEntries(files.reduce<{ left: number; entries: Array<[string, string]> }>((acc, file) => {
    const text = file.content.slice(0, Math.max(0, acc.left));
    return { left: acc.left - text.length, entries: [...acc.entries, [file.path, text]] };
  }, { left: MAX_STATE_CHARS, entries: [] }).entries);
  const state = {
    ...(files.length === 1 ? { path: files[0]!.path, content: content[files[0]!.path] } : files.length ? { content } : {}),
    ...(input.text ? { text: input.text } : {}),
  };
  const answers = await jev(state, questions, signal);
  return { ...summarize(answers.answer, input), ...extra };
}
