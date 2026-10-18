import { z } from "zod";

export type Form = NamedForm | AnonymousForm;

export interface NamedForm extends Base {
  anonymous?: false;
  /** `each` keeps every member's choices. `one` keeps only the member who edited last. Absent means `each`. */
  mode?: "each" | "one";
  answers: Record<string, MemberAnswers>;
  /** What a member wrote in Other, by question id. The choice itself stays in `answers`. */
  other?: Record<string, Record<string, string>>;
}

export interface AnonymousForm extends Base {
  anonymous: true;
  /** Counts by question id, then by tally key. */
  tallies: Record<string, Record<string, number>>;
  /** Text answers and Other lines by question id, with no author. */
  texts: Record<string, string[]>;
  /** Members who have cast, in the order they did. */
  voted: string[];
}

interface Base {
  /** When present and non-empty, only these members may answer. */
  ask?: string[];
  closed?: boolean;
  /** Absent means a choice question has an Other line. False hides Other on the whole form. */
  explain?: boolean;
  /** Who asked, as written. Absent means the form doesn't say. */
  by?: string;
  questions: Question[];
}

export type MemberAnswers = Record<string, AnswerValue>;

export type AnswerValue = string | string[] | number | Record<string, string | string[]>;

export type Question = ShortQuestion | OneQuestion | SeveralQuestion | DropdownQuestion | ScaleQuestion | WhenQuestion | GridQuestion | ImageQuestion;

interface QuestionBase {
  id: string;
  prompt: string;
  description?: string;
  /** A picture shown with the question. An address on this site, or a data image. */
  picture?: string;
}

export interface ShortQuestion extends QuestionBase {
  type: "short" | "paragraph";
  required?: boolean;
}

export interface OneQuestion extends QuestionBase {
  type: "one";
  options: string[];
  required?: boolean;
  explain?: boolean;
}

export interface SeveralQuestion extends QuestionBase {
  type: "several";
  options: string[];
  required?: boolean;
  explain?: boolean;
}

export interface DropdownQuestion extends QuestionBase {
  type: "dropdown";
  options: string[];
  required?: boolean;
  explain?: boolean;
}

export interface WhenQuestion extends QuestionBase {
  type: "date" | "time";
  required?: boolean;
  explain?: boolean;
}

export interface ScaleQuestion extends QuestionBase {
  type: "scale";
  minLabel?: string;
  maxLabel?: string;
  explain?: boolean;
}

export interface GridQuestion extends QuestionBase {
  type: "grid";
  rows: { id: string; label: string }[];
  cols: { id: string; label: string }[];
  /** True lets a row take more than one column. Absent means one column per row. */
  several?: boolean;
  explain?: boolean;
}

export interface ImageQuestion extends QuestionBase {
  type: "image";
  options: { id: string; label: string; src?: string }[];
  /** True lets someone pick more than one image. Absent means one. */
  several?: boolean;
  explain?: boolean;
}

/** A choice question shows Other unless this question or the whole form says not to. Short and paragraph questions are already the explanation. */
export function showsOther(form: Form, question: Question): boolean {
  switch (question.type) {
    case "short":
    case "paragraph":
      return false;
    default:
      if (question.explain === false) return false;
      if (question.explain === true) return true;
      return form.explain !== false;
  }
}

const id = z.string().min(1);
const labelled = z.object({ id, label: z.string() }).passthrough();
const explain = z.boolean().optional();
const described = { description: z.string().optional(), picture: z.string().optional() };
const text = (type: "short" | "paragraph") => z.object({ id, type: z.literal(type), prompt: z.string(), required: z.boolean().optional(), ...described }).passthrough();
const one = z.object({ id, type: z.literal("one"), prompt: z.string(), options: z.array(z.string()), required: z.boolean().optional(), explain, ...described }).passthrough();
const several = z.object({ id, type: z.literal("several"), prompt: z.string(), options: z.array(z.string()), required: z.boolean().optional(), explain, ...described }).passthrough();
const dropdown = z.object({ id, type: z.literal("dropdown"), prompt: z.string(), options: z.array(z.string()), required: z.boolean().optional(), explain, ...described }).passthrough();
const when = (type: "date" | "time") => z.object({ id, type: z.literal(type), prompt: z.string(), required: z.boolean().optional(), explain, ...described }).passthrough();
const scale = z.object({ id, type: z.literal("scale"), prompt: z.string(), minLabel: z.string().optional(), maxLabel: z.string().optional(), explain, ...described }).passthrough();
const grid = z.object({ id, type: z.literal("grid"), prompt: z.string(), rows: z.array(labelled), cols: z.array(labelled), several: z.boolean().optional(), explain, ...described }).passthrough();
const image = z.object({ id, type: z.literal("image"), prompt: z.string(), options: z.array(z.object({ id, label: z.string(), src: z.string().optional() }).passthrough()), several: z.boolean().optional(), explain, ...described }).passthrough();
const question = z.discriminatedUnion("type", [text("short"), text("paragraph"), one, several, dropdown, scale, when("date"), when("time"), grid, image]);

const answerValue = z.union([z.string(), z.number(), z.array(z.string()), z.record(z.string(), z.union([z.string(), z.array(z.string())]))]);
const shared = { ask: z.array(z.string()).optional(), closed: z.boolean().optional(), explain, by: z.string().optional(), questions: z.array(question) };

const namedSchema = z
  .object({
    ...shared,
    anonymous: z.literal(false).optional(),
    mode: z.enum(["each", "one"]).optional(),
    answers: z.record(z.string(), z.record(z.string(), answerValue)).default({}),
    other: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  })
  .passthrough();
const anonymousSchema = z
  .object({
    ...shared,
    anonymous: z.literal(true),
    tallies: z.record(z.string(), z.record(z.string(), z.number())).default({}),
    texts: z.record(z.string(), z.array(z.string())).default({}),
    voted: z.array(z.string()).default([]),
  })
  .passthrough();
const formSchema = z.union([anonymousSchema, namedSchema]);

/** The body as a form, or null when it is not one. Unknown keys are kept. */
export function parseForm(body: string): Form | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const read = formSchema.safeParse(json);
  if (!read.success || typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const raw = json as Record<string, unknown>;
  const form = read.data as Form;
  if (!coherent(form, raw)) return null;
  return form;
}

/** Stable pretty JSON, two spaces, keys sorted, with a trailing newline. */
export function serializeForm(form: Form): string {
  return `${JSON.stringify(sorted(form), null, 2)}\n`;
}

/**
 * Stores `value` as `memberId`'s choice for the question, or returns `form` unchanged when they
 * may not answer. The choice already stored is cleared: the same option, scale point, image, or
 * grid cell, one entry of a several, or a text field set to "".
 */
export function setAnswer(form: NamedForm, memberId: string, questionId: string, value: unknown): NamedForm {
  if (!allowed(form, memberId)) return form;
  const question = form.questions.find((item) => item.id === questionId);
  if (!question) return form;
  // `one` is a single shared answer. The next editor continues it, and the key becomes theirs.
  const prior = carried(form, memberId);
  const applied = apply(question, prior.answers[questionId], value);
  if (applied === "same") return form;
  if (applied === "clear") delete prior.answers[questionId];
  else prior.answers[questionId] = applied;
  return written(form, memberId, prior.answers, prior.other);
}

/**
 * Stores `text` as `memberId`'s Other line, or returns `form` unchanged when they may not answer
 * or this question has no Other line. "" clears it. On a single shared answer, the choice already
 * stored comes with it.
 */
export function setOther(form: NamedForm, memberId: string, questionId: string, text: string): NamedForm {
  if (!allowed(form, memberId)) return form;
  const question = form.questions.find((item) => item.id === questionId);
  if (!question || !showsOther(form, question)) return form;
  const prior = carried(form, memberId);
  if ((prior.other[questionId] ?? "") === text) return form;
  if (text === "") delete prior.other[questionId];
  else prior.other[questionId] = text;
  return written(form, memberId, prior.answers, prior.other);
}

/**
 * Adds `draft` into the tallies and texts and records the member. A member already in `voted`
 * gets the same form back: their choice was not kept, so it cannot be changed.
 */
export function castVote(form: AnonymousForm, memberId: string, draft: MemberAnswers, other: Record<string, string> = {}): AnonymousForm {
  if (!allowed(form, memberId) || form.voted.includes(memberId)) return form;
  const tallies = Object.fromEntries(Object.entries(form.tallies).map(([key, counts]) => [key, { ...counts }]));
  const texts = Object.fromEntries(Object.entries(form.texts).map(([key, lines]) => [key, [...lines]]));
  for (const [questionId, value] of Object.entries(draft)) {
    const question = form.questions.find((item) => item.id === questionId);
    if (question) count(question, value, tallies, texts);
  }
  for (const [questionId, text] of Object.entries(other)) {
    const question = form.questions.find((item) => item.id === questionId);
    if (!question || !showsOther(form, question) || text === "") continue;
    texts[questionId] = [...(texts[questionId] ?? []), text].sort();
  }
  return { ...form, tallies, texts, voted: [...form.voted, memberId] };
}

function carried(form: NamedForm, memberId: string): { answers: MemberAnswers; other: Record<string, string> } {
  const source = form.mode === "one" ? (Object.keys(form.answers)[0] ?? Object.keys(form.other ?? {})[0] ?? memberId) : memberId;
  return { answers: { ...(form.answers[source] ?? {}) }, other: { ...(form.other?.[source] ?? {}) } };
}

function written(form: NamedForm, memberId: string, answers: MemberAnswers, other: Record<string, string>): NamedForm {
  const nextAnswers = form.mode === "one" ? {} : { ...form.answers };
  const nextOther = form.mode === "one" ? {} : { ...(form.other ?? {}) };
  if (Object.keys(answers).length) nextAnswers[memberId] = answers;
  else delete nextAnswers[memberId];
  if (Object.keys(other).length) nextOther[memberId] = other;
  else delete nextOther[memberId];
  const next: NamedForm = { ...form, answers: nextAnswers };
  if (Object.keys(nextOther).length) next.other = nextOther;
  else delete next.other;
  return next;
}

function allowed(form: Form, memberId: string): boolean {
  if (form.closed) return false;
  return !form.ask?.length || form.ask.includes(memberId);
}

function coherent(form: Form, raw: Record<string, unknown>): boolean {
  if (form.anonymous) {
    if ("answers" in raw || "mode" in raw || "other" in raw) return false;
  } else if ("tallies" in raw || "texts" in raw || "voted" in raw) return false;
  if (!wellFormed(form.questions)) return false;
  const byId = new Map(form.questions.map((question) => [question.id, question]));
  if (form.anonymous) {
    return known(byId, form.tallies) && known(byId, form.texts);
  }
  if (form.other && !Object.values(form.other).every((notes) => Object.entries(notes).every(([questionId, text]) => byId.has(questionId) && typeof text === "string"))) return false;
  return Object.values(form.answers).every((member) => Object.entries(member).every(([questionId, value]) => fits(byId.get(questionId), value)));
}

function known(byId: Map<string, Question>, record: Record<string, unknown>): boolean {
  return Object.keys(record).every((questionId) => byId.has(questionId));
}

function wellFormed(questions: Question[]): boolean {
  if (new Set(questions.map((question) => question.id)).size !== questions.length) return false;
  return questions.every((question) => {
    if (question.type === "grid") return distinct(question.rows.map((row) => row.id)) && distinct(question.cols.map((col) => col.id));
    if (question.type === "image") return distinct(question.options.map((option) => option.id));
    return true;
  });
}

const distinct = (ids: string[]) => new Set(ids).size === ids.length;

function fits(question: Question | undefined, value: AnswerValue): boolean {
  if (!question) return false;
  switch (question.type) {
    case "short":
    case "paragraph":
      return typeof value === "string";
    case "one":
    case "dropdown":
      return typeof value === "string" && question.options.includes(value);
    case "several":
      return Array.isArray(value) && value.every((option) => question.options.includes(option));
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case "time":
      return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
    case "scale":
      return scalePoint(value);
    case "grid":
      return question.several ? gridMany(question, value) !== null : gridValue(question, value) !== null;
    case "image":
      return question.several
        ? Array.isArray(value) && value.every((option) => question.options.some((item) => item.id === option))
        : typeof value === "string" && question.options.some((option) => option.id === value);
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

function apply(question: Question, current: AnswerValue | undefined, value: unknown): "same" | "clear" | AnswerValue {
  switch (question.type) {
    case "short":
    case "paragraph": {
      if (typeof value !== "string") return "same";
      if (value === "") return current === undefined ? "same" : "clear";
      return value === current ? "same" : value;
    }
    case "one":
    case "dropdown":
    case "image": {
      if (question.type === "image" && question.several) return toggleList(value, current, (option) => question.options.some((item) => item.id === option));
      const ok = question.type === "image" ? typeof value === "string" && question.options.some((option) => option.id === value) : typeof value === "string" && question.options.includes(value);
      if (!ok || typeof value !== "string") return "same";
      return value === current ? "clear" : value;
    }
    case "date":
    case "time": {
      if (typeof value !== "string") return "same";
      if (value === "") return current === undefined ? "same" : "clear";
      if (!fits(question, value)) return "same";
      return value === current ? "same" : value;
    }
    case "several": {
      if (typeof value !== "string" || !question.options.includes(value)) return "same";
      const have = Array.isArray(current) ? current : [];
      const next = have.includes(value) ? have.filter((option) => option !== value) : [...have, value];
      if (!next.length) return have.length ? "clear" : "same";
      return next;
    }
    case "scale": {
      if (!scalePoint(value)) return "same";
      return value === current ? "clear" : value;
    }
    case "grid": {
      const pick = gridPick(question, value);
      if (!pick) return "same";
      if (question.several) {
        const have = gridMany(question, current) ?? {};
        for (const [row, col] of Object.entries(pick)) {
          const cols = new Set(have[row] ?? []);
          if (cols.has(col)) cols.delete(col);
          else cols.add(col);
          if (cols.size) have[row] = [...cols];
          else delete have[row];
        }
        return Object.keys(have).length ? have : "clear";
      }
      const have = gridValue(question, current) ?? {};
      for (const [row, col] of Object.entries(pick)) {
        if (have[row] === col) delete have[row];
        else have[row] = col;
      }
      return Object.keys(have).length ? have : "clear";
    }
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

function count(question: Question, value: AnswerValue, tallies: Record<string, Record<string, number>>, texts: Record<string, string[]>): void {
  const bump = (key: string) => {
    const counts = (tallies[question.id] = { ...(tallies[question.id] ?? {}) });
    counts[key] = (counts[key] ?? 0) + 1;
  };
  switch (question.type) {
    case "short":
    case "paragraph":
      // Sorted, so a later reader cannot line the strings up with `voted`.
      if (typeof value === "string" && value !== "") texts[question.id] = [...(texts[question.id] ?? []), value].sort();
      return;
    case "one":
    case "dropdown":
      if (typeof value === "string" && question.options.includes(value)) bump(value);
      return;
    case "date":
    case "time":
      if (typeof value === "string" && value !== "") texts[question.id] = [...(texts[question.id] ?? []), value].sort();
      return;
    case "several":
      if (Array.isArray(value)) for (const option of value) if (question.options.includes(option)) bump(option);
      return;
    case "scale":
      if (scalePoint(value)) bump(String(value));
      return;
    case "grid": {
      if (question.several) {
        const cells = gridMany(question, value);
        if (cells) for (const [row, cols] of Object.entries(cells)) for (const col of cols) bump(`${row}:${col}`);
        return;
      }
      const cells = gridValue(question, value);
      if (cells) for (const [row, col] of Object.entries(cells)) if (typeof col === "string") bump(`${row}:${col}`);
      return;
    }
    case "image":
      if (question.several && Array.isArray(value)) {
        for (const option of value) if (question.options.some((item) => item.id === option)) bump(option);
        return;
      }
      if (typeof value === "string" && question.options.some((option) => option.id === value)) bump(value);
      return;
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

function scalePoint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

function gridValue(question: GridQuestion, value: unknown): Record<string, string> | null {
  if (!plain(value)) return null;
  const rows = new Set(question.rows.map((row) => row.id));
  const cols = new Set(question.cols.map((col) => col.id));
  const cells: Record<string, string> = {};
  for (const [row, col] of Object.entries(value)) {
    if (!rows.has(row) || typeof col !== "string" || !cols.has(col)) return null;
    cells[row] = col;
  }
  return cells;
}

function gridMany(question: GridQuestion, value: unknown): Record<string, string[]> | null {
  if (!plain(value)) return null;
  const rows = new Set(question.rows.map((row) => row.id));
  const cols = new Set(question.cols.map((col) => col.id));
  const cells: Record<string, string[]> = {};
  for (const [row, picked] of Object.entries(value)) {
    if (!rows.has(row) || !Array.isArray(picked) || !picked.every((col) => typeof col === "string" && cols.has(col))) return null;
    cells[row] = picked;
  }
  return cells;
}

function toggleList(value: unknown, current: AnswerValue | undefined, ok: (option: string) => boolean): "same" | "clear" | string[] {
  if (typeof value !== "string" || !ok(value)) return "same";
  const have = Array.isArray(current) ? current : [];
  const next = have.includes(value) ? have.filter((option) => option !== value) : [...have, value];
  if (!next.length) return have.length ? "clear" : "same";
  return next;
}

/** Puts `questions` on the form and drops answers that no longer fit. An ill-formed list is refused. */
export function replaceQuestions(form: Form, questions: Question[]): Form {
  if (!wellFormed(questions)) return form;
  const byId = new Map(questions.map((question) => [question.id, question]));
  if (form.anonymous) {
    const keep = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([key]) => byId.has(key)));
    return { ...form, questions, tallies: keep(form.tallies), texts: keep(form.texts) };
  }
  const answers: NamedForm["answers"] = {};
  for (const [memberId, mine] of Object.entries(form.answers)) {
    const next: MemberAnswers = {};
    for (const [questionId, value] of Object.entries(mine)) {
      const question = byId.get(questionId);
      if (question && fits(question, value)) next[questionId] = value;
    }
    if (Object.keys(next).length) answers[memberId] = next;
  }
  const other: NonNullable<NamedForm["other"]> = {};
  for (const [memberId, notes] of Object.entries(form.other ?? {})) {
    const next: Record<string, string> = {};
    for (const [questionId, text] of Object.entries(notes)) {
      const question = byId.get(questionId);
      if (question && showsOther({ ...form, questions }, question) && text) next[questionId] = text;
    }
    if (Object.keys(next).length) other[memberId] = next;
  }
  const named: NamedForm = { ...form, questions, answers };
  if (Object.keys(other).length) named.other = other;
  else delete named.other;
  return named;
}

function gridPick(question: GridQuestion, value: unknown): Record<string, string> | null {
  const cells = gridValue(question, value);
  if (!cells || !Object.keys(cells).length) return null;
  return cells;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!plain(value)) return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sorted(item)]));
}
