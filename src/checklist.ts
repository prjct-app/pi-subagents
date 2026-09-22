import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { openChecklist, type ChecklistSpec } from '@prjct.app/pi-tui-kit';

export const SPECIFICATION_TOPICS = [
  'Problem and scope',
  'Users and journeys',
  'Functional behavior',
  'Interfaces or API',
  'Data model and lifecycle',
  'External integrations',
  'Security and privacy',
  'Performance and reliability',
  'Technical constraints',
  'Migration, rollout, and rollback',
  'Observability and support',
  'Acceptance scenarios',
  'Edge cases',
] as const;

export const SPECIFICATION_CHECKLIST: ChecklistSpec = {
  title: 'Clarify the specification',
  message: 'Select one or many topics.',
  items: SPECIFICATION_TOPICS.map(label => ({ id: label, label })),
};

/**
 * The kit's docked checklist, never a floating overlay. Its All and Other rows
 * come from the kit; a written Other travels as one more topic. Without a UI
 * nothing is asked.
 */
export async function selectSpecificationTopics(context: ExtensionContext): Promise<string[] | undefined> {
  if (!context.hasUI || typeof context.ui.custom !== 'function') return [];
  const chosen = await openChecklist(context, SPECIFICATION_CHECKLIST);
  return chosen && [...chosen.ids, ...(chosen.other ? [`Other: ${chosen.other}`] : [])];
}
