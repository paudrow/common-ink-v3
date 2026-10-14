import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { CalendarEvent } from "../../plugin-api.ts";
import { dayIn, dayLabel, instantAt, minutesIn, timeLabel, weekdayLabel, type Day } from "./dates.ts";
import { IDLE, dragSpan, drafting, released, type Draft, type Held, type Outcome } from "./drafting.ts";
import { HOUR_PX, bars, inAllDayRow, layoutDay, openingMinutes, piecesOf, type Placed } from "./layout.ts";
import { dayAt, keyOf } from "./listing.ts";
import { position, sideways, still, windowStart, type Sideways } from "./sideways.ts";

/** Days drawn beyond those in view on each side, so a slide never shows a day being drawn. */
export const SPARE = { 7: 14, 1: 7 } as const;
/** The all-day row's height for each row of bars. */
const BAR_PX = 22;
/** The narrowest a day is drawn: a window too narrow for a week at this width shows as many days as fit, and slides to the rest. */
export const MIN_COLUMN = 76;
/** One line of text in a card. */
const LINE_PX = 16;

const plain = (text: string) => text.replace(/[  ]/g, " ");

/** "10:00 – 11:30 AM", as the member's locale says a span on one day. */
function rangeLabel(from: number, to: number, timeZone: string): string {
  const format = new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" });
  return plain(from === to ? format.format(from) : format.formatRange(from, to));
}

/** "11:00", a time of day without its AM or PM, for a card too narrow for more. */
function compactLabel(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" }).formatToParts(time);
  return plain(parts.filter((part) => part.type === "hour" || part.type === "minute" || (part.type === "literal" && part.value.trim())).map((part) => part.value).join(""));
}

/** What a piece of an event says of its time: its span, its start, and its start in short, or, where it goes on from an earlier day, when it ends. */
function timesOf(piece: Placed<CalendarEvent>, timeZone: string): { range: string; start: string; compact: string } {
  const { when } = piece.item;
  if (when.allDay) return { range: "", start: "", compact: "" };
  if (piece.before) {
    const until = piece.after ? "All day" : `Until ${timeLabel(when.to, timeZone)}`;
    return { range: until, start: until, compact: piece.after ? "All day" : `–${compactLabel(when.to, timeZone)}` };
  }
  return { range: rangeLabel(when.from, when.to, timeZone), start: timeLabel(when.from, timeZone), compact: compactLabel(when.from, timeZone) };
}

const hourLabel = (hour: number) => plain(new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, hour)));

/** Where a button or key asked the days to go: to a day, or a number of days on from where they are going. */
export type Goal = ({ to: number } | { by: number }) & { seq: number };

interface Props {
  /** How many days are in view when they fit: 7 for Week, 1 for Day. */
  most: 7 | 1;
  /** Told how many days are in view, once the grid knows how wide it is. */
  onFit: (days: number) => void;
  /** The first day in view when the grid opens, counted from EPOCH. */
  opensAt: number;
  /** Where the buttons and keys last asked the days to glide to. */
  goal: Goal | null;
  /** Told the first day in view whenever it changes, and the first day of the window drawn. */
  onFirst: (first: number) => void;
  onWindow: (start: number) => void;
  events: readonly CalendarEvent[];
  listed: (index: number) => boolean;
  timeZone: string;
  now: number;
  /** Whether there is a calendar the member may add to, without which nothing is drawn over empty grid. */
  canAdd: boolean;
  title: string;
  busy: boolean;
  onOpen: (event: CalendarEvent) => void;
  onAdd: (day: Day, start: number, end: number) => void;
  onMove: (event: CalendarEvent, when: { from: number; to: number }, verb: "Moved" | "Resized") => void;
  onRefused: (event: CalendarEvent) => void;
}

/**
 * The Week and Day grids: hours down the side, the days across, and the days sliding sideways under
 * a sideways scroll while the hours, the day names and the all-day row stay where they are. The days
 * drawn are a window around those in view, `SPARE` either side; where the days are is applied to the
 * page each frame and never goes through React, which draws again only when the window moves.
 */
export function TimeGrid({ most, onFit, opensAt, goal, onFirst, onWindow, events, listed, timeZone, now, canAdd, title, busy, onOpen, onAdd, onMove, onRefused }: Props) {
  const spare = SPARE[most];
  const [days, setDays] = useState<number>(most);
  const daysRef = useRef(days);
  daysRef.current = days;
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const strips = useRef<(HTMLDivElement | null)[]>([]);
  const state = useRef<Sideways>(still(opensAt));
  const frame = useRef(0);
  const [start, setStart] = useState(opensAt - spare);
  const [first, setFirst] = useState(opensAt);
  const [column, setColumn] = useState(0);
  const [scrollbar, setScrollbar] = useState(0);
  const [draft, dispatch] = useReducer(drafting, IDLE);
  const draftRef = useRef<Draft>(IDLE);
  draftRef.current = draft;
  const pointerHandled = useRef(false);
  const startRef = useRef(start);
  startRef.current = start;
  const columnRef = useRef(column);
  columnRef.current = column;

  const place = useCallback(() => {
    const offset = -(state.current.x - startRef.current) * columnRef.current;
    for (const strip of strips.current) if (strip) strip.style.transform = `translateX(${offset}px)`;
  }, []);

  const follow = useCallback(() => {
    const { x } = state.current;
    // The days stay placed against the window React last drew until it draws the next one, which places them again.
    const nextStart = windowStart(startRef.current, x, spare);
    if (nextStart !== startRef.current) setStart(nextStart);
    setFirst(Math.round(x));
    place();
  }, [place, spare]);

  const animate = useCallback(() => {
    if (frame.current) return;
    const step = (at: number) => {
      state.current = sideways(state.current, { type: "frame", at });
      follow();
      frame.current = state.current.motion.kind === "still" ? 0 : requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [follow]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => onFirst(first), [first, onFirst]);
  useEffect(() => onWindow(start), [start, onWindow]);
  useLayoutEffect(place, [place, start, column]);

  useLayoutEffect(() => {
    const el = clip.current;
    const sc = scroller.current;
    if (!el || !sc) return;
    const measure = () => {
      const fit = Math.max(1, Math.min(most, Math.floor(el.clientWidth / MIN_COLUMN)));
      setDays(fit);
      onFit(fit);
      setColumn(el.clientWidth / fit);
      setScrollbar(sc.offsetWidth - sc.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [most, onFit]);

  useEffect(() => {
    if (!goal) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const at = performance.now();
    const { motion } = state.current;
    // From where a glide asked for by a button lands, so presses add up; otherwise from the day nearest where the days are.
    const from = motion.kind === "gliding" && !motion.settling ? motion.to : Math.round(position(state.current, at));
    const to = "to" in goal ? goal.to : from + goal.by * daysRef.current;
    state.current = reduced ? still(to) : sideways(state.current, { type: "go", to, at });
    follow();
    if (!reduced) animate();
  }, [goal, animate, follow]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      // A drag in progress keeps the days still under it; a hover's outline goes, since the days move out from under it.
      if (e.ctrlKey || (draftRef.current.kind !== "idle" && draftRef.current.kind !== "hover") || !columnRef.current) return;
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? columnRef.current * days : 1;
      const next = sideways(state.current, { type: "wheel", dx: e.deltaX * unit, dy: e.deltaY * unit, shift: e.shiftKey, at: performance.now(), column: columnRef.current });
      state.current = next;
      if (next.axis !== "x") return;
      // Ours: the hours must not move with a sideways scroll, nor the page go back a page.
      e.preventDefault();
      if (draftRef.current.kind === "hover") dispatch({ type: "leave" });
      follow();
      animate();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [animate, follow, days]);

  const window = useMemo(() => Array.from({ length: days + 2 * spare }, (_, i) => start + i), [days, spare, start]);
  const windowDays = useMemo(() => window.map(dayAt), [window]);
  const today = dayIn(now, timeZone);
  const nowAt = minutesIn(now, timeZone);

  const timed = useMemo(() => events.filter((event) => !inAllDayRow(event.when)), [events]);
  const placedByDay = useMemo(() => new Map(windowDays.map((day) => [day, layoutDay(piecesOf(timed, day, timeZone))])), [windowDays, timed, timeZone]);
  const allDay = useMemo(() => bars(events.filter((event) => inAllDayRow(event.when)), windowDays, timeZone), [events, windowDays, timeZone]);
  const rows = Math.max(1, ...allDay.map((bar) => bar.row + 1));

  // Opens on the hours that matter once the days in view are read, and is left alone after.
  const opened = useRef(false);
  const inView = Array.from({ length: days }, (_, i) => first + i);
  const viewRead = inView.every(listed);
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (opened.current || !sc || !viewRead) return;
    opened.current = true;
    const shown = (sc.clientHeight / HOUR_PX) * 60;
    const starts = inView.flatMap((i) => (placedByDay.get(dayAt(i)) ?? []).map((p) => p.top));
    const nowShown = inView.some((i) => dayAt(i) === today) ? nowAt : null;
    sc.scrollTop = (openingMinutes(starts.length ? Math.min(...starts) : null, nowShown, shown) / 60) * HOUR_PX;
  });

  const byKey = useMemo(() => new Map(events.map((event) => [keyOf(event), event])), [events]);

  /** The day and the minutes into it under the pointer, from where the days are now. */
  const at = (e: { clientX: number; clientY: number }) => {
    const rect = clip.current!.getBoundingClientRect();
    const offset = (e.clientX - rect.left) / columnRef.current + (state.current.x - startRef.current);
    // Outside the grid, the nearest day in view: an event let go over the sidebar isn't sent to a day nobody can see.
    const shown = Math.round(state.current.x);
    const index = Math.max(shown, Math.min(shown + daysRef.current - 1, startRef.current + Math.floor(offset)));
    return { index, minutes: ((e.clientY - rect.top) / HOUR_PX) * 60 };
  };

  const settle = (outcome: Outcome) => {
    if (outcome.kind === "none") return;
    if (outcome.kind === "click" || outcome.kind === "create") return canAdd ? onAdd(dayAt(outcome.day), outcome.start, outcome.end) : undefined;
    const event = byKey.get(outcome.key);
    if (!event || event.when.allDay) return;
    if (outcome.kind === "open") return onOpen(event);
    if (outcome.kind === "refused") return onRefused(event);
    const length = event.when.to - event.when.from;
    if (outcome.kind === "move") {
      const from = instantAt(dayAt(outcome.day), outcome.start, timeZone);
      if (from !== event.when.from) onMove(event, { from, to: from + length }, "Moved");
      return;
    }
    const day = dayIn(event.when.from, timeZone);
    // On the day the clocks go back a time can be read twice; an end that would come before the start is the later one.
    const to = Math.max(instantAt(day, outcome.end, timeZone), event.when.from + 15 * 60_000);
    if (to !== event.when.to) onMove(event, { from: event.when.from, to }, "Resized");
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointerHandled.current = false;
    if (e.button !== 0 || e.pointerType === "touch" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>(".cal-ev");
    const { index, minutes } = at(e);
    let held: Held | null = null;
    if (card) {
      const event = byKey.get(card.dataset.event ?? "");
      const piece = event && (placedByDay.get(dayAt(index)) ?? []).find((p) => p.item === event);
      if (!event || !piece) return;
      held = { key: keyOf(event), start: piece.top, end: piece.bottom, edge: target.closest(".cal-ev-grip") !== null, editable: event.editable && !piece.before && !piece.after };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dispatch({ type: "down", day: index, at: minutes, px: e.clientX, py: e.clientY, held });
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const { index, minutes } = at(e);
    if (draftRef.current.kind === "idle" || draftRef.current.kind === "hover") {
      if (e.buttons || !canAdd) return;
      dispatch({ type: "hover", day: index, at: minutes, overEvent: (e.target as HTMLElement).closest(".cal-ev") !== null });
      return;
    }
    dispatch({ type: "move", day: index, at: minutes, px: e.clientX, py: e.clientY });
  };

  const up = () => {
    const outcome = released(draftRef.current);
    if (draftRef.current.kind === "idle" || draftRef.current.kind === "hover") return;
    pointerHandled.current = true;
    dispatch({ type: "cancel" });
    settle(outcome);
  };

  useEffect(() => {
    if (draft.kind === "idle" || draft.kind === "hover") return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: "cancel" });
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [draft.kind]);

  const moving = draft.kind === "moving" || draft.kind === "resizing" ? draft : null;
  const style = { "--col": `${column}px`, "--days": days, "--hour": `${HOUR_PX}px` } as CSSProperties;

  return (
    <div ref={root} className="cal-tg" role="grid" aria-label={title} aria-busy={busy} style={style} data-days={days}>
      <div className="cal-tg-top" style={{ paddingRight: scrollbar }}>
        <div className="cal-tg-row cal-tg-head" role="row">
          <span className="cal-tg-gutter" />
          <div className="cal-tg-clip">
            <div className="cal-tg-strip" ref={(el) => void (strips.current[0] = el)}>
              {window.map((index, j) => {
                const day = dayAt(index);
                return (
                  <span key={index} className="cal-tg-day" role="columnheader" data-today={day === today || undefined} aria-hidden={index < first || index >= first + days || undefined} style={{ left: j * column }}>
                    <span className="cal-tg-weekday">{weekdayLabel(day)}</span>
                    <span className="cal-tg-date">{Number(day.slice(8))}</span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        <div className="cal-tg-row cal-tg-allday" role="row" aria-label="All day" style={{ height: rows * BAR_PX + 8 }}>
          <span className="cal-tg-gutter">All day</span>
          <div className="cal-tg-clip">
            <div className="cal-tg-strip" ref={(el) => void (strips.current[1] = el)}>
              {allDay.map((bar) => {
                const event = bar.item;
                return (
                  <button
                    key={keyOf(event)}
                    type="button"
                    className="cal-bar"
                    data-event={keyOf(event)}
                    data-first={windowDays[bar.from]}
                    data-last={windowDays[bar.to]}
                    data-before={bar.before || undefined}
                    data-after={bar.after || undefined}
                    aria-hidden={start + bar.to < first || start + bar.from >= first + days || undefined}
                    inert={start + bar.to < first || start + bar.from >= first + days}
                    title={`${event.title || "Untitled"} · ${event.calendar}`}
                    style={{ left: bar.from * column + 2, width: (bar.to - bar.from + 1) * column - 5, top: bar.row * BAR_PX, "--c": event.color ?? "var(--accent)" } as CSSProperties}
                    onClick={() => onOpen(event)}
                  >
                    {event.title || "Untitled"}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div ref={scroller} className="cal-tg-scroll">
        <div className="cal-tg-body">
          <div className="cal-hours" aria-hidden="true">
            {Array.from({ length: 23 }, (_, h) => (
              <span key={h} style={{ top: (h + 1) * HOUR_PX }}>
                {hourLabel(h + 1)}
              </span>
            ))}
          </div>
          <div
            ref={clip}
            className="cal-tg-clip"
            data-adding={canAdd || undefined}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => dispatch({ type: "cancel" })}
            onPointerLeave={() => dispatch({ type: "leave" })}
          >
            <div className="cal-tg-strip" role="row" ref={(el) => void (strips.current[2] = el)}>
              {window.map((index, j) => {
                const day = windowDays[j]!;
                const hidden = index < first || index >= first + days;
                return (
                  <div key={index} className="cal-col" role="gridcell" aria-label={dayLabel(day, "heading")} aria-hidden={hidden || undefined} inert={hidden} data-day={day} data-today={day === today || undefined} data-listed={listed(index) || undefined} style={{ left: j * column }}>
                    {(placedByDay.get(day) ?? []).map((piece) => {
                      const key = keyOf(piece.item);
                      if (moving?.key === key) return null;
                      return <Card key={key} piece={piece} placed={placedByDay.get(day)!} column={column} timeZone={timeZone} now={now} onKey={() => onOpen(piece.item)} pointerHandled={pointerHandled} />;
                    })}
                    {day === today && <span className="cal-now" style={{ top: (nowAt / 60) * HOUR_PX }} aria-hidden="true" />}
                    {draft.kind === "hover" && draft.day === index && (
                      <span className="cal-ghost" style={{ top: (draft.slot / 60) * HOUR_PX, height: HOUR_PX / 2 }} aria-hidden="true">
                        {timeLabel(instantAt(day, draft.slot, timeZone), timeZone)}
                      </span>
                    )}
                    {draft.kind === "drawing" && draft.day === index && <DraftCard day={day} anchor={draft.anchor} at={draft.at} timeZone={timeZone} />}
                    {moving && moving.day === index && byKey.get(moving.key) && <DraggedCard event={byKey.get(moving.key)!} day={day} start={moving.start} end={moving.kind === "moving" ? moving.start + moving.length : moving.end} timeZone={timeZone} />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ piece, placed, column, timeZone, now, onKey, pointerHandled }: { piece: Placed<CalendarEvent>; placed: readonly Placed<CalendarEvent>[]; column: number; timeZone: string; now: number; onKey: () => void; pointerHandled: React.MutableRefObject<boolean> }) {
  const event = piece.item;
  const drawn = Math.max(piece.bottom - piece.top, 15);
  const height = (drawn / 60) * HOUR_PX - 2;
  const { range, start, compact } = timesOf(piece, timeZone);
  const over = placed.find((o) => o !== piece && o.lane === piece.lane && o.indent > piece.indent && o.top > piece.top && o.top < piece.top + drawn);
  const covered = over !== undefined && ((over.top - piece.top) / 60) * HOUR_PX < 2 * LINE_PX + 6;
  const short = height < 40 || covered;
  const lines = Math.max(1, Math.floor((height - 6 - LINE_PX) / LINE_PX));
  // As the CSS works it out from --nest and the column, so a card too narrow for its padding gives the time the room.
  const width = (piece.span * column) / piece.lanes - piece.indent * Math.min(28, column * 0.22) - 3;
  const classes = ["cal-ev", short && "is-short", width < 64 && "is-narrow", piece.indent > 0 && "is-nested", !event.when.allDay && event.when.to <= now && "is-past", event.recurring && "is-recurring"].filter(Boolean).join(" ");
  const label = `${range} ${event.title || "Untitled"}`;
  return (
    <button
      type="button"
      className={classes}
      data-event={keyOf(event)}
      aria-label={label}
      title={`${event.title || "Untitled"}, ${range}${event.location ? `, ${event.location}` : ""} · ${event.calendar}`}
      style={
        {
          top: (piece.top / 60) * HOUR_PX,
          height,
          left: `calc(${piece.lane} * 100% / ${piece.lanes} + ${piece.indent} * var(--nest))`,
          width: `calc(${piece.span} * 100% / ${piece.lanes} - ${piece.indent} * var(--nest) - 3px)`,
          zIndex: 1 + piece.indent,
          "--c": event.color ?? "var(--accent)",
          "--lines": lines,
          // A quarter hour is 10px: its one line is set to fit, so its time still reads.
          ...(short && height < LINE_PX + 2 && { lineHeight: `${Math.max(9, height)}px`, fontSize: 10.5 }),
        } as CSSProperties
      }
      onClick={(e) => {
        // A mouse press is the grid's, which opens it on release unless it was dragged; keys and touch come here.
        if (pointerHandled.current && e.detail > 0) return void (pointerHandled.current = false);
        onKey();
      }}
    >
      <span className="cal-ev-title">{event.title || "Untitled"}</span>
      <span className="cal-ev-time">
        <span className="cal-ev-range">{range}</span>
        <span className="cal-ev-start">{start}</span>
        <span className="cal-ev-compact">{compact}</span>
      </span>
      {event.editable && !piece.after && <span className="cal-ev-grip" aria-hidden="true" />}
    </button>
  );
}

/** "9:00 AM to 10:15 AM", as a drag draws it. */
export const spanWords = (from: number, to: number, timeZone: string) => `${timeLabel(from, timeZone)} to ${timeLabel(to, timeZone)}`;

function DraftCard({ day, anchor, at, timeZone }: { day: Day; anchor: number; at: number; timeZone: string }) {
  const { start, end } = dragSpan(anchor, at);
  return (
    <span className="cal-ev is-draft" role="status" style={{ top: (start / 60) * HOUR_PX, height: ((end - start) / 60) * HOUR_PX - 2 }}>
      {spanWords(instantAt(day, start, timeZone), instantAt(day, end, timeZone), timeZone)}
    </span>
  );
}

function DraggedCard({ event, day, start, end, timeZone }: { event: CalendarEvent; day: Day; start: number; end: number; timeZone: string }) {
  const from = instantAt(day, start, timeZone);
  const to = instantAt(day, end, timeZone);
  return (
    <span className="cal-ev is-dragging" role="status" style={{ top: (start / 60) * HOUR_PX, height: ((Math.max(end - start, 15) / 60) * HOUR_PX) - 2, "--c": event.color ?? "var(--accent)" } as CSSProperties}>
      <span className="cal-ev-title">{event.title || "Untitled"}</span>
      <span className="cal-ev-time">{rangeLabel(from, to, timeZone)}</span>
    </span>
  );
}
