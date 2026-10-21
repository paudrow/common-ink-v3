import { dayIn } from "./history.ts";

/**
 * The settings a daily note is made by. The daily plugin declares them to the member, and the server
 * reads them here when it files a completion, which an agent's has no browser to say them for.
 */
export const DAILY_SETTINGS = {
  folder: { key: "daily.folder", default: "" },
  private: { key: "daily.private", default: true },
  timeZone: { key: "daily.timeZone", default: "" },
} as const;

/** The folder at the top of the workspace that daily notes go in when the member's settings pick none they can use. */
export const DAILY_FOLDER = "Daily";

export interface DailySettings {
  /**
   * The folder picked for daily notes: a folder's id, or the name of one at the top of the workspace
   * as the setting held before it was picked from a list. Null for the default.
   */
  folder: string | null;
  /** Whether a new daily note is private to its member. */
  private: boolean;
  /** The zone the member named to be taken in place of their browser's, or null when they named none. */
  timeZone: string | null;
}

const FOLDER_NAME = /^[^/\p{Cc}]*$/u;
const MAX_FOLDER_NAME = 100;

/** `value` when it is a time zone's name this runtime knows, or null. */
export function zoneOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    dayIn(value);
    return value;
  } catch {
    return null;
  }
}

/** What a member's settings, as they wrote them, say of daily notes. Anything they got wrong reads as its default. */
export function dailySettings(text: string | null | undefined): DailySettings {
  let written: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) written = value as Record<string, unknown>;
  } catch {
    // Settings that can't be read are the defaults, as they are in the app.
  }
  const { folder, private: isPrivate, timeZone } = DAILY_SETTINGS;
  const picked = typeof written[folder.key] === "string" ? (written[folder.key] as string).trim() : "";
  return {
    folder: picked && picked.length <= MAX_FOLDER_NAME && FOLDER_NAME.test(picked) ? picked : null,
    private: typeof written[isPrivate.key] === "boolean" ? (written[isPrivate.key] as boolean) : isPrivate.default,
    timeZone: zoneOf(written[timeZone.key]),
  };
}

/**
 * The zone the server takes a member's day and times in when nobody says them: the one their settings
 * name, or else the one of the browser they last used Common Ink in (`stored`), or else UTC.
 */
export const memberZone = (settings: DailySettings, stored: string | null): string => settings.timeZone ?? zoneOf(stored) ?? "UTC";

/** A daily note is headed by its date as a due date is written, so it sorts and reads the same everywhere. */
export const dailyHeading = (day: string) => `# ${day}`;

/** What a new daily note holds: its heading, a line left empty, and the lines filed on it. */
export const dailyText = (day: string, lines: readonly string[] = []) => `${dailyHeading(day)}\n\n${lines.map((line) => `${line}\n`).join("")}`;

/** A daily note's text with `lines` filed at its end. */
export const filedOn = (text: string, lines: readonly string[]) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;
