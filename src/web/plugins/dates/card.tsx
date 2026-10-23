import { useEffect, useState } from "react";
import { today, type PluginHost } from "../../plugin-api.ts";
import { hoverCards, type HoverCards } from "../lib/hoverCard.tsx";
import { changeDate, type DrawnDates, type OpenDay } from "./drawing.ts";
import { picking } from "./picking.tsx";
import { fullWords, howFar } from "./when.ts";

/**
 * The card a date drawn in a note shows while it is pointed at: the whole date and how far it is from
 * today, with Change date, which opens the picker a click opens, and Open daily note, which reads
 * Create daily note for a day that has none yet. A note that can only be read has no Change date,
 * and a page with nowhere to go, as a share link's, no daily note.
 */
export const dateCards = (host: PluginHost, open: () => OpenDay, drawn: DrawnDates): HoverCards =>
  // None while a date's picker is open, which the card would cover.
  hoverCards("date", (_day, close, anchor) => (drawn.has(anchor) && !picking() ? <DateCard host={host} anchor={anchor} drawn={drawn} open={open()} onClose={close} /> : null));

function DateCard({ host, anchor, drawn, open, onClose }: { host: PluginHost; anchor: HTMLElement; drawn: DrawnDates; open: OpenDay; onClose: () => void }) {
  const { date, source } = drawn.get(anchor)!;
  const far = howFar(date.day, today());
  // Undefined until the server says whether the day has a daily note.
  const [hasNote, setHasNote] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    host.perform({ type: "daily.find", on: date.day }).then(
      ({ note }) => live && setHasNote(!!note),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [host, open, date.day]);
  return (
    <>
      <p className="hover-card-date">
        {fullWords(date)} · {far.charAt(0).toLocaleLowerCase() + far.slice(1)}
      </p>
      {(!source.readOnly || open) && (
        <div className="hover-card-actions">
          {!source.readOnly && (
            <button
              type="button"
              onClick={() => {
                onClose();
                changeDate(anchor, drawn, open);
              }}
            >
              Change date
            </button>
          )}
          {open && (
            <button
              type="button"
              onClick={() => {
                onClose();
                open(date.day, hasNote === false);
              }}
            >
              {hasNote === false ? "Create daily note" : "Open daily note"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
