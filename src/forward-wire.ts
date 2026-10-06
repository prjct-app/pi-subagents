import { read, type WireMessage } from './wire.ts';

/** Deliver every addressed message, in order, for the lifetime of the child. */
export function wireForwarder(
  root: string, tree: string, alias: string,
  deliver: (message: WireMessage) => Promise<boolean>, done: () => boolean,
): () => Promise<void> {
  const state = { offset: 0, busy: false, accepted: new Set<string>() };
  return async () => {
    if (state.busy || done()) return;
    state.busy = true;
    try {
      const batch = await read(root, tree, state.offset, alias);
      for (const message of batch.messages) {
        if (done()) return;
        if (message.from === alias || state.accepted.has(message.id)) continue;
        // Keep the cursor on a rejected batch and retry only unaccepted mail.
        // A slow poll cannot overlap another poll and duplicate delivery.
        if (!await deliver(message)) return;
        state.accepted.add(message.id);
      }
      state.offset = batch.offset;
      state.accepted.clear();
    } catch { /* Mail stays on disk; the next poll retries it. */ }
    finally { state.busy = false; }
  };
}
