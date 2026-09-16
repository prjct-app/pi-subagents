import { plain } from './text.ts';

export type Activity = { id: string; at: number; kind: 'state' | 'message' | 'tool' | 'question' | 'usage'; text: string; detail?: string; toolCallId?: string; messageId?: string; status?: 'running' | 'done' | 'error' };
export type ActivityInput = Omit<Activity, 'id' | 'at'>;

/** Common projection of native SDK and RPC session events. No reasoning content is copied. */
const excerpt = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}\n[Long entry abbreviated; open retained history for more.]` : text;

export function activityOf(event: Record<string, any>): ActivityInput | undefined {
  if (event.type === 'tool_execution_start') return { kind: 'tool', text: plain(event.toolName), detail: excerpt(plain(JSON.stringify(event.args ?? {})), 8000), toolCallId: String(event.toolCallId), status: 'running' };
  if (event.type === 'tool_execution_end') return { kind: 'tool', text: plain(event.toolName), detail: excerpt(plain(JSON.stringify(event.result ?? {})), 8000), toolCallId: String(event.toolCallId), status: event.isError ? 'error' : 'done' };
  const message = event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta' ? event.assistantMessageEvent.partial : event.type === 'message_end' ? event.message : undefined;
  if (message?.role === 'assistant') {
    const text = (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    if (text) return { kind: 'message', text: excerpt(plain(text), 16000), ...(message.timestamp !== undefined ? { messageId: String(message.timestamp) } : {}) };
  }
  return undefined;
}

export function activityStore(notify: () => void) {
  const data = new Map<string, Activity[]>();
  const sequence = { value: 0 };
  return {
    add(jobId: string, input: ActivityInput) {
      const entries = data.get(jobId) ?? [];
      const existing = input.toolCallId ? entries.findIndex(entry => entry.toolCallId === input.toolCallId) : input.messageId ? entries.findIndex(entry => entry.messageId === input.messageId) : -1;
      const record = { ...input, text: plain(input.text), id: `${jobId}:${++sequence.value}`, at: Date.now() };
      if (existing >= 0) entries[existing] = { ...entries[existing], ...record, id: entries[existing].id };
      else entries.push(record);
      const bounded = entries.slice(-300);
      const bytes = { value: bounded.reduce((sum, entry) => sum + Buffer.byteLength(entry.text) + Buffer.byteLength(entry.detail ?? ''), 0) };
      while (bytes.value > 256 * 1024 && bounded.length > 1) {
        const removed = bounded.shift()!; bytes.value -= Buffer.byteLength(removed.text) + Buffer.byteLength(removed.detail ?? '');
      }
      data.set(jobId, bounded);
      notify();
    },
    get: (jobId: string): Activity[] => [...(data.get(jobId) ?? [])],
    clear: () => data.clear(),
  };
}
