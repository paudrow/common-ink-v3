import { castVote, parseForm, replaceQuestions, serializeForm, setAnswer, setOther, showsOther, type AnswerValue, type Form, type NamedForm, type Question } from "./form.ts";
import type { Drawn, EmbedOptions, Embedded, Plugin, PluginHost } from "../../plugin-api.ts";

interface Props {
  className?: string;
  textContent?: string;
  type?: string;
  rows?: number;
  value?: string;
  data?: Record<string, string>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, { data, ...props }: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  if (data) Object.assign(el.dataset, data);
  el.append(...children.filter((child) => child !== ""));
  return el;
}

const options: EmbedOptions = {
  fields: ({ body }) => {
    const form = parseForm(body);
    if (!form) return [];
    return [
      { id: "closed", label: "Answers", kind: "choice", value: form.closed ? "closed" : "open", choices: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }] },
      { id: "explain", label: "Other", kind: "choice", value: form.explain === false ? "off" : "on", choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }] },
    ];
  },
  set: ({ body }, id, value) => {
    const form = parseForm(body);
    if (!form) return "This form can't be read.";
    if (id === "explain") {
      const on = value !== "off";
      if ((form.explain !== false) === on) return { body };
      const next = { ...form };
      if (on) delete next.explain;
      else next.explain = false;
      return { body: serializeForm(next) };
    }
    const closed = value === "closed";
    if (Boolean(form.closed) === closed) return { body };
    return { body: serializeForm({ ...form, closed }) };
  },
};

const starts = { body: serializeForm({ questions: [{ id: "q", type: "one", prompt: "Which one?", options: ["Yes", "No"] }], answers: {} }) };

function may(form: Form, memberId: string): boolean {
  if (form.closed) return false;
  if (form.ask?.length && !form.ask.includes(memberId)) return false;
  if (form.anonymous && form.voted.includes(memberId)) return false;
  return true;
}

function nameOf(roster: Map<string, string>, memberId: string, meId: string): string {
  if (memberId === meId) return "You";
  return roster.get(memberId) ?? memberId;
}

function whoChose(form: NamedForm, roster: Map<string, string>, meId: string, questionId: string, exceptMe: boolean, hit: (value: AnswerValue | undefined) => boolean): string {
  const names: string[] = [];
  for (const [memberId, answers] of Object.entries(form.answers)) {
    if (exceptMe && memberId === meId) continue;
    if (hit(answers[questionId])) names.push(nameOf(roster, memberId, meId));
  }
  return names.join(", ");
}

function promptOf(question: Question, index: number): HTMLElement {
  const required = "required" in question && question.required;
  const head = h("div", { className: "form-head" });
  const kind = kindOf(question);
  head.append(
    h("p", { className: "form-prompt" }, h("span", { className: "form-index" }, String(index + 1)), question.prompt, ...(required ? [h("span", { className: "form-note" }, " *")] : [])),
  );
  if (kind) head.append(h("p", { className: "form-kind" }, kind));
  if (question.description) head.append(h("p", { className: "form-note form-desc" }, question.description));
  if (question.picture) head.append(Object.assign(document.createElement("img"), { className: "form-picture", src: question.picture, alt: "" }));
  return head;
}

function kindOf(question: Question): string {
  switch (question.type) {
    case "one":
    case "dropdown":
      return "Pick one";
    case "several":
      return "Pick any";
    case "image":
      return question.several ? "Pick any" : "Pick one";
    case "grid":
      return question.several ? "Any in a row" : "One in a row";
    case "scale":
      return "1 to 5";
    case "date":
      return "A date";
    case "time":
      return "A time";
    default:
      return "";
  }
}

function aside(text: string): Node | string {
  return text ? h("span", { className: "form-note" }, text) : "";
}

function present(host: PluginHost, el: HTMLElement, embed: Embedded): Drawn {
  let current = embed;
  const me = host.app().me;
  let draft: Record<string, AnswerValue> = {};
  let more: Record<string, string> = {};
  let editing = false;
  const roster = new Map<string, string>();
  let asked = false;

  const paint = () => {
    const form = parseForm(current.body);
    if (!form) throw new Error("This form could not be read.");
    const answering = !current.readOnly && may(form, me.id);
    const active = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const focusKey = active?.dataset.focus;
    const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? ([active.selectionStart ?? 0, active.selectionEnd ?? 0] as const) : null;
    const stored = form.anonymous ? undefined : form.mode === "one" ? Object.values(form.answers)[0] : form.answers[me.id];
    const valueOf = (questionId: string): AnswerValue | undefined => (form.anonymous ? (answering ? draft[questionId] : undefined) : stored?.[questionId]);
    const names = (questionId: string, hit: (value: AnswerValue | undefined) => boolean) => (form.anonymous ? "" : whoChose(form, roster, me.id, questionId, answering, hit));

    const root = h("div", { className: "form-embed" });
    if (!current.readOnly) {
      const edit = h("button", { type: "button", className: "form-edit-toggle", textContent: editing ? "Done editing" : "Edit questions", data: { focus: "edit" } });
      edit.addEventListener("click", () => {
        editing = !editing;
        paint();
      });
      root.append(edit);
    }
    if (form.by && !editing) root.append(h("p", { className: "form-kind" }, "Asked by ", form.by));
    const write = (next: Form) => current.update({ body: serializeForm(next) });
    // One member's answers, so a click toggles the draft the way setAnswer toggles a stored choice.
    const draftOf = (): NamedForm => ({ questions: form.questions, answers: { [me.id]: { ...draft } } });
    const choose = (questionId: string, value: AnswerValue) => {
      if (!form.anonymous) {
        const next = setAnswer(form, me.id, questionId, value);
        if (next !== form) write(next);
        return;
      }
      const scratch = draftOf();
      const next = setAnswer(scratch, me.id, questionId, value);
      if (next === scratch) return;
      draft = next.answers[me.id] ?? {};
      paint();
    };
    const typeText = (questionId: string, value: string) => {
      if (!form.anonymous) {
        const next = setAnswer(form, me.id, questionId, value);
        if (next !== form) write(next);
        return;
      }
      const scratch = draftOf();
      const next = setAnswer(scratch, me.id, questionId, value);
      if (next !== scratch) draft = next.answers[me.id] ?? {};
    };
    const typeOther = (questionId: string, value: string) => {
      if (!form.anonymous) {
        const next = setOther(form, me.id, questionId, value);
        if (next !== form) write(next);
        return;
      }
      if (value === "") delete more[questionId];
      else more[questionId] = value;
    };
    const otherOf = (questionId: string) => (form.anonymous ? (more[questionId] ?? "") : (form.mode === "one" ? Object.values(form.other ?? {})[0] : form.other?.[me.id])?.[questionId] ?? "");

    const revise = (questions: Question[]) => {
      const next = replaceQuestions(form, questions);
      if (next !== form) write(next);
    };
    form.questions.forEach((question, index) => {
      root.append(
        editing && !current.readOnly
          ? drawEditor(form, question, index, revise)
          : drawQuestion(form, question, index, answering, roster, me.id, valueOf, names, choose, typeText, otherOf, typeOther),
      );
    });
    if (editing && !current.readOnly) root.append(addQuestion(form, revise));
    if (!editing && !form.anonymous && Object.keys(form.answers).length) {
      const who = Object.keys(form.answers).map((id) => nameOf(roster, id, me.id)).join(", ");
      root.append(h("p", { className: "form-kind" }, "Answered by ", who));
    }

    if (answering && form.anonymous) {
      const cast = h("button", { type: "button", className: "form-cast", textContent: "Cast vote", data: { focus: "cast" } });
      cast.addEventListener("click", () => {
        const next = castVote(form, me.id, draft, more);
        if (next === form) return;
        draft = {};
        more = {};
        write(next);
      });
      root.append(cast);
    } else if (form.anonymous && form.voted.length) {
      root.append(h("p", { className: "form-quote" }, "Voted ", h("span", { className: "form-note" }, form.voted.map((id) => nameOf(roster, id, me.id)).join(", "))));
    }

    if (!editing && !current.readOnly && !form.closed) {
      const done = h("button", { type: "button", className: "form-done", textContent: "Done", data: { focus: "done" } });
      done.addEventListener("click", () => write({ ...form, closed: true }));
      root.append(done);
    } else if (!editing && form.closed) {
      root.append(h("p", { className: "form-kind" }, "Closed"));
    }

    el.replaceChildren(root);
    if (focusKey === undefined) return;
    const next = [...el.querySelectorAll<HTMLElement>("[data-focus]")].find((node) => node.dataset.focus === focusKey);
    next?.focus();
    if (selection && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) next.setSelectionRange(selection[0], selection[1]);
  };

  paint();
  if (!asked) {
    asked = true;
    void host.perform({ type: "member.list" }).then(
      (members) => {
        roster.clear();
        for (const member of members) roster.set(member.personId, member.name);
        if (el.isConnected && parseForm(current.body)) paint();
      },
      () => undefined,
    );
  }
  return { update: (next) => ((current = next), paint()) };
}

function drawQuestion(
  form: Form,
  question: Question,
  index: number,
  answering: boolean,
  roster: Map<string, string>,
  meId: string,
  valueOf: (questionId: string) => AnswerValue | undefined,
  names: (questionId: string, hit: (value: AnswerValue | undefined) => boolean) => string,
  choose: (questionId: string, value: AnswerValue) => void,
  typeText: (questionId: string, value: string) => void,
  otherOf: (questionId: string) => string,
  typeOther: (questionId: string, value: string) => void,
): HTMLElement {
  const block = h("div", { className: "form-q" }, promptOf(question, index));
  const finish = (node: HTMLElement) => {
    if (!showsOther(form, question)) return node;
    if (answering) {
      const line = h("label", { className: "form-other" }, h("span", { className: "form-note", textContent: "Other" }));
      line.append(field("short", otherOf(question.id), `other:${question.id}`, (text) => typeOther(question.id, text), "Other", "Say more"));
      node.append(line);
    }
    node.append(...otherLines(form, question.id, answering, roster, meId));
    return node;
  };
  const value = valueOf(question.id);
  const detail = (key: string, hit: (stored: AnswerValue | undefined) => boolean) => {
    if (form.anonymous && !answering) {
      const n = form.tallies[question.id]?.[key] ?? 0;
      return { label: String(n), on: n > 0 };
    }
    const label = names(question.id, hit);
    return { label, on: label !== "" };
  };

  switch (question.type) {
    case "short":
    case "paragraph": {
      if (answering) block.append(field(question.type, typeof value === "string" ? value : "", `text:${question.id}`, (text) => typeText(question.id, text), question.prompt, question.type === "short" ? "Type an answer" : "Write a longer answer"));
      block.append(...quotes(form, question.id, answering, roster, meId));
      return block;
    }
    case "one":
    case "several": {
      const radio = question.type === "one";
      const rows = question.options.map((option) => {
        const on = value === option || (Array.isArray(value) && value.includes(option));
        const who = detail(option, (stored) => stored === option || (Array.isArray(stored) && stored.includes(option)));
        return answering ? choice(option, `${question.type}:${question.id}:${option}`, on, radio, who.label, () => choose(question.id, option)) : row(option, who.label, radio, who.on);
      });
      const group = h("div", { className: "form-choices" }, ...rows);
      group.setAttribute("role", radio ? "radiogroup" : "group");
      group.setAttribute("aria-label", question.prompt);
      block.append(group);
      return finish(block);
    }
    case "dropdown": {
      if (answering) block.append(menu(question.options, typeof value === "string" ? value : "", `drop:${question.id}`, question.prompt, (option) => choose(question.id, option)));
      else if (form.anonymous) {
        const rows = question.options.map((option) => {
          const who = detail(option, () => false);
          return row(option, who.label, true, who.on);
        });
        block.append(h("div", { className: "form-choices" }, ...rows));
      }
      block.append(...quotes(form, question.id, answering, roster, meId));
      return finish(block);
    }
    case "date":
    case "time": {
      if (answering) block.append(field(question.type, typeof value === "string" ? value : "", `when:${question.id}`, (text) => typeText(question.id, text), question.prompt));
      block.append(...quotes(form, question.id, answering, roster, meId));
      return finish(block);
    }
    case "scale": {
      const line = h("div", { className: "form-scale" });
      line.setAttribute("role", "radiogroup");
      line.setAttribute("aria-label", question.prompt);
      if (question.minLabel) line.append(h("span", { className: "form-note" }, question.minLabel));
      for (let n = 1; n <= 5; n++) {
        const who = detail(String(n), (stored) => stored === n);
        line.append(answering ? point(n, value === n, who.label, `scale:${question.id}:${n}`, () => choose(question.id, n)) : h("span", { className: "form-point" }, String(n), aside(who.label)));
      }
      if (question.maxLabel) line.append(h("span", { className: "form-note" }, question.maxLabel));
      block.append(line);
      return finish(block);
    }
    case "grid": {
      const table = h("table", { className: "form-grid" });
      table.append(h("thead", {}, h("tr", {}, h("th", {}), ...question.cols.map((col) => h("th", { className: "form-note" }, col.label)))));
      const body = h("tbody", {});
      for (const gridRow of question.rows) {
        body.append(
          h(
            "tr",
            {},
            h("th", {}, gridRow.label),
            ...question.cols.map((col) => {
              const key = `${gridRow.id}:${col.id}`;
              const storedCol = plain(value) ? value[gridRow.id] : undefined;
              const on = question.several ? Array.isArray(storedCol) && storedCol.includes(col.id) : storedCol === col.id;
              const who = detail(key, (stored) => {
                if (!plain(stored)) return false;
                const cell = stored[gridRow.id];
                return question.several ? Array.isArray(cell) && cell.includes(col.id) : cell === col.id;
              });
              const cell = answering
                ? gridButton(on, who.label, `grid:${question.id}:${key}`, `${gridRow.label} ${col.label}`, question.several === true, () => choose(question.id, { [gridRow.id]: col.id }))
                : h("span", { className: "form-cell-read" }, mark(!question.several, who.on), aside(who.label));
              return h("td", {}, cell);
            }),
          ),
        );
      }
      table.append(body);
      block.append(h("div", { className: "form-grid-scroll" }, table));
      return finish(block);
    }
    case "image": {
      const line = h("div", { className: "form-images" });
      line.setAttribute("role", question.several ? "group" : "radiogroup");
      line.setAttribute("aria-label", question.prompt);
      question.options.forEach((option, at) => {
        const on = question.several ? Array.isArray(value) && value.includes(option.id) : value === option.id;
        const who = detail(option.id, (stored) => stored === option.id || (Array.isArray(stored) && stored.includes(option.id)));
        const picture = Object.assign(document.createElement("img"), { src: option.src || swatch(option.label, at), alt: "" });
        const shot = answering
          ? imageButton(option.label, on, who.label, picture, `image:${question.id}:${option.id}`, question.several === true, () => choose(question.id, option.id))
          : h("div", { className: on || who.on ? "form-shot form-shot-on" : "form-shot" }, picture, h("span", {}, option.label), aside(who.label));
        line.append(shot);
      });
      block.append(line);
      return finish(block);
    }
    default: {
      const unreachable: never = question;
      return unreachable;
    }
  }
}

function quotes(form: Form, questionId: string, answering: boolean, roster: Map<string, string>, meId: string): HTMLElement[] {
  if (form.anonymous) {
    if (answering) return [];
    return (form.texts[questionId] ?? []).map((line) => h("p", { className: "form-quote" }, `"${line}"`));
  }
  if (form.mode === "one" && answering) return [];
  const lines: HTMLElement[] = [];
  for (const [memberId, answers] of Object.entries(form.answers)) {
    if (answering && memberId === meId) continue;
    const value = answers[questionId];
    if (typeof value !== "string" || value === "") continue;
    lines.push(h("p", { className: "form-quote" }, `"${value}" `, h("span", { className: "form-note" }, nameOf(roster, memberId, meId))));
  }
  return lines;
}

function otherLines(form: Form, questionId: string, answering: boolean, roster: Map<string, string>, meId: string): HTMLElement[] {
  if (form.anonymous) {
    if (answering) return [];
    return (form.texts[questionId] ?? []).map((line) => h("p", { className: "form-quote" }, `"${line}"`));
  }
  if (!form.other || (form.mode === "one" && answering)) return [];
  const lines: HTMLElement[] = [];
  for (const [memberId, notes] of Object.entries(form.other)) {
    if (answering && memberId === meId) continue;
    const text = notes[questionId];
    if (!text) continue;
    lines.push(h("p", { className: "form-quote" }, `"${text}" `, h("span", { className: "form-note" }, nameOf(roster, memberId, meId))));
  }
  return lines;
}

function field(type: "short" | "paragraph" | "date" | "time", value: string, focus: string, onInput: (value: string) => void, label?: string, placeholder?: string): HTMLElement {
  const input = type === "paragraph" ? h("textarea", { className: "form-field", rows: 3, value, data: { focus } }) : h("input", { type: type === "short" ? "text" : type, className: "form-field", value, data: { focus } });
  if (label) input.setAttribute("aria-label", label);
  if (placeholder) input.setAttribute("placeholder", placeholder);
  input.addEventListener("input", () => onInput((input as HTMLInputElement | HTMLTextAreaElement).value));
  return input;
}

function mark(one: boolean, on: boolean): HTMLElement {
  const el = h("span", { className: one ? "form-mark form-mark-one" : "form-mark form-mark-any" });
  if (on) el.dataset.on = "true";
  el.setAttribute("aria-hidden", "true");
  return el;
}

function choice(label: string, focus: string, on: boolean, radio: boolean, extra: string, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-choice", data: { focus } }, mark(radio, on), h("span", {}, label), aside(extra));
  if (radio) {
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(on));
  } else button.setAttribute("aria-pressed", String(on));
  button.addEventListener("click", run);
  return button;
}

function row(label: string, extra: string, one: boolean, on: boolean): HTMLElement {
  return h("div", { className: "form-row" }, mark(one, on), h("span", {}, label), aside(extra));
}

function point(n: number, on: boolean, extra: string, focus: string, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-point", data: { focus } }, String(n), aside(extra));
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(on));
  button.addEventListener("click", run);
  return button;
}

function gridButton(on: boolean, extra: string, focus: string, label: string, several: boolean, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-cell", data: { focus } }, mark(!several, on), aside(extra));
  button.setAttribute("role", several ? "checkbox" : "radio");
  if (several) button.setAttribute("aria-pressed", String(on));
  else button.setAttribute("aria-checked", String(on));
  button.setAttribute("aria-label", label);
  button.addEventListener("click", run);
  return button;
}

function imageButton(label: string, on: boolean, extra: string, picture: Node | "", focus: string, several: boolean, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: on ? "form-shot form-shot-on" : "form-shot", data: { focus } }, picture, h("span", {}, label), aside(extra));
  button.setAttribute("role", several ? "checkbox" : "radio");
  if (several) button.setAttribute("aria-pressed", String(on));
  else button.setAttribute("aria-checked", String(on));
  button.addEventListener("click", run);
  return button;
}

function menu(options: string[], value: string, focus: string, label: string, onChange: (value: string) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "form-select";
  select.dataset.focus = focus;
  select.setAttribute("aria-label", label);
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Choose";
  select.append(empty);
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option;
    if (option === value) item.selected = true;
    select.append(item);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function swatch(label: string, at: number): string {
  const colors = ["#5b5bd6", "#c2410c", "#15803d", "#895913", "#4545b8"];
  const color = colors[at % colors.length] ?? "#5b5bd6";
  const safe = label.replace(/[<>&]/g, "");
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="54%" fill="white" font-size="28" text-anchor="middle" font-family="sans-serif">${safe}</text></svg>`)}`;
}

const ADDABLE = [
  ["short", "Short answer"],
  ["paragraph", "Paragraph"],
  ["one", "Pick one"],
  ["several", "Pick any"],
  ["dropdown", "Dropdown"],
  ["scale", "Scale"],
  ["date", "Date"],
  ["time", "Time"],
  ["grid", "Grid"],
  ["checks", "Checkbox grid"],
  ["image", "Images"],
] as const;

function blankQuestion(kind: string): Question {
  const id = `q${Math.random().toString(36).slice(2, 7)}`;
  const prompt = "New question";
  switch (kind) {
    case "paragraph":
      return { id, type: "paragraph", prompt };
    case "short":
      return { id, type: "short", prompt };
    case "several":
      return { id, type: "several", prompt, options: ["Yes", "No"] };
    case "dropdown":
      return { id, type: "dropdown", prompt, options: ["Yes", "No"] };
    case "scale":
      return { id, type: "scale", prompt, minLabel: "Low", maxLabel: "High" };
    case "date":
      return { id, type: "date", prompt };
    case "time":
      return { id, type: "time", prompt };
    case "grid":
      return { id, type: "grid", prompt, rows: [{ id: "r1", label: "First" }, { id: "r2", label: "Second" }], cols: [{ id: "c1", label: "A" }, { id: "c2", label: "B" }] };
    case "checks":
      return { id, type: "grid", prompt, several: true, rows: [{ id: "r1", label: "First" }, { id: "r2", label: "Second" }], cols: [{ id: "c1", label: "A" }, { id: "c2", label: "B" }] };
    default:
      return kind === "image"
        ? { id, type: "image", prompt, several: true, options: [{ id: "a", label: "One" }, { id: "b", label: "Two" }, { id: "c", label: "Three" }] }
        : { id, type: "one", prompt, options: ["Yes", "No"] };
  }
}

function drawEditor(form: Form, question: Question, index: number, revise: (questions: Question[]) => void): HTMLElement {
  const block = h("div", { className: "form-q form-building" });
  const questions = form.questions;
  const put = (next: Question) => revise(questions.map((item) => (item.id === question.id ? next : item)));
  const bar = h("div", { className: "form-build-bar" });
  bar.append(h("span", { className: "form-index", textContent: String(index + 1) }));
  const kind = question.type === "grid" && question.several ? "checks" : question.type === "image" ? "image" : question.type;
  const kindLabel = ADDABLE.find(([value]) => value === kind)?.[1] ?? "Pick one";
  bar.append(menu(ADDABLE.map(([, label]) => label), kindLabel, `kind:${question.id}`, "Question type", (label) => {
    const next = ADDABLE.find(([, name]) => name === label)?.[0];
    if (!next || next === kind) return;
    const made = blankQuestion(next);
    made.id = question.id;
    made.prompt = question.prompt;
    if (question.description) made.description = question.description;
    put(made);
  }));
  const up = h("button", { type: "button", className: "form-mini", textContent: "Up" });
  const down = h("button", { type: "button", className: "form-mini", textContent: "Down" });
  const remove = h("button", { type: "button", className: "form-mini", textContent: "Remove" });
  up.addEventListener("click", () => slide(questions, question.id, -1, revise));
  down.addEventListener("click", () => slide(questions, question.id, 1, revise));
  remove.addEventListener("click", () => revise(questions.filter((item) => item.id !== question.id)));
  bar.append(up, down, remove);
  block.append(bar);
  block.append(field("short", question.prompt, `prompt:${question.id}`, (text) => put({ ...question, prompt: text }), "Prompt", "Question"));
  block.append(field("short", question.description ?? "", `desc:${question.id}`, (text) => put({ ...question, description: text || undefined }), "Description", "Description, optional"));
  if ("options" in question && question.type !== "image") {
    question.options.forEach((option, at) => {
      const line = h("div", { className: "form-build-option" });
      line.append(field("short", option, `opt:${question.id}:${at}`, (text) => {
        const options = question.options.map((item, i) => (i === at ? text : item));
        put({ ...question, options });
      }, "Option", "Option"));
      const drop = h("button", { type: "button", className: "form-mini", textContent: "Remove" });
      drop.addEventListener("click", () => put({ ...question, options: question.options.filter((_, i) => i !== at) }));
      line.append(drop);
      block.append(line);
    });
    const add = h("button", { type: "button", className: "form-mini", textContent: "Add option" });
    add.addEventListener("click", () => put({ ...question, options: [...question.options, "New"] }));
    block.append(add);
  }
  if (question.type === "image") {
    question.options.forEach((option, at) => {
      block.append(field("short", option.label, `img:${question.id}:${at}`, (text) => {
        const options = question.options.map((item, i) => (i === at ? { ...item, label: text } : item));
        put({ ...question, options });
      }, "Image label", "Label"));
    });
  }
  if ("explain" in question) {
    const box = h("label", { className: "form-check" }, h("span", {}, "Other line"));
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = showsOther(form, question);
    input.addEventListener("change", () => put({ ...question, explain: input.checked }));
    box.prepend(input);
    block.append(box);
  }
  return block;
}

function addQuestion(form: Form, revise: (questions: Question[]) => void): HTMLElement {
  const wrap = h("div", { className: "form-add" });
  wrap.append(h("span", { className: "form-kind", textContent: "Add a question" }));
  wrap.append(menu(ADDABLE.map(([value, label]) => label), "", "add", "Add a question", (label) => {
    const kind = ADDABLE.find(([, name]) => name === label)?.[0];
    if (kind) revise([...form.questions, blankQuestion(kind)]);
  }));
  return wrap;
}

function slide(questions: Question[], id: string, dir: -1 | 1, revise: (questions: Question[]) => void): void {
  const at = questions.findIndex((question) => question.id === id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= questions.length) return;
  const next = questions.slice();
  const [item] = next.splice(at, 1);
  next.splice(to, 0, item!);
  revise(next);
}

function plain(value: AnswerValue | undefined): value is Record<string, string | string[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const forms: Plugin = {
  id: "forms",
  name: "Forms",
  description: "A form in a note. An agent writes the questions. Members answer, and the answers stay in the note.",
  icon: "list",
  activate(host) {
    host.embeds.register({ name: "form", title: "Form", block: true, starts, options, render: (el, embed) => present(host, el, embed) });
  },
};
