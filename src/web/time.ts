import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar day it is at `time` where the member is: the browser's own time zone, written YYYY-MM-DD. */
export const dayOf = (time: Date) => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;

/** Today where the member is. The server is handed this day and never works it out for someone in the app. */
export const today = () => dayOf(new Date());

/** How long ago `then` was, as a note list shows it: "just now", "5m ago", "yesterday", or a date. */
export function ago(then: number, now: number): string {
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The current time, updated each minute so relative times stay true. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
