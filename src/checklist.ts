import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui';

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
  'Other',
] as const;

const fit = (text: string, width: number): string => {
  const clipped = truncateToWidth(text, Math.max(1, width));
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
};

export class MultiSelectChecklist implements Component, Focusable {
  focused = false;
  private readonly state = { index: 0, needsSelection: false };
  private readonly selected = new Set<number>();
  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly done: (value: string[] | undefined) => void) {}
  render(width: number): string[] {
    const height = Math.max(4, Math.min(18, this.tui.terminal?.rows ? this.tui.terminal.rows - 2 : 18));
    const capacity = Math.max(1, height - 3);
    const from = Math.max(0, Math.min(this.state.index - Math.floor(capacity / 2), SPECIFICATION_TOPICS.length - capacity));
    const rows = SPECIFICATION_TOPICS.slice(from, from + capacity).map((label, offset) => {
      const index = from + offset;
      const cursor = index === this.state.index ? this.theme.fg('accent', '›') : ' ';
      const box = this.selected.has(index) ? this.theme.fg('accent', '[x]') : '[ ]';
      return fit(`${cursor} ${box} ${label}`, width);
    });
    return [fit(this.theme.bold('CLARIFY THE SPECIFICATION'), width), fit(this.theme.fg('dim', 'Select one or many topics.'), width), ...rows,
      fit(this.theme.fg(this.state.needsSelection ? 'warning' : 'dim', this.state.needsSelection ? 'Select at least one · Esc cancel' : 'Space toggle · Enter continue · Esc cancel'), width)];
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.done(undefined); return; }
    if (matchesKey(data, Key.enter)) {
      if (this.selected.size === 0) { this.state.needsSelection = true; this.tui.requestRender(); return; }
      this.done([...this.selected].sort((a, b) => a - b).map(index => SPECIFICATION_TOPICS[index])); return;
    }
    if (data === ' ') {
      this.state.needsSelection = false;
      if (this.selected.has(this.state.index)) this.selected.delete(this.state.index); else this.selected.add(this.state.index);
    } else if (matchesKey(data, Key.up) || data === 'k') this.state.index = Math.max(0, this.state.index - 1);
    else if (matchesKey(data, Key.down) || data === 'j') this.state.index = Math.min(SPECIFICATION_TOPICS.length - 1, this.state.index + 1);
    this.tui.requestRender();
  }
  invalidate(): void {}
}

export async function selectSpecificationTopics(context: ExtensionContext): Promise<string[] | undefined> {
  if (!context.hasUI || typeof context.ui.custom !== 'function') return [];
  return context.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => new MultiSelectChecklist(tui, theme, done), {
    overlay: true,
    overlayOptions: { width: 64, maxHeight: 18, margin: 1 },
  });
}
