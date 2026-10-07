import { plain } from './text.ts';
import { contentText } from '@earendil-works/pi-ai';

export type Activity = { id: string; at: number; kind: 'state' | 'message' | 'tool' | 'question' | 'usage'; text: string; detail?: string; toolCallId?: string; messageId?: string; status?: 'running' | 'done' | 'error' };
export type ActivityInput = Omit<Activity, 'id' | 'at'>;

/** Common projection of native SDK and RPC session events. No reasoning content is copied. */
const excerpt = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}\n[Long entry abbreviated; open retained history for more.]` : text;

export function activityOf(event: Record<string, any>): ActivityInput | undefined {
  if (event.type === 'tool_execution_start') return { kind: 'tool', text: plain(event.toolName), detail: excerpt(plain(JSON.stringify(event.args ?? {})), 8000), toolCallId: String(event.toolCallId), status: 'running' };
  if (event.type === 'tool_execution_end') return { kind: 'tool', text: plain(event.toolName), detail: excerpt(plain(JSON.stringify(event.result ?? {})), 8000), toolCallId: String(event.toolCallId), status: event.isError ? 'error' : 'done' };
  const message = event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta' ? event.assistantMessageEvent.partial : event.type === 'message_end' ? event.message : undefined;
  if (message?.role === 'assistant') {
    const text = contentText(message.content ?? []);
    if (text) return { kind: 'message', text: excerpt(plain(text), 16000), ...(message.timestamp !== undefined ? { messageId: String(message.timestamp) } : {}) };
  }
  return undefined;
}

export function activityStore(notify: () => void) {
  const data = new Map<string, { entries: Activity[]; bytes: number }>();
  const sequence = { value: 0 };
  const size = (entry: Activity): number => Buffer.byteLength(entry.text) + Buffer.byteLength(entry.detail ?? '');
  return {
    add(jobId: string, input: ActivityInput) {
      const state = data.get(jobId) ?? { entries: [], bytes: 0 };
      const { entries } = state;
      const existing = input.toolCallId ? entries.findIndex(entry => entry.toolCallId === input.toolCallId) : input.messageId ? entries.findIndex(entry => entry.messageId === input.messageId) : -1;
      const record = { ...input, text: plain(input.text), id: `${jobId}:${++sequence.value}`, at: Date.now() };
      if (existing >= 0) {
        state.bytes -= size(entries[existing]);
        entries[existing] = { ...entries[existing], ...record, id: entries[existing].id };
        state.bytes += size(entries[existing]);
      } else { entries.push(record); state.bytes += size(record); }
      // This bounds the UI projection only. The SDK retains the full transcript.
      while (entries.length > 300 || (state.bytes > 256 * 1024 && entries.length > 1)) {
        state.bytes -= size(entries.shift()!);
      }
      data.set(jobId, state);
      notify();
    },
    get: (jobId: string): Activity[] => [...(data.get(jobId)?.entries ?? [])],
    clear: () => data.clear(),
    forget: (jobIds: readonly string[]) => { for (const jobId of jobIds) data.delete(jobId); notify(); },
  };
}
