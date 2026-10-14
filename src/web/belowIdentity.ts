/** One thing kept below a line: which it is, where the note writes it, which embed it is, and what the note says of it. */
export interface Kept {
  id: number;
  from: number;
  name: string;
  source: string;
}

/**
 * Which of the things kept before each of the ones found now is, as its id, or a new id for one that
 * is new. One is the same as before when the note says the same of it and it is where the change
 * moved it to. What is left is matched in order by what the note says alone, which is how a change
 * that replaced the whole text, such as a revert, keeps what it didn't alter. Last, an embed that is
 * where one of the same name was is that one with something else said of it, to be drawn again in
 * the place it has. So a change anywhere else in the note never gives a new id or another source.
 */
export function keep(before: readonly Kept[], found: readonly Omit<Kept, "id">[], moved: (pos: number) => number, fresh: () => number): number[] {
  const unclaimed = new Set(before);
  const ids: (number | undefined)[] = found.map(() => undefined);
  const pass = (match: (kept: Kept, one: Omit<Kept, "id">) => boolean) =>
    found.forEach((one, index) => {
      if (ids[index] !== undefined) return;
      for (const kept of unclaimed) {
        if (kept.name !== one.name || !match(kept, one)) continue;
        unclaimed.delete(kept);
        ids[index] = kept.id;
        return;
      }
    });
  pass((kept, one) => kept.source === one.source && moved(kept.from) === one.from);
  pass((kept, one) => kept.source === one.source);
  pass((kept, one) => moved(kept.from) === one.from);
  return ids.map((id) => id ?? fresh());
}
