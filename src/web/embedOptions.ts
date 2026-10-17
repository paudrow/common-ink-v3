import { dismissOn } from "./dismiss.ts";
import { defaultOf, numberRule, optionValues, setOption, shownValue, SWATCHES, type DeclaredOption } from "../core/embedOptions.ts";
import type { EmbedField, EmbedOptions } from "./plugin-api.ts";

/** What an embed's options panel shows, read again each time the note says something else of the embed. */
export interface Options {
  title: string;
  fields: readonly EmbedField[];
  /** Sets a field. A string is why the value wasn't taken. */
  set(id: string, value: string): string | void;
}

const GAP = 4;
const EDGE = 8;

let shown: { anchor: HTMLElement; panel: HTMLElement; read: () => Options | null; close: () => void; place: () => void } | null = null;

type Said = (why: string | void) => void;

/** One field's elements. They ask for the options as they are when used, so they stay good while the note changes under them. */
function fieldOf(field: EmbedField, set: (id: string, value: string) => void): HTMLElement {
  if (field.kind === "choice") {
    const group = document.createElement("div");
    group.className = "embed-option";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", field.label);
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
    return group;
  }
  const label = document.createElement("label");
  label.className = "embed-option";
  const name = label.appendChild(document.createElement("span"));
  name.className = "embed-option-label";
  name.textContent = field.label;
  const input = label.appendChild(document.createElement("input"));
  input.type = "text";
  input.dataset.field = field.id;
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
  if (field.hint) {
    const hint = label.appendChild(document.createElement("span"));
    hint.className = "embed-option-hint";
    hint.textContent = field.hint;
  }
  return label;
}

/** What says which elements a panel needs. While it is the same, the elements stay and only their values change. */
const shapeOf = (fields: readonly EmbedField[]) => JSON.stringify(fields.map((f) => [f.id, f.kind, f.label, f.kind === "choice" ? f.choices : [f.placeholder, f.hint]]));

/**
 * Shows the options in the panel. The elements are made once for a set of fields and then only
 * given their values, so a field isn't taken from under the keyboard or the pointer when setting
 * another one changes the note.
 */
function fill(panel: HTMLElement, options: Options, read: () => Options | null) {
  const shape = shapeOf(options.fields);
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
    const set = (id: string, value: string) => said(read()?.set(id, value));
    panel.replaceChildren(...options.fields.map((field) => fieldOf(field, set)), error);
  }
  panel.setAttribute("aria-label", `Options for ${options.title}`);
  for (const field of options.fields) {
    for (const el of panel.querySelectorAll<HTMLElement>("[data-field]")) {
      if (field.kind === "choice" && el.dataset.field?.startsWith(`${field.id}=`)) el.setAttribute("aria-checked", String(el.dataset.field === `${field.id}=${field.value}`));
      if (field.kind !== "text" || el.dataset.field !== field.id || !(el instanceof HTMLInputElement)) continue;
      // What is being typed stays as typed until it is set.
      if (el !== document.activeElement || el.value === el.dataset.was) el.value = field.value;
      el.dataset.was = field.value;
    }
  }
}

/**
 * Opens an embed's options beneath `under`, the embed's card, as wide as it, laid over the app so
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
    // As wide as the card it is under, as v1's options were, with a row for each option.
    panel.style.width = `${Math.min(card.width, innerWidth - 2 * EDGE)}px`;
    const { width, height } = panel.getBoundingClientRect();
    const fits = (top: number) => top >= EDGE && top + height <= innerHeight - EDGE;
    // Beneath the card where that is in the window. A card taller than the window has its foot out of sight, and the options are then beneath their button.
    const [at, top] = fits(card.bottom + GAP) ? [card.left, card.bottom + GAP] : [button.right - width, fits(button.bottom + GAP) ? button.bottom + GAP : button.top - GAP - height];
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

/** Shows `options`, which are what the note says now, in the options open from `anchor`, if any are, and closes them if the embed has none left. */
export function refreshOptions(anchor: HTMLElement, options: Options | null): void {
  if (shown?.anchor !== anchor) return;
  if (!options || !options.fields.length) return shown.close();
  fill(shown.panel, options, shown.read);
  shown.place();
}

export function closeOptions(anchor: HTMLElement): void {
  if (shown?.anchor === anchor) shown.close();
}

const HINTS: Partial<Record<DeclaredOption["type"], string>> = { duration: "Like 25m, 1h30m or 90s.", date: "A day, like 2026-10-16. Empty for none." };

/** The field the host draws for a declared option, holding `value`. */
function fieldFor(option: DeclaredOption, value: string): EmbedField {
  const { id, label } = option;
  switch (option.type) {
    case "toggle":
      return { id, label, kind: "choice", value, choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }] };
    case "choice":
      return { id, label, kind: "choice", value, choices: option.values.map((v) => ({ value: v, label: v })) };
    case "colour":
      return { id, label, kind: "choice", value, choices: (["", ...SWATCHES] as const).map((swatch) => ({ value: swatch, label: swatch ? swatch.charAt(0).toUpperCase() + swatch.slice(1) : "No colour", swatch })) };
    case "number":
      return { id, label, kind: "text", value, placeholder: String(defaultOf(option)), hint: numberRule(option) };
    default:
      return { id, label, kind: "text", value, placeholder: String(defaultOf(option)) || undefined, hint: HINTS[option.type] };
  }
}

/** Options declared as data, as the host reads, draws and writes them: each is an `id=value` word of the config. */
export function declared(options: readonly DeclaredOption[]): EmbedOptions {
  return {
    fields({ config }) {
      const values = optionValues(options, config);
      return options.map((option) => fieldFor(option, shownValue(option, values[option.id] ?? defaultOf(option))));
    },
    set: ({ config }, id, value) => setOption(options, config, id, value),
  };
}
