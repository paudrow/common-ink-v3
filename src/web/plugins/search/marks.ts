export interface Piece {
  text: string;
  marked: boolean;
}

/**
 * A matched line cut into the runs that are marked and the runs between them, in order, which
 * together say exactly what the line says. Marks that overlap or touch are one run, and one that
 * reaches outside the line is cut to it. The pieces are drawn as text, so nothing in a line is ever read as markup.
 */
export function pieces(text: string, marks: readonly (readonly [from: number, to: number])[]): Piece[] {
  const cut: Piece[] = [];
  let at = 0;
  const within = (n: number) => Math.min(Math.max(n, at), text.length);
  for (const [from, to] of marks.toSorted((a, b) => a[0] - b[0])) {
    const [start, end] = [within(from), within(to)];
    if (end <= start) continue;
    if (start > at) cut.push({ text: text.slice(at, start), marked: false });
    const last = cut.at(-1);
    if (last?.marked) last.text += text.slice(start, end);
    else cut.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) cut.push({ text: text.slice(at), marked: false });
  return cut;
}
