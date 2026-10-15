import { useEffect, useRef } from "react";

/** What a page says it is showing: one note, or a set of notes under a name the member would know it by. */
export type Showing = { kind: "note"; noteId: string } | { kind: "notes"; label: string; noteIds: readonly string[] };

/**
 * Tells the inspector what a page is showing, for as long as the page is drawn and each time it
 * changes, so History, Info and the other panels are about that while the page is in front. Null
 * is a page with nothing to say just now. `tell` is the page's own `app.inspect`.
 */
export function useInspected(app: { inspect: (showing: Showing | null) => void }, showing: Showing | null) {
  const tell = useRef(app.inspect);
  tell.current = app.inspect;
  const said = JSON.stringify(showing);
  useEffect(() => {
    tell.current(JSON.parse(said) as Showing | null);
    return () => tell.current(null);
  }, [said]);
}
