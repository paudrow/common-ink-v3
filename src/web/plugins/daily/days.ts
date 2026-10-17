import { dayIn, isDay, shiftDay } from "../calendar/dates.ts";

/** A day a member asked to go to, and whether its daily note is made when it isn't there. */
export interface Asked {
  day: string;
  make: boolean;
}

/** The time zone this browser keeps, whose day the app calls today. */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The member's date at `now` where they are. */
export const todayIn = (now: number, timeZone: string): string => dayIn(now, timeZone);

/**
 * The day `by` days from `from`, where `today` is the member's date. Today's note and tomorrow's are
 * made when they aren't there, as Today makes one. Any other day's is only found: a day gone by with
 * no note had nothing written on it, and one further ahead isn't wanted yet.
 */
export function toward(from: string, by: number, today: string): Asked {
  const day = shiftDay(from, by);
  return { day, make: day === today || day === shiftDay(today, 1) };
}

/** The day a daily note is for, read from its title, which is its date until the member retitles it. */
export const dayTitled = (title: string): string | null => (isDay(title) ? title : null);

/** The day a daily note's first line heads it with, as it was made: `# 2026-10-16`. */
export function dayHeading(line: string): string | null {
  const match = /^# (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
  return match ? dayTitled(match[1]!) : null;
}
