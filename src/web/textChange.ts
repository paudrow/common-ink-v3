/** The one change that turns `from` into `to`: what lies between the start they share and the end they share. Null when they are the same. */
export function changeBetween(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const most = Math.min(from.length, to.length);
  let start = 0;
  while (start < most && from[start] === to[start]) start++;
  let end = 0;
  while (end < most - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  // A character made of two halves is changed whole, never cut between them.
  const low = (text: string, at: number) => /[\uDC00-\uDFFF]/.test(text[at] ?? "");
  if (start > 0 && (low(from, start) || low(to, start))) start--;
  if (end > 0 && (low(from, from.length - end) || low(to, to.length - end))) end--;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}
