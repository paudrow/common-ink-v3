import { dayIn } from "./history.ts";

/**
 * The settings a daily note is made by. The daily plugin declares them to the member, and the server
 * reads them here when it files a completion, which an agent's has no browser to say them for.
 */
export const DAILY_SETTINGS = {
  folder: { key: "daily.folder", default: "Daily", maxLength: 100 },
  private: { key: "daily.private", default: true },
  timeZone: { key: "daily.timeZone", default: "" },
} as const;

export interface DailySettings {
  /** The name of a folder at the top of the workspace. */
  folder: string;
  /** Whether a new daily note is private to its member. */
  private: boolean;
  /** The zone whose day it is when nobody says the day, or null for UTC. */
  timeZone: string | null;
}

const FOLDER_NAME = /^[^/\p{Cc}]*$/u;

function zoneOf(value: unknown): string | null {
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
  const name = typeof written[folder.key] === "string" ? (written[folder.key] as string).trim() : "";
  return {
    folder: name && name.length <= folder.maxLength && FOLDER_NAME.test(name) ? name : folder.default,
    private: typeof written[isPrivate.key] === "boolean" ? (written[isPrivate.key] as boolean) : isPrivate.default,
    timeZone: zoneOf(written[timeZone.key]),
  };
}

/** The day it is at `now` for someone with these settings: in their zone, or in UTC when they named none. */
export const dayFor = (settings: DailySettings, now: number): string => dayIn(settings.timeZone ?? "UTC")(now);

/** A daily note is headed by its date as a due date is written, so it sorts and reads the same everywhere. */
export const dailyHeading = (day: string) => `# ${day}`;

/** What a new daily note holds: its heading, a line left empty, and the lines filed on it. */
export const dailyText = (day: string, lines: readonly string[] = []) => `${dailyHeading(day)}\n\n${lines.map((line) => `${line}\n`).join("")}`;

/** A daily note's text with `lines` filed at its end. */
export const filedOn = (text: string, lines: readonly string[]) => `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;
