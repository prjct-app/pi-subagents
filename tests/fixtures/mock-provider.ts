import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

/** Offline, deterministic provider for exercising real Pi sessions and both runners. */
export default function fixtureProvider(pi: ExtensionAPI): void {
  pi.registerProvider('subagents-fixture', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-only', api: 'openai-completions',
    models: [{ id: 'offline', name: 'Offline fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: any = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(), stopReason: 'toolUse' };
      const text = JSON.stringify(context.messages);
      const wait = text.includes('fixture-wait');
      const finish = () => {
        if (wait) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); return; }
        const previous = context.messages.at(-1) as any;
        if (previous?.role === 'toolResult' && previous.toolName === 'subagent_report') {
          message.stopReason = 'stop'; message.content = [{ type: 'text', text: 'Report delivered.' }];
          stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return;
        }
        if (text.includes('fixture-delegate') && previous?.toolName !== 'subagent_delegate') {
          message.content = [{ type: 'toolCall', id: 'fixture-delegate', name: 'subagent_delegate', arguments: { agent: 'explorer', subject: 'Read contracts', task: 'Inspect the contract.' } }];
          stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(); return;
        }
        message.content = [{ type: 'toolCall', id: 'fixture-report', name: 'subagent_report', arguments: {
          outcome: 'completed', summary: 'Offline SDK execution succeeded.', criteria: [{ criterion: 'Uses only authorized tools', met: 'yes', evidence: (context.tools ?? []).map(tool => tool.name).join(', ') }], findings: [], blockers: [],
        } }];
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'toolUse', message }); stream.end();
      };
      if (wait) {
        if (options?.signal?.aborted) finish();
        else options?.signal?.addEventListener('abort', finish, { once: true });
      } else queueMicrotask(finish);
      return stream;
    },
  });
}
