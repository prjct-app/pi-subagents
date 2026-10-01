import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { connectJev } from '../src/jev.ts';
import { ROUTE_MIN, ROUTE_QUESTION, TASK_LEVELS, type TaskLevel } from '../src/route.ts';
import { storageRoot } from '../src/storage.ts';

/**
 * Replays the model router against the delegations that already ran.
 *
 * For each past job it reads what the child was asked to do and what the job
 * used, cost and ended as, then asks Jev the same question the router asks.
 * The output is the evidence behind ROUTE_MIN and the level-to-model mapping:
 * whether Jev's call is right and sure enough on real work to move a job to a
 * cheaper model. It reads state on disk and calls Jev; it never touches a job.
 *
 *   node --import tsx scripts/route-replay.ts [count]   (default 50)
 */

const count = Number(process.argv[2] ?? 50) || 50;

type Past = { id: string; at: string; task: string; model: string; state: string; cost: number };

const text = (message: { content?: unknown }): string => {
  const content = message.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map(part => (part as { text?: string }).text ?? '').join('\n')
    : '';
};

/** One past job, from the child session and its settlement manifest. */
async function pastJob(directory: string, id: string): Promise<Past | undefined> {
  try {
    const entries = await readdir(directory);
    const session = entries.find(name => name.endsWith('.jsonl'));
    if (!session) return undefined;
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as { state?: string };
    const lines = (await readFile(join(directory, session), 'utf8')).split('\n');
    let task = '';
    let model = '?';
    let cost = 0;
    for (const line of lines) {
      let entry: { type?: string; message?: Record<string, unknown> };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const message = entry.message ?? {};
      if (entry.type === 'message' && message.role === 'user' && !task) task = text(message as { content?: unknown }).slice(0, 8000);
      if (entry.type === 'message' && message.role === 'assistant') {
        model = `${String(message.provider ?? '?')}/${String(message.model ?? '?')}`;
        cost += ((message.usage as { cost?: { total?: number } })?.cost?.total ?? 0);
      }
    }
    const { mtimeMs } = await stat(join(directory, session));
    return task ? { id, at: new Date(mtimeMs).toISOString().slice(0, 10), task, model, state: owner.state ?? '?', cost } : undefined;
  } catch {
    return undefined;
  }
}

const sessions = await readdir(storageRoot()).catch(() => [] as string[]);
const found: Past[] = [];
for (const session of sessions.sort().reverse()) {
  const jobs = await readdir(join(storageRoot(), session)).catch(() => [] as string[]);
  for (const id of jobs.filter(name => name.startsWith('j_')).sort().reverse()) {
    const past = await pastJob(join(storageRoot(), session, id), id);
    if (past) found.push(past);
    if (found.length >= count) break;
  }
  if (found.length >= count) break;
}

const jev = await connectJev();
const rows: (Past & { level?: TaskLevel; confidence?: number; routed: boolean })[] = [];
for (const past of found) {
  const answer = jev
    ? await jev({ subject: past.task.slice(0, 400), task: past.task }, ROUTE_QUESTION).then(r => r.level).catch(() => undefined)
    : undefined;
  const level = answer?.type === 'choice' && (TASK_LEVELS as readonly string[]).includes(answer.choice) ? answer.choice as TaskLevel : undefined;
  const confidence = answer?.type === 'choice' && Number.isFinite(answer.confidence) ? answer.confidence : 0;
  rows.push({ ...past, level, confidence, routed: Boolean(level && confidence >= ROUTE_MIN) });
}

console.log(`\n${rows.length} past delegations · ${jev ? 'Jev answered' : 'no judge available'} · line at ${ROUTE_MIN}\n`);
for (const row of rows) {
  console.log(`${row.at}  ${(row.level ?? '—').padEnd(14)} ${(row.confidence ?? 0).toFixed(2).padStart(5)}  ${row.routed ? 'routed ' : 'session'}  ${row.state.padEnd(10)} $${row.cost.toFixed(3).padStart(8)}  ${row.model}  ${row.task.replace(/\s+/g, ' ').slice(0, 72)}`);
}

const ofLevel = (level: TaskLevel) => rows.filter(row => row.level === level);
const total = rows.reduce((sum, row) => sum + row.cost, 0);
console.log(`\nlevels: ${TASK_LEVELS.map(level => `${level} ${ofLevel(level).length}`).join(' · ')} · unsure ${rows.filter(row => !row.level).length}`);
console.log(`confident enough to route: ${rows.filter(row => row.routed).length}/${rows.length}`);
for (const level of TASK_LEVELS) {
  const rowsOf = ofLevel(level);
  console.log(`  ${level.padEnd(14)} ${String(rowsOf.length).padStart(3)} jobs · $${rowsOf.reduce((sum, row) => sum + row.cost, 0).toFixed(3)} of $${total.toFixed(3)}`);
}
