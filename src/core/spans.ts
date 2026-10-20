// Parts of a line that hold no tokens, found in one pass however the line is written. A pattern with a
// lazy or unbounded middle tries again from every opening it meets, so a line of 40,000 backticks or
// `](` took seconds; these each look at a character a bounded number of times.

/** Where a part of a line starts and where it stops, `to` not included. */
export type Range = readonly [from: number, to: number];

/**
 * The inline code on a line: a run of backticks opens it and the next run of exactly as many closes it,
 * as CommonMark reads it. A run that nothing closes is only backticks, and the code may be empty of
 * all but spaces. Each run is looked at once to find it and once to close it.
 */
export function codeSpans(line: string): Range[] {
  if (!line.includes("`")) return [];
  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    const from = i;
    while (line[i] === "`") i++;
    runs.push({ from, to: i });
  }
  // For each length, where its runs are in `runs` and how far along them a search has come. A search only goes forward.
  const byLength = new Map<number, { at: number[]; next: number }>();
  runs.forEach((run, i) => {
    const length = run.to - run.from;
    const same = byLength.get(length) ?? { at: [], next: 0 };
    same.at.push(i);
    byLength.set(length, same);
  });
  const spans: Range[] = [];
  for (let i = 0; i < runs.length; ) {
    const run = runs[i]!;
    const same = byLength.get(run.to - run.from)!;
    while (same.next < same.at.length && same.at[same.next]! <= i) same.next++;
    if (same.next === same.at.length) {
      i++;
      continue;
    }
    const close = same.at[same.next]!;
    spans.push([run.from, runs[close]!.to]);
    i = close + 1;
  }
  return spans;
}

/**
 * A link's address on a line: from a `](` to the `)` that ends it, with no newline between. When no
 * `)` follows one, none follows any later `](` before the same point either, so the search goes on from there.
 */
export function addressSpans(line: string): Range[] {
  const spans: Range[] = [];
  for (let at = line.indexOf("]("); at >= 0; ) {
    let end = at + 2;
    while (end < line.length && line[end] !== ")" && line[end] !== "\n") end++;
    if (line[end] === ")") spans.push([at, end + 1]);
    at = line.indexOf("](", end);
  }
  return spans;
}

/** `line` with each of `spans` replaced by `fill` repeated over its length, so everything else stays where it was. */
export function blanked(line: string, spans: readonly Range[], fill: string): string {
  if (!spans.length) return line;
  let out = "";
  let at = 0;
  for (const [from, to] of spans) {
    if (from < at) continue;
    out += line.slice(at, from) + fill.repeat(to - from);
    at = to;
  }
  return out + line.slice(at);
}
