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

/**
 * At most `limit` graphemes, never splitting one.
 *
 * A UTF-16 slice can cut a surrogate pair or a combining sequence in half and
 * hand the terminal a broken character — which is exactly what a cap on typed
 * text must not do. Intl.Segmenter counts what a person sees; the code-point
 * walk is the fallback where it is missing.
 */
export function clipGraphemes(text: string, limit: number): string {
  if (limit <= 0) return '';
  const out: string[] = [];
  const full = (): boolean => out.length >= limit;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      if (full()) break;
      out.push(segment);
    }
    return out.join('');
  }
  for (const unit of text) {
    if (full()) break;
    out.push(unit);
  }
  return out.join('');
}
