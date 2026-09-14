/**
 * Text from another process, made safe for a terminal.
 *
 * A report is something a model in a child process wrote, and a renderer must
 * never be the thing that puts control codes on someone's screen — or the
 * thing that throws. Vendored from pi-team's check-in.ts so this package owes
 * that package nothing.
 */
export function plain(text: unknown): string {
  return String(text ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
