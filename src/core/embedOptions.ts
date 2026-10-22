/**
 * An embed's options declared as data: what each is called, what it holds, and what it is when the
 * note says nothing of it. The host reads and writes them as `key=value` words in the embed's config
 * (`::x-poll{question="Lunch?" votes=3}`) through `embedSchema.ts`, and draws them beneath the embed,
 * so a plugin that declares them writes no code for either.
 */

/** The colours an embed can ask for by name. Each is drawn to suit the theme, light or dark, as `--swatch` on an element with `data-colour`. */
export const SWATCHES = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "gray"] as const;
export type Swatch = (typeof SWATCHES)[number];

export type DeclaredOption =
  | { type: "text"; id: string; label: string; default: string; maxLength?: number }
  | { type: "number"; id: string; label: string; default: number; min?: number; max?: number; step?: number }
  | { type: "toggle"; id: string; label: string; default: boolean }
  | { type: "choice"; id: string; label: string; values: readonly string[]; default?: string }
  | { type: "colour"; id: string; label: string; default: Swatch | "" }
  | { type: "duration"; id: string; label: string; default: string }
  | { type: "date"; id: string; label: string; default: string };

export type OptionValue = string | number | boolean;

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** Seconds in a duration written `25m`, `1h30m`, `90s`, or a bare number of minutes, however long. Null for anything else or nothing. */
function writtenSeconds(text: string): number | null {
  const t = text.trim();
  const m = /^\d+$/.test(t) ? [t, undefined, t, undefined] : t ? DURATION.exec(t) : null;
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

/** Seconds in a duration written `25m`, `1h30m`, `90s`, or a bare number of minutes. Null for anything else, nothing, or past 100 hours. */
export function secondsIn(text: string): number | null {
  const seconds = writtenSeconds(text);
  return seconds !== null && seconds > 0 && seconds <= 100 * 3600 ? seconds : null;
}

/** The hours, minutes and seconds of a duration written `1h30m`, `90s` or `25`, as a duration field shows them, however many hours a timer's own length has. Null for what isn't one. */
export function durationParts(text: string): [hours: number, minutes: number, seconds: number] | null {
  const seconds = writtenSeconds(text);
  return seconds === null ? null : [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
}

/** A duration in the words it is written in: `1h30m`, `4m30s`, `25m`. */
export function durationWords(seconds: number): string {
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}`;
}

const isDate = (text: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
};

/** What a number option takes, in words, for its hint and for a value it can't take. */
export function numberRule(option: Extract<DeclaredOption, { type: "number" }>): string {
  const { min, max, step } = option;
  const whole = step !== undefined && Number.isInteger(step) && Number.isInteger(min ?? 0);
  const what = whole && step === 1 ? "A whole number" : "A number";
  const range = min !== undefined && max !== undefined ? ` from ${min} to ${max}` : min !== undefined ? ` of ${min} or more` : max !== undefined ? ` up to ${max}` : "";
  const steps = step !== undefined && step !== 1 ? `, in steps of ${step}` : "";
  return `${what}${range}${steps}.`;
}

/**
 * The value `text` stands for as `option` takes it, as it is written in the config, or why it can't
 * be taken. Every option is read through this, from the note and from the field the member types in.
 */
export function valueOf(option: DeclaredOption, text: string): { value: OptionValue; words: string } | { refused: string } {
  const t = text.trim();
  switch (option.type) {
    case "text":
      if (/["{}\r\n]/.test(t)) return { refused: "Quotes, braces and line breaks can't be in it." };
      if (option.maxLength !== undefined && t.length > option.maxLength) return { refused: `At most ${option.maxLength} characters.` };
      return { value: t, words: t };
    case "number": {
      const n = t === "" ? NaN : Number(t);
      const { min, max, step } = option;
      const off = step !== undefined && Math.abs((n - (min ?? 0)) / step - Math.round((n - (min ?? 0)) / step)) > 1e-9;
      if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max) || off) return { refused: numberRule(option) };
      return { value: n, words: String(n) };
    }
    case "toggle":
      if (t === "on" || t === "off") return { value: t === "on", words: t };
      return { refused: "On or off." };
    case "choice":
      return option.values.includes(t) ? { value: t, words: t } : { refused: `One of ${option.values.join(", ")}.` };
    case "colour":
      if (t === "" || t === "none") return { value: "", words: "none" };
      return (SWATCHES as readonly string[]).includes(t) ? { value: t, words: t } : { refused: `One of ${SWATCHES.join(", ")}, or none.` };
    case "duration": {
      const seconds = secondsIn(t);
      return seconds === null ? { refused: "Write it like 25m, 1h30m or 90s." } : { value: durationWords(seconds), words: durationWords(seconds) };
    }
    case "date":
      if (t === "") return { value: "", words: "" };
      return isDate(t) ? { value: t, words: t } : { refused: "A day written like 2026-10-16." };
  }
}

/** What an option is when the note says nothing of it. A choice with no default is its first value. */
export function defaultOf(option: DeclaredOption): OptionValue {
  return option.type === "choice" ? (option.default ?? option.values[0] ?? "") : option.default;
}

/** A value as a field shows it and as it is typed back. */
export function shownValue(option: DeclaredOption, value: OptionValue): string {
  if (option.type === "toggle") return value ? "on" : "off";
  return String(value);
}
