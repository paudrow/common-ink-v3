import { castVote, parseForm, serializeForm, setAnswer, type AnswerValue, type Form, type NamedForm, type Question } from "./form.ts";
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
    return [{ id: "closed", label: "Answers", kind: "choice", value: form.closed ? "closed" : "open", choices: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }] }];
  },
  set: ({ body }, _id, value) => {
    const form = parseForm(body);
    if (!form) return "This form can't be read.";
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

function promptOf(question: Question): HTMLElement {
  const required = (question.type === "short" || question.type === "paragraph" || question.type === "one" || question.type === "several") && question.required;
  return h("p", { className: "form-prompt" }, question.prompt, ...(required ? [h("span", { className: "form-note" }, " *")] : []));
}

function aside(text: string): Node | string {
  return text ? h("span", { className: "form-note" }, text) : "";
}

function present(host: PluginHost, el: HTMLElement, embed: Embedded): Drawn {
  let current = embed;
  const me = host.app().me;
  let draft: Record<string, AnswerValue> = {};
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
    const count = (questionId: string, key: string) => (form.anonymous && !answering ? String(form.tallies[questionId]?.[key] ?? 0) : "");

    const root = h("div", { className: "form-embed" });
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

    for (const question of form.questions) root.append(drawQuestion(form, question, answering, roster, me.id, valueOf, names, count, choose, typeText));

    if (answering && form.anonymous) {
      const cast = h("button", { type: "button", className: "form-cast", textContent: "Cast vote", data: { focus: "cast" } });
      cast.addEventListener("click", () => {
        const next = castVote(form, me.id, draft);
        if (next === form) return;
        draft = {};
        write(next);
      });
      root.append(cast);
    } else if (form.anonymous && form.voted.length) {
      root.append(h("p", { className: "form-quote" }, "Voted ", h("span", { className: "form-note" }, form.voted.map((id) => nameOf(roster, id, me.id)).join(", "))));
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
  answering: boolean,
  roster: Map<string, string>,
  meId: string,
  valueOf: (questionId: string) => AnswerValue | undefined,
  names: (questionId: string, hit: (value: AnswerValue | undefined) => boolean) => string,
  count: (questionId: string, key: string) => string,
  choose: (questionId: string, value: AnswerValue) => void,
  typeText: (questionId: string, value: string) => void,
): HTMLElement {
  const block = h("div", { className: "form-q" }, promptOf(question));
  const value = valueOf(question.id);
  const detail = (key: string, hit: (stored: AnswerValue | undefined) => boolean) => count(question.id, key) || names(question.id, hit);

  switch (question.type) {
    case "short":
    case "paragraph": {
      if (answering) block.append(field(question.type, typeof value === "string" ? value : "", `text:${question.id}`, (text) => typeText(question.id, text)));
      block.append(...quotes(form, question.id, answering, roster, meId));
      return block;
    }
    case "one":
    case "several": {
      const radio = question.type === "one";
      const rows = question.options.map((option) => {
        const on = value === option || (Array.isArray(value) && value.includes(option));
        const who = detail(option, (stored) => stored === option || (Array.isArray(stored) && stored.includes(option)));
        return answering ? choice(option, `${question.type}:${question.id}:${option}`, on, radio, who, () => choose(question.id, option)) : row(option, who);
      });
      const group = h("div", { className: "form-choices" }, ...rows);
      group.setAttribute("role", radio ? "radiogroup" : "group");
      group.setAttribute("aria-label", question.prompt);
      block.append(group);
      return block;
    }
    case "scale": {
      const line = h("div", { className: "form-scale" });
      line.setAttribute("role", "radiogroup");
      line.setAttribute("aria-label", question.prompt);
      if (question.minLabel) line.append(h("span", { className: "form-note" }, question.minLabel));
      for (let n = 1; n <= 5; n++) {
        const who = detail(String(n), (stored) => stored === n);
        line.append(answering ? point(n, value === n, who, `scale:${question.id}:${n}`, () => choose(question.id, n)) : h("span", { className: "form-point" }, String(n), aside(who)));
      }
      if (question.maxLabel) line.append(h("span", { className: "form-note" }, question.maxLabel));
      block.append(line);
      return block;
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
              const on = plain(value) && value[gridRow.id] === col.id;
              const who = detail(key, (stored) => plain(stored) && stored[gridRow.id] === col.id);
              const cell = answering ? gridButton(on, who, `grid:${question.id}:${key}`, `${gridRow.label} ${col.label}`, () => choose(question.id, { [gridRow.id]: col.id })) : h("span", { className: "form-note" }, who);
              return h("td", {}, cell);
            }),
          ),
        );
      }
      table.append(body);
      block.append(table);
      return block;
    }
    case "image": {
      const line = h("div", { className: "form-images" });
      line.setAttribute("role", "radiogroup");
      line.setAttribute("aria-label", question.prompt);
      for (const option of question.options) {
        const who = detail(option.id, (stored) => stored === option.id);
        const picture = option.src ? Object.assign(document.createElement("img"), { src: option.src, alt: "" }) : "";
        const shot = answering
          ? imageButton(option.label, value === option.id, who, picture, `image:${question.id}:${option.id}`, () => choose(question.id, option.id))
          : h("div", { className: "form-shot" }, ...(picture ? [picture] : []), h("span", {}, option.label), aside(who));
        line.append(shot);
      }
      block.append(line);
      return block;
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

function field(type: "short" | "paragraph", value: string, focus: string, onInput: (value: string) => void): HTMLElement {
  const input = type === "short" ? h("input", { type: "text", className: "form-field", value, data: { focus } }) : h("textarea", { className: "form-field", rows: 3, value, data: { focus } });
  input.addEventListener("input", () => onInput((input as HTMLInputElement | HTMLTextAreaElement).value));
  return input;
}

function choice(label: string, focus: string, on: boolean, radio: boolean, extra: string, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-choice", data: { focus } }, h("span", {}, label), aside(extra));
  if (radio) {
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(on));
  } else button.setAttribute("aria-pressed", String(on));
  button.addEventListener("click", run);
  return button;
}

function row(label: string, extra: string, ...leading: Node[]): HTMLElement {
  return h("div", { className: "form-row" }, ...leading, h("span", {}, label), aside(extra));
}

function point(n: number, on: boolean, extra: string, focus: string, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-point", data: { focus } }, String(n), aside(extra));
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(on));
  button.addEventListener("click", run);
  return button;
}

function gridButton(on: boolean, extra: string, focus: string, label: string, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-cell", data: { focus } }, aside(extra));
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(on));
  button.setAttribute("aria-label", label);
  button.addEventListener("click", run);
  return button;
}

function imageButton(label: string, on: boolean, extra: string, picture: Node | "", focus: string, run: () => void): HTMLButtonElement {
  const button = h("button", { type: "button", className: "form-shot", data: { focus } }, ...(picture ? [picture] : []), h("span", {}, label), aside(extra));
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(on));
  button.addEventListener("click", run);
  return button;
}

function plain(value: AnswerValue | undefined): value is Record<string, string> {
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
