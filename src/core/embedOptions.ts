/**
 * An embed's options declared as data: what each is called, what it holds, and what it is when the
 * note says nothing of it. The host reads and writes them as `key=value` words in the embed's config
 * (`::x-poll{question="Lunch?" votes=3}`), and draws them beneath the embed, so a plugin that declares
 * them writes no code for either. Words of the config that are no option's are left as they are.
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

/** One word of a config: `key=value`, `key="two words"`, or anything else, kept as it is. */
type Word = { key: string | null; value: string; raw: string };

const WORD = /([a-z][a-zA-Z0-9-]*)=(?:"([^"]*)"|(\S*))|\S+/g;

function wordsOf(config: string): Word[] {
  return [...config.matchAll(WORD)].map((m) => (m[1] ? { key: m[1], value: m[2] ?? m[3] ?? "", raw: m[0] } : { key: null, value: m[0], raw: m[0] }));
}

/** How a value is written: bare where it is one word of plain characters, quoted otherwise. */
const written = (id: string, value: string) => (/^[\w.:/+-]+$/.test(value) ? `${id}=${value}` : `${id}="${value}"`);

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** Seconds in a duration written `25m`, `1h30m`, `90s`, or a bare number of minutes. Null for anything else, nothing, or past 100 hours. */
export function secondsIn(text: string): number | null {
  const t = text.trim();
  const m = /^\d+$/.test(t) ? [t, undefined, t, undefined] : t ? DURATION.exec(t) : null;
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 && seconds <= 100 * 3600 ? seconds : null;
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

/** Each option's value as the config says it: its last word for the option, or the default where there is none or it can't be taken. */
export function optionValues(options: readonly DeclaredOption[], config: string): Record<string, OptionValue> {
  const words = wordsOf(config);
  return Object.fromEntries(
    options.map((option) => {
      const word = words.findLast((w) => w.key === option.id);
      const read = word ? valueOf(option, option.type === "number" ? withinRange(option, word.value) : word.value) : null;
      return [option.id, read && "value" in read ? read.value : defaultOf(option)];
    }),
  );
}

/** A number written past either end of its option's range, as by hand, is read as that end. Only a value typed in the field is refused for it. */
function withinRange(option: Extract<DeclaredOption, { type: "number" }>, text: string): string {
  const n = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(n)) return text;
  return String(Math.min(Math.max(n, option.min ?? -Infinity), option.max ?? Infinity));
}

/** A value as a field shows it and as it is typed back. */
export function shownValue(option: DeclaredOption, value: OptionValue): string {
  if (option.type === "toggle") return value ? "on" : "off";
  return String(value);
}

/**
 * The config with option `id` set to what `text` says, or why it can't be. Every word the config has
 * for the option is taken out, and one is written at the end unless the value is the option's
 * default, so a config says only what differs. Every other word stays where it was.
 */
export function setOption(options: readonly DeclaredOption[], config: string, id: string, text: string): { config: string } | string {
  const option = options.find((o) => o.id === id);
  if (!option) return `No option ${id}.`;
  // An emptied number or duration is its default again.
  const read = text.trim() === "" && (option.type === "number" || option.type === "duration") ? { value: defaultOf(option), words: "" } : valueOf(option, text);
  if ("refused" in read) return read.refused;
  const kept = wordsOf(config).filter((w) => w.key !== id).map((w) => w.raw);
  const fallback = defaultOf(option);
  const same = read.value === fallback || (option.type === "colour" && read.value === "" && fallback === "");
  return { config: [...kept, ...(same ? [] : [written(id, read.words)])].join(" ") };
}
