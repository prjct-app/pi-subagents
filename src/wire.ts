import { appendFile, mkdir, readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { plain } from './text.ts';

/**
 * The wire: how siblings in one delegation tree reach each other.
 *
 * An append-only JSONL file per tree, small on purpose. There are no members,
 * no claims and no leases — a job is a process with a name, alive for minutes,
 * and the file is the whole record. Appends are serialised by a lock
 * directory, which is atomic on every filesystem this runs on, and readers
 * track byte offsets, which are stable because nothing is ever rewritten.
 *
 * It is not the team mailbox: nothing here needs pi-team, a team, or an
 * alias anyone chose. The tree id names the file, and the job names speak.
 */
export type WireMessage = {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  at: number;
};

/** How long a writer waits for a wedged lock before saying so. */
const LOCK_MS = 5_000;
/** A message past this is not posted: the wire is for coordination, not files. */
const MAX_MESSAGE_BYTES = 16 * 1024;

export const wireFile = (root: string, tree: string): string => join(root, `agent-${tree}.wire.jsonl`);

/** Serialise one file operation behind the lock directory beside the file. */
async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_MS;
  while (true) {
    const acquired = await mkdir(lock, { recursive: false }).then(() => true, () => false);
    if (acquired) break;
    if (Date.now() > deadline) throw new Error('The wire is wedged: its lock outlived five seconds.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try { return await work(); } finally { await rmdir(lock).catch(() => undefined); }
}

/** Post one message. Returns false instead of throwing on an oversized body. */
export async function post(root: string, tree: string, message: WireMessage): Promise<boolean> {
  await mkdir(root, { recursive: true });
  const line = JSON.stringify({
    ...message,
    from: plain(message.from), to: plain(message.to),
    subject: plain(message.subject), body: plain(message.body),
  });
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return false;
  const file = wireFile(root, tree);
  await locked(file, () => appendFile(file, `${line}\n`, 'utf8'));
  return true;
}

export type WireRead = { messages: WireMessage[]; offset: number };

/**
 * Everything addressed to an alias (or to everyone) past a byte offset.
 *
 * A torn tail line — a writer crashed mid-append — is left for the next read:
 * the offset only advances past complete frames.
 */
export async function read(root: string, tree: string, offset: number, alias: string): Promise<WireRead> {
  const raw = await readFile(wireFile(root, tree), 'utf8').catch(() => '');
  if (!raw) return { messages: [], offset: 0 };
  const rest = Buffer.from(raw, 'utf8').subarray(offset).toString('utf8');
  const lines = rest.split('\n');
  const complete = rest.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1);
  const consumed = complete.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  const messages = complete.flatMap(line => {
    if (!line.trim()) return [];
    const value = ((): unknown => { try { return JSON.parse(line); } catch { return undefined; } })();
    const message = value as WireMessage | undefined;
    if (!message || typeof message.id !== 'string') return [];
    return message.to === alias || message.to === '*' ? [message] : [];
  });
  return { messages, offset: offset + consumed };
}

/** The last few messages for an alias, for a child asking what it missed. */
export async function recent(root: string, tree: string, alias: string, limit = 20): Promise<WireMessage[]> {
  const raw = await readFile(wireFile(root, tree), 'utf8').catch(() => '');
  const messages = raw.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    const value = ((): unknown => { try { return JSON.parse(line); } catch { return undefined; } })();
    const message = value as WireMessage | undefined;
    return message && typeof message.id === 'string' && (message.to === alias || message.to === '*') ? [message] : [];
  });
  return messages.slice(-limit);
}
