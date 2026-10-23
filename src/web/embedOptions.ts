import { dismissOn } from "./dismiss.ts";
import { defaultOf, durationParts, durationWords, numberRule, shownValue, SWATCHES, valueOf } from "../core/embedOptions.ts";
import { clearKey, isDuration, placeProblems, problemText, readConfig, removeWord, renameKey, schemaFor, setKey, settableKeys, type EmbedKey, type EmbedSchema, type Stray } from "../core/embedSchema.ts";
import type { Embed, EmbedField, EmbedOptions } from "./plugin-api.ts";

/** What an embed's settings panel shows, read again each time the note says something else of the embed. */
export interface Options {
  title: string;
  fields: readonly EmbedField[];
  /** Words no key takes, each a row to remove or rename. */
  strays: readonly Stray[];
  /** What is wrong with what the note writes, each a sentence: said on the embed and its settings button. */
  problems: readonly string[];
  /** What of that has no field or row of its own, shown above the fields. */
  loose: readonly string[];
  /** Sets a field. A string is why the value wasn't taken. */
  set(id: string, value: string): string | void;
  /** Takes a field out of what the note writes. A string is why it can't be. */
  clear(id: string): string | void;
  /** Takes a stray word out of what the note writes, where it is. */
  remove(stray: Stray): string | void;
  /** Gives a key=value word the key it was likely meant to have, keeping its value. */
  rename(from: string, to: string): string | void;
}

const GAP = 4;
const EDGE = 8;
const MIN_WIDTH = 360;

let shown: { anchor: HTMLElement; panel: HTMLElement; read: () => Options | null; close: () => void; place: () => void } | null = null;

type Said = (why: string | void) => void;

/** How many fields have been made, which gives each its own id. */
let made = 0;

/** The button beside a field that takes it out of the note, there for as long as the note writes it. */
function clearing(field: EmbedField, clear: (id: string) => void): HTMLElement[] {
  if (field.written === undefined) return [];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "embed-option-clear";
  button.dataset.clear = field.id;
  button.textContent = "×";
  button.title = "Clear";
  button.setAttribute("aria-label", `Clear ${field.label}`);
  button.addEventListener("click", () => clear(field.id));
  return [button];
}

const PARTS = [
  // Far past any timer: a timer reads a length of any number of hours, and the field shows it as it is.
  { name: "Hours", unit: "h", max: 9999 },
  { name: "Minutes", unit: "m", max: 59 },
  { name: "Seconds", unit: "s", max: 59 },
] as const;

/** How far the wheel turns for one step: about one notch of a mouse's wheel, and a short stroke on a trackpad. */
const WHEEL_STEP = 50;
/** How long the wheel and the arrow keys are still before their steps are set, so a flick of a trackpad is one change to the note. */
const STILL_MS = 300;

/** Sets a field, and says why where the value wasn't taken. */
type SetField = (id: string, value: string) => string | void;

/**
 * A duration's field: hours, minutes and seconds, each typed or stepped with the arrow keys or the
 * wheel while the pointer is over it. Steps show at once and are set once they pause. What is typed
 * is set on Enter or when the keyboard leaves the field, each part kept within its range. A duration
 * that isn't taken is shown as the note has it again.
 */
function durationOf(field: EmbedField, set: SetField, said: Said, clear: (id: string) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "embed-option";
  const name = row.appendChild(document.createElement("span"));
  name.className = "embed-option-label";
  name.id = `embed-option-${++made}`;
  name.textContent = field.label;
  const group = row.appendChild(document.createElement("span"));
  group.className = "embed-option-duration";
  group.setAttribute("role", "group");
  group.setAttribute("aria-labelledby", name.id);
  group.dataset.control = field.id;
  const inputs = PARTS.map(({ name, unit, max }) => {
    const part = group.appendChild(document.createElement("label"));
    part.className = "embed-option-part";
    const input = part.appendChild(document.createElement("input"));
    input.type = "number";
    input.min = "0";
    input.max = String(max);
    input.step = "1";
    input.dataset.field = field.id;
    input.dataset.part = unit;
    input.setAttribute("aria-label", name);
    part.append(unit);
    return input;
  });
  const asWritten = () => inputs.forEach((input) => (input.value = input.dataset.was ?? "0"));
  let stepped: ReturnType<typeof setTimeout> | undefined;
  const commit = () => {
    clearTimeout(stepped);
    const parts = inputs.map((input, n) => Math.min(PARTS[n]!.max, Math.max(0, Math.floor(Number(input.value) || 0))));
    inputs.forEach((input, n) => (input.value = String(parts[n])));
    const [h, m, s] = parts as [number, number, number];
    const seconds = (h * 60 + m) * 60 + s;
    // The same duration again is set only where the note has it wrong, as out of its place, which setting it puts right.
    if (inputs.every((input) => input.value === input.dataset.was) && (!seconds || group.getAttribute("aria-invalid") !== "true")) return;
    if (!seconds) said(`${field.label} can't be zero.`);
    if (!seconds || set(field.id, durationWords(seconds))) asWritten();
  };
  const step = (input: HTMLInputElement, by: number) => {
    const max = Number(input.max);
    input.value = String(Math.min(max, Math.max(0, (Math.floor(Number(input.value)) || 0) + by)));
    clearTimeout(stepped);
    stepped = setTimeout(commit, STILL_MS);
  };
  for (const input of inputs) {
    let turned = 0;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        clearTimeout(stepped);
        asWritten();
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        step(input, e.key === "ArrowUp" ? 1 : -1);
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      commit();
    });
    // Only while the pointer is over it, so the page scrolls as ever everywhere else.
    input.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY === 0) return;
        e.preventDefault();
        turned = Math.sign(turned) === -Math.sign(e.deltaY) ? e.deltaY : turned + e.deltaY;
        if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(turned) < WHEEL_STEP) return;
        step(input, turned < 0 ? 1 : -1);
        turned = 0;
      },
      { passive: false },
    );
    input.addEventListener("pointerleave", () => (turned = 0));
  }
  // Taken as typed when the keyboard leaves the duration, and not on going from one part to the next.
  group.addEventListener("focusout", (e) => group.isConnected && !inputs.includes(e.relatedTarget as HTMLInputElement) && commit());
  row.append(...clearing(field, clear));
  return row;
}

/**
 * One field's elements, with a line under it for what is wrong with what the note writes for it.
 * They ask for the options as they are when used, so they stay good while the note changes under them.
 */
function fieldOf(field: EmbedField, set: SetField, said: Said, clear: (id: string) => void): HTMLElement {
  const row = controlOf(field, set, said, clear);
  const error = row.appendChild(document.createElement("p"));
  error.className = "embed-option-error embed-option-field-error";
  error.id = `embed-option-${++made}-error`;
  error.dataset.error = field.id;
  error.hidden = true;
  return row;
}

function controlOf(field: EmbedField, set: SetField, said: Said, clear: (id: string) => void): HTMLElement {
  if (field.kind === "duration") return durationOf(field, set, said, clear);
  if (field.kind === "choice") {
    const group = document.createElement("div");
    group.className = "embed-option";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", field.label);
    group.dataset.control = field.id;
    const label = group.appendChild(document.createElement("span"));
    label.className = "embed-option-label";
    label.textContent = field.label;
    const choices = group.appendChild(document.createElement("span"));
    choices.className = "embed-option-choices";
    for (const choice of field.choices) {
      const pick = choices.appendChild(document.createElement("button"));
      pick.type = "button";
      pick.className = "embed-option-choice";
      pick.dataset.field = `${field.id}=${choice.value}`;
      pick.setAttribute("role", "radio");
      if (choice.swatch === undefined) pick.textContent = choice.label;
      else {
        pick.classList.add("swatch");
        pick.title = choice.label;
        pick.setAttribute("aria-label", choice.label);
        if (choice.swatch) pick.dataset.colour = choice.swatch;
      }
      pick.addEventListener("click", () => set(field.id, choice.value));
    }
    group.append(...clearing(field, clear));
    return group;
  }
  // The Clear button is beside the field and not in its label, so the field is named by its label alone.
  const row = document.createElement("div");
  row.className = "embed-option";
  const name = row.appendChild(document.createElement("label"));
  name.className = "embed-option-label";
  name.textContent = field.label;
  const input = row.appendChild(document.createElement("input"));
  input.id = name.htmlFor = `embed-option-${++made}`;
  input.type = "text";
  input.dataset.field = field.id;
  input.dataset.control = field.id;
  input.spellcheck = false;
  if (field.placeholder) input.placeholder = field.placeholder;
  /** `data-was` is the value the note has, so what is typed is set once, however the keyboard leaves the field. */
  const commit = () => input.value !== input.dataset.was && set(field.id, input.value);
  input.addEventListener("keydown", (e) => {
    // Escape closes the panel, which takes what is typed in it: what was typed is given up first.
    if (e.key === "Escape") input.value = input.dataset.was ?? "";
    if (e.key !== "Enter") return;
    e.preventDefault();
    commit();
  });
  input.addEventListener("blur", () => input.isConnected && commit());
  row.append(...clearing(field, clear));
  if (field.hint) {
    const hint = row.appendChild(document.createElement("span"));
    hint.className = "embed-option-hint";
    hint.id = `${input.id}-hint`;
    hint.textContent = field.hint;
    input.dataset.hint = hint.id;
  }
  return row;
}

/** A row for a word no key takes: what it is, and a button that takes it out, and one that renames it to the key it was likely meant to be. */
function strayOf(stray: Stray, said: Said, read: () => Options | null): HTMLElement {
  const row = document.createElement("div");
  row.className = "embed-option embed-option-stray";
  row.setAttribute("role", "group");
  const text = row.appendChild(document.createElement("span"));
  text.className = "embed-option-stray-text";
  text.id = `embed-option-${++made}`;
  text.textContent = stray.text;
  row.setAttribute("aria-labelledby", text.id);
  const actions = row.appendChild(document.createElement("span"));
  actions.className = "embed-option-choices";
  const action = (label: string, run: () => string | void) => {
    const button = actions.appendChild(document.createElement("button"));
    button.type = "button";
    button.className = "embed-option-choice";
    button.textContent = label;
    button.addEventListener("click", () => said(run()));
  };
  const { rename } = stray;
  if (rename) action(`Rename to ${rename.to}`, () => read()?.rename(rename.from, rename.to));
  action("Remove", () => read()?.remove(stray));
  return row;
}

/** What says which elements a panel needs. While it is the same, the elements stay and only their values change. */
const shapeOf = ({ fields, strays }: Options) => JSON.stringify([fields.map((f) => [f.id, f.kind, f.label, f.written === undefined, f.kind === "choice" ? f.choices : f.kind === "text" ? [f.placeholder, f.hint] : []]), strays]);

/**
 * Shows the options in the panel. The elements are made once for a set of fields and then only
 * given their values, so a field isn't taken from under the keyboard or the pointer when setting
 * another one changes the note.
 */
function fill(panel: HTMLElement, options: Options, read: () => Options | null) {
  const shape = shapeOf(options);
  if (panel.dataset.shape !== shape) {
    panel.dataset.shape = shape;
    const error = document.createElement("p");
    error.className = "embed-option-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const said: Said = (why) => {
      error.textContent = why ?? "";
      error.hidden = !why;
    };
    const set: SetField = (id, value) => {
      const why = read()?.set(id, value);
      said(why);
      return why;
    };
    const clear = (id: string) => said(read()?.clear(id));
    const wrong = document.createElement("div");
    wrong.className = "embed-option-problems";
    panel.replaceChildren(wrong, ...options.fields.map((field) => fieldOf(field, set, said, clear)), ...options.strays.map((stray) => strayOf(stray, said, read)), error);
  }
  const wrong = panel.querySelector<HTMLElement>(".embed-option-problems")!;
  if (wrong.textContent !== options.loose.join("")) {
    wrong.replaceChildren(
      ...options.loose.map((problem) => {
        const line = document.createElement("p");
        line.className = "embed-option-error";
        line.textContent = problem;
        return line;
      }),
    );
  }
  wrong.hidden = !options.loose.length;
  panel.setAttribute("aria-label", `Settings for ${options.title}`);
  for (const field of options.fields) {
    const clear = panel.querySelector<HTMLElement>(`[data-clear="${CSS.escape(field.id)}"]`);
    if (clear) clear.hidden = !field.written;
    const error = panel.querySelector<HTMLElement>(`[data-error="${CSS.escape(field.id)}"]`)!;
    error.textContent = field.error ?? "";
    error.hidden = !field.error;
    for (const control of panel.querySelectorAll<HTMLElement>(`[data-control="${CSS.escape(field.id)}"]`)) {
      if (field.error) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
      // What is wrong takes the hint's place, as it most often says the same.
      const hint = control.dataset.hint ? document.getElementById(control.dataset.hint) : null;
      if (hint) hint.hidden = !!field.error;
      const describedBy = (field.error ? [error.id] : [control.dataset.hint]).filter(Boolean).join(" ");
      if (describedBy) control.setAttribute("aria-describedby", describedBy);
      else control.removeAttribute("aria-describedby");
    }
    for (const el of panel.querySelectorAll<HTMLElement>("[data-field]")) {
      if (field.kind === "choice" && el.dataset.field?.startsWith(`${field.id}=`)) el.setAttribute("aria-checked", String(el.dataset.field === `${field.id}=${field.value}`));
      if (field.kind === "duration" && el.dataset.field === field.id && el instanceof HTMLInputElement) {
        const parts = durationParts(field.value) ?? [0, 0, 0];
        const part = String(parts[PARTS.findIndex((p) => p.unit === el.dataset.part)]);
        if (el !== document.activeElement || el.value === el.dataset.was) el.value = part;
        el.dataset.was = part;
      }
      if (field.kind !== "text" || el.dataset.field !== field.id || !(el instanceof HTMLInputElement)) continue;
      // What is being typed stays as typed until it is set.
      if (el !== document.activeElement || el.value === el.dataset.was) el.value = field.value;
      el.dataset.was = field.value;
    }
  }
}

/**
 * Opens an embed's options beneath `under`, the embed's card, at least as wide as it, laid over the app so
 * nothing in the note moves, or closes them if they are open from `anchor`, the options button.
 * One is open at a time. It closes on Escape, on a press outside it, and when `read` has nothing to
 * give, as when the embed is gone or has no options left.
 */
export function toggleOptions(anchor: HTMLElement, under: HTMLElement, read: () => Options | null): void {
  const again = shown?.anchor === anchor;
  shown?.close();
  const options = again ? null : read();
  if (!options) return;

  const panel = document.body.appendChild(document.createElement("div"));
  panel.className = "chip-popover embed-options-panel";
  panel.setAttribute("role", "dialog");
  const place = () => {
    if (!anchor.isConnected) return close();
    const [card, button] = [under.getBoundingClientRect(), anchor.getBoundingClientRect()];
    // Under a card in a line of text, beneath the whole line, which may wrap onto rows below the card's.
    const foot = (under.closest(".cm-line")?.getBoundingClientRect() ?? card).bottom;
    // As wide as the card it is under, as v1's options were, and never so narrow that a hint wraps into a column, as under a timer in a line of text.
    panel.style.width = `${Math.min(Math.max(card.width, MIN_WIDTH), innerWidth - 2 * EDGE)}px`;
    const { width, height } = panel.getBoundingClientRect();
    const fits = (top: number) => top >= EDGE && top + height <= innerHeight - EDGE;
    // Beneath the card where that is in the window. A card taller than the window has its foot out of sight, and the options are then beneath their button.
    const [at, top] = fits(foot + GAP) ? [card.left, foot + GAP] : [button.right - width, fits(button.bottom + GAP) ? button.bottom + GAP : button.top - GAP - height];
    panel.style.left = `${Math.max(EDGE, Math.min(at, innerWidth - EDGE - width))}px`;
    panel.style.top = `${Math.max(EDGE, Math.min(top, innerHeight - EDGE - height))}px`;
  };
  const undismiss = dismissOn(() => close(), () => [panel, anchor]);
  const close = () => {
    if (shown?.close !== close) return;
    shown = null;
    undismiss();
    removeEventListener("scroll", place, true);
    removeEventListener("resize", place);
    const within = panel.contains(document.activeElement);
    // A field being typed in is taken as it stands, as it is when the keyboard leaves it any other way.
    if (within) (document.activeElement as HTMLElement).blur();
    panel.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (within && anchor.isConnected) anchor.focus();
  };
  shown = { anchor, panel, read, close, place };
  anchor.setAttribute("aria-expanded", "true");
  fill(panel, options, read);
  place();
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  panel.querySelector<HTMLElement>("input, button")?.focus();
}

/** Shows `options`, which are what the note says now, in the settings open from `anchor`, if any are, and closes them if the embed has nothing left to show. */
export function refreshOptions(anchor: HTMLElement, options: Options | null): void {
  if (shown?.anchor !== anchor) return;
  if (!options || (!options.fields.length && !options.problems.length)) return shown.close();
  fill(shown.panel, options, shown.read);
  shown.place();
}

export function closeOptions(anchor: HTMLElement): void {
  if (shown?.anchor === anchor) shown.close();
}

/** What each settings button opens now: the settings it reads, beneath what. */
const opening = new WeakMap<HTMLElement, { under: () => HTMLElement; read: () => Options | null }>();

/**
 * Fits the settings button in `parent` to `options`, an embed's settings as the note writes it now:
 * made with `className` the first time, and taken away with its panel where there is nothing to set,
 * as for a member who can't change the note. A press opens what `open` reads then beneath its `under`.
 */
export function fitSettingsButton(parent: HTMLElement, className: string, options: Options | null, open: { under: () => HTMLElement; read: () => Options | null }): void {
  let button = parent.querySelector<HTMLButtonElement>(":scope > .embed-options");
  if (!options?.fields.length && !options?.problems.length) {
    if (button) closeOptions(button);
    if (button) markProblems(button, "", []);
    button?.remove();
    return;
  }
  if (!button) {
    const made = (button = parent.appendChild(document.createElement("button")));
    made.type = "button";
    made.className = className;
    made.setAttribute("aria-haspopup", "dialog");
    made.setAttribute("aria-expanded", "false");
    // What it reads is asked for each time, as the embed is drawn again for each change to what the note says of it.
    made.addEventListener("click", () => toggleOptions(made, opening.get(made)!.under(), () => opening.get(made)?.read() ?? null));
  }
  opening.set(button, open);
  markProblems(button, `Settings for ${options.title}`, options.problems);
  refreshOptions(button, options);
}

const HINTS: Partial<Record<EmbedKey["type"], string>> = { date: "A day, like 2026-10-16. Empty for none." };

/**
 * The field the host draws for a key, holding `text`, what the note writes for it, if anything. A
 * field typed in shows the key's default where the note writes nothing. A key the embed can't do
 * without can't be cleared.
 */
function fieldFor(key: EmbedKey, text: string | undefined): EmbedField {
  const { id, label } = key;
  const written = key.required || key.keep ? undefined : text !== undefined;
  const picked = () => {
    if (key.type === "word") return text ?? "";
    const read = text === undefined ? null : valueOf(key, text);
    return shownValue(key, read && "value" in read ? read.value : defaultOf(key));
  };
  if (isDuration(key)) return { id, label, kind: "duration", value: text ?? String(key.default), written };
  switch (key.type) {
    case "toggle":
      return { id, label, kind: "choice", value: picked(), written, choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }] };
    case "choice":
      return { id, label, kind: "choice", value: picked(), written, choices: key.values.map((v) => ({ value: v, label: v })) };
    case "colour":
      return { id, label, kind: "choice", value: picked(), written, choices: (["", ...SWATCHES] as const).map((swatch) => ({ value: swatch, label: swatch ? swatch.charAt(0).toUpperCase() + swatch.slice(1) : "No colour", swatch })) };
    case "number":
      return { id, label, kind: "text", value: text ?? "", written, placeholder: String(defaultOf(key)), hint: numberRule(key) };
    default:
      return { id, label, kind: "text", value: text ?? "", written, placeholder: String(key.default) || undefined, hint: key.type === "word" ? key.rule : HINTS[key.type] };
  }
}

/** A field for each key of a schema a member sets, in its order, and one for its rest. */
function schemaFields(schema: EmbedSchema, config: string): EmbedField[] {
  const reading = readConfig(schema, config);
  const { values } = reading;
  const { byKey } = placeProblems(schema, reading);
  const fields = settableKeys(schema).map((key): EmbedField => ({ ...fieldFor(key, values[key.id]), ...(byKey[key.id] && { error: byKey[key.id] }) }));
  if (schema.rest) fields.push({ id: schema.rest.id, label: schema.rest.label, kind: "text", value: values[schema.rest.id] ?? "", written: values[schema.rest.id] !== undefined });
  return fields;
}

type Note = { config: string; body: string };

/** What a member sets of an embed: each key its schema says its config takes, then the fields of the embed's own. */
export interface Settings {
  fields(written: Note): readonly EmbedField[];
  /** What is wrong with the config, against the embed's schema. */
  problems(written: Note): string[];
  /** Where the panel shows each of those: under a field (in `fields`), as a row of its own, or above the fields. */
  placing(written: Note): { strays: Stray[]; loose: string[] };
  set(written: Note, id: string, value: string): { config?: string; body?: string } | string;
  clear(written: Note, id: string): { config?: string } | string;
  remove(written: Note, stray: Stray): { config: string };
  rename(written: Note, from: string, to: string): { config: string } | string;
}

/** An embed's settings, or none for one with no schema and no fields of its own. Options declared as data are its schema. */
export function settingsOf(embed: Pick<Embed, "name" | "options">): Settings | undefined {
  const declared = Array.isArray(embed.options) ? embed.options : undefined;
  const own = declared ? undefined : (embed.options as EmbedOptions | undefined);
  const schema = schemaFor(embed.name, declared);
  if (!schema && !own) return undefined;
  const ofSchema = (id: string) => !!schema && (schema.keys.some((k) => k.id === id) || schema.rest?.id === id);
  const ownFields = (written: Note) => {
    try {
      return own?.fields(written) ?? [];
    } catch {
      return [];
    }
  };
  return {
    fields: (written) => [...(schema ? schemaFields(schema, written.config) : []), ...ownFields(written)],
    problems: (written) => (schema ? readConfig(schema, written.config).problems.map((p) => problemText(schema, p)) : []),
    placing: (written) => {
      const { strays, rest } = schema ? placeProblems(schema, readConfig(schema, written.config)) : { strays: [], rest: [] };
      return { strays, loose: rest };
    },
    remove: (written, { word, at }) => ({ config: removeWord(written.config, word, at) }),
    rename: (written, from, to) => (schema ? renameKey(schema, written.config, from, to) : `No setting ${to}.`),
    set: (written, id, value) => (ofSchema(id) ? setKey(schema!, written.config, id, value) : own ? own.set(written, id, value) : `No setting ${id}.`),
    clear: (written, id) => (ofSchema(id) ? clearKey(schema!, written.config, id) : `No setting ${id}.`),
  };
}

/** The panel's settings for an embed as the note writes it now, each set and cleared by rewriting it there. */
export function optionsOn(title: string, settings: Settings, now: Note, rewrite: (next: { config?: string; body?: string }) => void): Options {
  const written = { config: now.config, body: now.body };
  const apply = (next: () => { config?: string; body?: string } | string) => {
    try {
      const done = next();
      if (typeof done === "string") return done;
      rewrite(done);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  return {
    title,
    fields: settings.fields(written),
    problems: settings.problems(written),
    ...settings.placing(written),
    set: (id, value) => apply(() => settings.set(written, id, value)),
    clear: (id) => apply(() => settings.clear(written, id)),
    remove: (stray) => apply(() => settings.remove(written, stray)),
    rename: (from, to) => apply(() => settings.rename(written, from, to)),
  };
}

/**
 * Names a settings button, and puts a warning beside it for what is wrong with its embed, or takes
 * the warning away. The button says what is wrong to a screen reader, and the warning on hover; a
 * press on the warning opens the settings, which say it too.
 */
function markProblems(button: HTMLElement, title: string, problems: readonly string[]): void {
  button.setAttribute("aria-label", title);
  button.title = title;
  let mark = button.parentElement!.querySelector<HTMLElement>(":scope > .embed-warning");
  if (!problems.length) {
    button.removeAttribute("aria-description");
    mark?.remove();
    return;
  }
  button.setAttribute("aria-description", problems.join(" "));
  if (!mark) {
    mark = button.parentElement!.insertBefore(document.createElement("span"), button);
    mark.className = button.classList.contains("embed-options-corner") ? "embed-warning embed-warning-corner" : "embed-warning";
    mark.setAttribute("aria-hidden", "true");
    mark.addEventListener("click", () => button.click());
  }
  mark.title = problems.join(" ");
}
