import { useEffect, useRef, useState } from "react";
import { reasonOf } from "./FoundNote.tsx";

/** One page as a list that pages answers it: some rows, and where the next page starts, or null on the last. */
interface Answer<R> {
  rows: readonly R[];
  next: string | null;
}

interface Read<R> {
  /** Which list this is: another list starts again from its first page. */
  of: string;
  rows: readonly R[];
  next: string | null;
}

/**
 * A list as a page draws it: the rows read so far, or null before the first page, which stay on show
 * while another list is read in their place; why it couldn't be read; and Show more's state.
 */
export interface Paged<R> {
  rows: readonly R[] | null;
  problem: string | null;
  /** Reads the page after, or null on the last page. */
  more: (() => void) | null;
  reading: boolean;
  /** Why the page after couldn't be read, until it is. */
  moreProblem: string | null;
}

/**
 * Reads a list that pages, its first page first, and the page after each time `more` is called. A
 * new `of` is another list, read from the start. A new `again` reads the same list again, as far as it
 * had been read, up to `most` rows, so what Show more brought stays on the page. A row a change moved
 * between two pages is listed once, where it was first read.
 */
export function usePaged<R>(ask: (page: { limit: number; after?: string }) => Promise<Answer<R>>, keyOf: (row: R) => string, { of, again, page, most }: { of: string; again: unknown; page: number; most: number }): Paged<R> {
  const [read, setRead] = useState<Read<R> | null>(null);
  const [problem, setProblem] = useState<{ of: string; message: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  const had = useRef(read);
  had.current = read;
  const asking = useRef(ask);
  asking.current = ask;

  useEffect(() => {
    let live = true;
    const was = had.current;
    const limit = was?.of === of ? Math.min(most, Math.max(page, was.rows.length)) : page;
    asking.current({ limit }).then(
      (answer) => {
        if (!live) return;
        setRead({ of, rows: answer.rows, next: answer.next });
        setProblem(null);
        setMoreProblem(null);
      },
      (err: unknown) => live && setProblem({ of, message: reasonOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [of, again, page, most]);

  const shown = read?.of === of ? read : null;
  const more =
    shown?.next == null || reading
      ? null
      : () => {
          const from = shown;
          setReading(true);
          asking.current({ limit: page, after: from.next! }).then(
            (answer) => {
              setReading(false);
              setMoreProblem(null);
              const had = new Set(from.rows.map(keyOf));
              setRead((now) => (now === from ? { of, rows: [...from.rows, ...answer.rows.filter((row) => !had.has(keyOf(row)))], next: answer.next } : now));
            },
            (err: unknown) => {
              setReading(false);
              setMoreProblem(reasonOf(err));
            },
          );
        };
  return { rows: read?.rows ?? null, problem: problem?.of === of ? problem.message : null, more, reading, moreProblem };
}

/** The button under a list that reads its next page, and why that couldn't be read. */
export function ShowMore({ paged, label = "Show more" }: { paged: Paged<unknown>; label?: string }) {
  if (!paged.more && !paged.reading) return null;
  return (
    <div className="search-more">
      <button type="button" className="found-more" disabled={paged.reading} onClick={() => paged.more?.()}>
        {paged.reading ? "Reading more…" : label}
      </button>
      {paged.moreProblem && <span role="alert">{paged.moreProblem}</span>}
    </div>
  );
}
