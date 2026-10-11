import { dismissOn } from "./dismiss.ts";
import type { EmbedField } from "./plugin-api.ts";

/** What an embed's options panel shows, read again each time the note says something else of the embed. */
export interface Options {
  title: string;
  fields: readonly EmbedField[];
  /** Sets a field. A string is why the value wasn't taken. */
  set(id: string, value: string): string | void;
  /** Shows the embed as the note writes it, with the cursor in it. */
  edit(): void;
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
function fill(panel: HTMLElement, options: Options, read: () => Options | null, close: () => void) {
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
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "embed-option-edit";
    edit.textContent = "Edit as markdown";
    edit.addEventListener("click", () => {
      const now = read();
      close();
      now?.edit();
    });
    panel.replaceChildren(...options.fields.map((field) => fieldOf(field, set)), error, edit);
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
 * Opens an embed's options under its options button, laid over the app so nothing in the note moves,
 * or closes them if they are open from that button. One is open at a time. It closes on Escape, on a
 * press outside it, and when `read` has nothing to give, as when the embed is gone.
 */
export function toggleOptions(anchor: HTMLElement, read: () => Options | null): void {
  const again = shown?.anchor === anchor;
  shown?.close();
  const options = again ? null : read();
  if (!options) return;

  const panel = document.body.appendChild(document.createElement("div"));
  panel.className = "chip-popover embed-options-panel";
  panel.setAttribute("role", "dialog");
  const place = () => {
    if (!anchor.isConnected) return close();
    const at = anchor.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const below = at.bottom + GAP;
    const top = below + height > innerHeight - EDGE && at.top - GAP - height >= EDGE ? at.top - GAP - height : below;
    panel.style.left = `${Math.max(EDGE, Math.min(at.right - width, innerWidth - EDGE - width))}px`;
    panel.style.top = `${Math.max(EDGE, top)}px`;
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
  fill(panel, options, read, close);
  place();
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  panel.querySelector<HTMLElement>("input, button")?.focus();
}

/** Shows what the note says now in the options open from `anchor`, if any are, and closes them if the embed has none left. */
export function refreshOptions(anchor: HTMLElement): void {
  if (shown?.anchor !== anchor) return;
  const options = shown.read();
  if (!options) return shown.close();
  fill(shown.panel, options, shown.read, shown.close);
  shown.place();
}

export function closeOptions(anchor: HTMLElement): void {
  if (shown?.anchor === anchor) shown.close();
}
