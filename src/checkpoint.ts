/** Native manual compaction aborts a run before it starts the summary. That
 * intermediate agent_settled event must not close a child awaiting its checkpoint. */
export function checkpointProgress() {
  const state = { waiting: false, resume: true };
  return {
    get waiting(): boolean { return state.waiting; },
    observe(event: { type: string; toolName?: string; isError?: boolean; result?: any; reason?: string; aborted?: boolean; error?: string }): string | undefined {
      if (event.type === 'tool_execution_end' && event.toolName === 'context_compact' && !event.isError && event.result?.details?.status === 'requested') {
        state.waiting = true;
        state.resume = event.result.details.resume !== false;
      }
      if (event.type === 'compaction_end' && event.reason === 'manual' && state.waiting) {
        state.waiting = false;
        if (event.error || event.aborted || !event.result) return event.error ?? 'Context checkpoint cancelled; original history retained.';
        if (!state.resume) return 'The agent paused after its context checkpoint without completing its task.';
      }
      return undefined;
    },
  };
}
