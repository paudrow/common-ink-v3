import { z } from "zod";

export type Form = NamedForm | AnonymousForm;

export interface NamedForm extends Base {
  anonymous?: false;
  /** `each` keeps every member's choices. `one` keeps only the member who edited last. Absent means `each`. */
  mode?: "each" | "one";
  answers: Record<string, MemberAnswers>;
}

export interface AnonymousForm extends Base {
  anonymous: true;
  /** Counts by question id, then by tally key. */
  tallies: Record<string, Record<string, number>>;
  /** Text answers by question id, with no author. */
  texts: Record<string, string[]>;
  /** Members who have cast, in the order they did. */
  voted: string[];
}

interface Base {
  /** When present and non-empty, only these members may answer. */
  ask?: string[];
  closed?: boolean;
  questions: Question[];
}

export type MemberAnswers = Record<string, AnswerValue>;

export type AnswerValue = string | string[] | number | Record<string, string>;

export type Question = ShortQuestion | OneQuestion | SeveralQuestion | ScaleQuestion | GridQuestion | ImageQuestion;

interface QuestionBase {
  id: string;
  prompt: string;
}

export interface ShortQuestion extends QuestionBase {
  type: "short" | "paragraph";
  required?: boolean;
}

export interface OneQuestion extends QuestionBase {
  type: "one";
  options: string[];
  required?: boolean;
}

export interface SeveralQuestion extends QuestionBase {
  type: "several";
  options: string[];
  required?: boolean;
}

export interface ScaleQuestion extends QuestionBase {
  type: "scale";
  minLabel?: string;
  maxLabel?: string;
}

export interface GridQuestion extends QuestionBase {
  type: "grid";
  rows: { id: string; label: string }[];
  cols: { id: string; label: string }[];
}

export interface ImageQuestion extends QuestionBase {
  type: "image";
  options: { id: string; label: string; src?: string }[];
}

const id = z.string().min(1);
const labelled = z.object({ id, label: z.string() }).passthrough();
const text = (type: "short" | "paragraph") => z.object({ id, type: z.literal(type), prompt: z.string(), required: z.boolean().optional() }).passthrough();
const one = z.object({ id, type: z.literal("one"), prompt: z.string(), options: z.array(z.string()), required: z.boolean().optional() }).passthrough();
const several = z.object({ id, type: z.literal("several"), prompt: z.string(), options: z.array(z.string()), required: z.boolean().optional() }).passthrough();
const scale = z.object({ id, type: z.literal("scale"), prompt: z.string(), minLabel: z.string().optional(), maxLabel: z.string().optional() }).passthrough();
const grid = z.object({ id, type: z.literal("grid"), prompt: z.string(), rows: z.array(labelled), cols: z.array(labelled) }).passthrough();
const image = z.object({ id, type: z.literal("image"), prompt: z.string(), options: z.array(z.object({ id, label: z.string(), src: z.string().optional() }).passthrough()) }).passthrough();
const question = z.discriminatedUnion("type", [text("short"), text("paragraph"), one, several, scale, grid, image]);

const answerValue = z.union([z.string(), z.number(), z.array(z.string()), z.record(z.string(), z.string())]);
const shared = { ask: z.array(z.string()).optional(), closed: z.boolean().optional(), questions: z.array(question) };

const namedSchema = z.object({ ...shared, anonymous: z.literal(false).optional(), mode: z.enum(["each", "one"]).optional(), answers: z.record(z.string(), z.record(z.string(), answerValue)).default({}) }).passthrough();
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
  const prior = form.mode === "one" ? (Object.values(form.answers)[0] ?? {}) : (form.answers[memberId] ?? {});
  const mine: MemberAnswers = { ...prior };
  const applied = apply(question, mine[questionId], value);
  if (applied === "same") return form;
  if (applied === "clear") delete mine[questionId];
  else mine[questionId] = applied;
  const answers = form.mode === "one" ? {} : { ...form.answers };
  if (Object.keys(mine).length) answers[memberId] = mine;
  else delete answers[memberId];
  return { ...form, answers };
}

/**
 * Adds `draft` into the tallies and texts and records the member. A member already in `voted`
 * gets the same form back: their choice was not kept, so it cannot be changed.
 */
export function castVote(form: AnonymousForm, memberId: string, draft: MemberAnswers): AnonymousForm {
  if (!allowed(form, memberId) || form.voted.includes(memberId)) return form;
  const tallies = Object.fromEntries(Object.entries(form.tallies).map(([key, counts]) => [key, { ...counts }]));
  const texts = Object.fromEntries(Object.entries(form.texts).map(([key, lines]) => [key, [...lines]]));
  for (const [questionId, value] of Object.entries(draft)) {
    const question = form.questions.find((item) => item.id === questionId);
    if (question) count(question, value, tallies, texts);
  }
  return { ...form, tallies, texts, voted: [...form.voted, memberId] };
}

function allowed(form: Form, memberId: string): boolean {
  if (form.closed) return false;
  return !form.ask?.length || form.ask.includes(memberId);
}

function coherent(form: Form, raw: Record<string, unknown>): boolean {
  if (form.anonymous) {
    if ("answers" in raw || "mode" in raw) return false;
  } else if ("tallies" in raw || "texts" in raw || "voted" in raw) return false;
  if (!wellFormed(form.questions)) return false;
  const byId = new Map(form.questions.map((question) => [question.id, question]));
  if (form.anonymous) {
    return known(byId, form.tallies) && known(byId, form.texts);
  }
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
      return typeof value === "string" && question.options.includes(value);
    case "several":
      return Array.isArray(value) && value.every((option) => question.options.includes(option));
    case "scale":
      return scalePoint(value);
    case "grid":
      return gridValue(question, value) !== null;
    case "image":
      return typeof value === "string" && question.options.some((option) => option.id === value);
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
    case "image": {
      const ok = question.type === "one" ? typeof value === "string" && question.options.includes(value) : typeof value === "string" && question.options.some((option) => option.id === value);
      if (!ok || typeof value !== "string") return "same";
      return value === current ? "clear" : value;
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
      if (typeof value === "string" && question.options.includes(value)) bump(value);
      return;
    case "several":
      if (Array.isArray(value)) for (const option of value) if (question.options.includes(option)) bump(option);
      return;
    case "scale":
      if (scalePoint(value)) bump(String(value));
      return;
    case "grid": {
      const cells = gridValue(question, value);
      if (cells) for (const [row, col] of Object.entries(cells)) bump(`${row}:${col}`);
      return;
    }
    case "image":
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
