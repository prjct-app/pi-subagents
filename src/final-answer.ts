import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Report } from './schema.ts';

/** Only a successful final message can replace the optional report tool. */
export const finalAnswer = (message: AssistantMessage | undefined): Report | undefined => {
  if (message?.stopReason !== 'stop' || message.content.some(part => part.type === 'toolCall')) return undefined;
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!text.trim()) return undefined;
  return { outcome: 'unassessed', summary: text, criteria: [], findings: [], blockers: [] };
};

export const missingAnswer = (message: AssistantMessage | undefined): string =>
  message?.stopReason === 'error' || message?.stopReason === 'aborted' || message?.stopReason === 'length'
    ? `The child ended with ${message.stopReason}.${message.errorMessage ? ` ${message.errorMessage}` : ''}`
    : 'The child ended without a final answer or an accepted report.';
