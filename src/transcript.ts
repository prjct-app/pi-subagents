import { open, stat } from 'node:fs/promises';
import { plain } from './text.ts';

/**
 * What a takeover watches: the child's own session file, read as a tail.
 *
 * A child is a real pi session, and its file is the one honest record of what
 * it is doing — the same file `/resume` would open. The takeover never parses
 * more than the last slice: a repainted view must never become a full read of
 * a file that only grows.
 */
export type TranscriptEntry = { who: 'task' | 'agent' | 'tool'; text: string };

/** How much of the file's tail a repaint reads, in bytes. */
const TAIL_BYTES = 64 * 1024;
/** A rendered view is capped, so a long session never floods the panel. */
const MAX_LINES = 200;
const EXCERPT = 240;

export async function readTranscript(file: string): Promise<TranscriptEntry[]> {
  const size = await stat(file).then(info => info.size, () => 0);
  if (size === 0) return [];
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return [];
  try {
    const from = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    // A short read (the file moved under us) renders what arrived, not zeros.
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // The first line of a tail read may be torn mid-frame.
    const whole = from > 0 ? lines.slice(1) : lines;
    return whole.flatMap(line => {
      if (!line.trim()) return [];
      const value = ((): unknown => { try { return JSON.parse(line); } catch { return undefined; } })();
      const entry = value as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
      if (entry?.type !== 'message' || !entry.message) return [];
      return entriesOf(entry.message);
    }).slice(-MAX_LINES);
  } finally {
    await handle.close();
  }
}

function entriesOf(message: { role?: string; content?: unknown }): TranscriptEntry[] {
  const who = message.role === 'user' ? 'task'
    : message.role === 'assistant' ? 'agent'
    : message.role === 'toolResult' ? 'tool'
    : undefined;
  if (!who) return [];
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap(part => {
    const block = part as { type?: string; text?: string; name?: string };
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return [{ who, text: plain(block.text).replace(/\s+/g, ' ').trim().slice(0, EXCERPT) }];
    }
    if (block?.type === 'toolCall' && typeof block.name === 'string') {
      return [{ who: 'agent' as const, text: `→ ${block.name}` }];
    }
    return [];
  });
}

export type TranscriptPage = { entries: TranscriptEntry[]; before: number; size: number; next: number; hasMore: boolean };
/** Bounded reverse pages retain readable paragraphs, rather than irreversible 240-character excerpts. */
export async function readTranscriptPage(file: string, before?: number, after?: number): Promise<TranscriptPage> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const end = Math.min(before ?? size, size);
    const start = after === undefined ? Math.max(0, end - 256 * 1024) : Math.max(0, Math.min(after, end));
    const buffer = Buffer.alloc(Math.min(256 * 1024, end - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const first = start > 0 && after === undefined ? buffer.indexOf(10) + 1 : 0;
    const last = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
    const oversized = bytesRead === 256 * 1024 && last === 0;
    const next = oversized ? start + bytesRead : start + last;
    const usable = start > 0 && first === 0 && after === undefined ? Buffer.alloc(0) : buffer.subarray(first, last);
    const entries = usable.toString('utf8').split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message') return [];
        const message = entry.message;
        const who: TranscriptEntry['who'] | undefined = message.role === 'user' ? 'task' : message.role === 'assistant' ? 'agent' : message.role === 'toolResult' ? 'tool' : undefined;
        if (!who || !Array.isArray(message.content)) return [];
        return message.content.flatMap((part: any) => {
          if (part.type === 'toolCall') return [{ who: 'tool' as const, text: `${plain(part.name)}\n${plain(JSON.stringify(part.arguments ?? {}))}` }];
          if (part.type !== 'text') return [];
          const text = plain(part.text);
          return [{ who, text: text.length > 16000 ? `${text.slice(0, 16000)}\n[Long entry abbreviated; full text remains in the session file.]` : text }];
        });
      } catch { return []; }
    });
    if (oversized) entries.unshift({ who: 'tool', text: '[Oversized session frame skipped; inspect the session file for the full entry.]' });
    return { entries, before: start + first, size, next, hasMore: start > 0 };
  } finally { await handle.close(); }
}
