import { createElement } from "react";
import { SWATCHES, type Drawn, type EmbedOptions, type Embedded, type Plugin, type Swatch } from "../../plugin-api.ts";
import { openPopover } from "../lib/Popover.tsx";
import { panel, sketch, words } from "../lib/sketch.ts";
import { addCard, cardEnd, cardsOf, colourColumn, moveCard, parseBoard, serializeBoard, type Board } from "./board.ts";

const CARD_DRAG = "application/x-common-ink-card";

/** Three columns of cards, as the insert menu pictures a board. */
const PICTURE = sketch([10, 74, 138].map((x, i) => words(x, 8, 34, 5) + [20, 40, 60].slice(0, 3 - i).map((y) => panel(x, y, 52, 16)).join("")).join(""));

/** The card being dragged, and the drawing of the board it was picked up from. A board drawn again since then isn't that one, so the drop does nothing. */
let dragging: { drawn: object; from: { column: number; card: number } } | null = null;

/** A card being typed into "Add a card" on a board, kept by the board's element so it is still there when a change to the note draws the board again. */
const drafts = new WeakMap<HTMLElement, { column: number; text: string }>();

interface Props {
  className?: string;
  textContent?: string;
  type?: string;
  placeholder?: string;
  title?: string;
  draggable?: boolean;
  data?: Record<string, string>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, { data, ...props }: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  Object.assign(el.dataset, data);
  el.append(...children);
  return el;
}

const named = (colour: Swatch | "") => (colour ? colour[0]!.toUpperCase() + colour.slice(1) : "No colour");
const COLOURS = (["", ...SWATCHES] as const).map((colour) => ({ value: colour, label: named(colour), swatch: colour }));

/** A column's colour is set from the board's options too, a field for each column. */
const options: EmbedOptions = {
  fields: ({ body }) => parseBoard(body).columns.map((column, c) => ({ id: String(c), label: `${column.title} colour`, kind: "choice", value: column.colour ?? "", choices: COLOURS })),
  set: ({ body }, id, value) => ({ body: serializeBoard(colourColumn(parseBoard(body), Number(id), (value as Swatch) || null)) }),
};

/** Where a card dropped at height `y` over a list of cards goes: before the first card whose middle is below it. */
function dropIndex(list: HTMLElement, y: number): number {
  const cards = [...list.querySelectorAll<HTMLElement>(".kanban-card:not(.dragging)")];
  const at = cards.findIndex((card) => {
    const box = card.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return at < 0 ? cards.length : at;
}

function draw(el: HTMLElement, embed: Embedded): Drawn {
  const board = parseBoard(embed.body);
  const drawn = {};
  const write = (next: Board) => next !== board && embed.update({ body: serializeBoard(next) });

  /** What only a member who can change the note is given. */
  const controls = (...nodes: Node[]) => (embed.readOnly ? [] : nodes);
  if (!board.columns.length) {
    el.append(h("div", { className: "kanban kanban-empty" }, h("p", {}, "A kanban board has a column for each heading, such as ## To do, and a card for each list item under it.")));
    return {};
  }

  const columns = board.columns.map((column, c) => {
    const cards = cardsOf(column);
    const list = h("ol", { className: "kanban-cards" });
    list.setAttribute("aria-label", `${column.title} cards`);
    cards.forEach((card, i) => {
      const at = { column: c, card: i };
      const item = h("li", { className: "kanban-card" }, h("span", { className: "kanban-card-text" }, card.text));
      if (card.more.trim()) item.append(h("span", { className: "kanban-card-more" }, card.more));
      if (!embed.readOnly) {
        item.draggable = true;
        item.title = "Drag to move, or press to change its text";
        // A card is changed as it is written: a press puts the cursor at the end of its line in the board's markdown, which is shown above the board.
        item.addEventListener("click", () => embed.edit(cardEnd(board, at) ?? undefined));
      }
      item.addEventListener("dragstart", (e) => {
        dragging = { drawn, from: at };
        e.dataTransfer?.setData(CARD_DRAG, "");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => {
        dragging = null;
        item.classList.remove("dragging");
      });
      list.append(item);
    });

    const add = h("button", { type: "button", className: "kanban-add", textContent: "Add a card", data: { focus: `add:${c}` } });
    add.setAttribute("aria-label", `Add a card to ${column.title}`);
    const input = h("input", { type: "text", className: "kanban-add-text", placeholder: "New card", data: { focus: `add:${c}` } });
    input.setAttribute("aria-label", `New card in ${column.title}`);
    let closing = false;
    const close = () => {
      drafts.delete(el);
      input.value = "";
      // Taking the field out takes the keyboard from it, which would close it a second time from inside the first.
      closing = true;
      input.replaceWith(add);
      closing = false;
    };
    input.addEventListener("input", () => drafts.set(el, { column: c, text: input.value }));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        const text = input.value;
        drafts.delete(el);
        write(addCard(board, c, text));
      } else if (e.key === "Escape") {
        close();
        add.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener("blur", () => !closing && input.isConnected && !input.value.trim() && close());
    add.addEventListener("click", () => {
      add.replaceWith(input);
      input.focus();
    });
    const draft = drafts.get(el);
    if (draft?.column === c) {
      input.value = draft.text;
      input.setSelectionRange(draft.text.length, draft.text.length);
    }
    const adding = draft?.column === c ? input : add;

    const colour = h("button", { type: "button", className: "kanban-colour", title: `Colour of ${column.title}`, data: { focus: `colour:${c}`, ...(column.colour && { colour: column.colour }) } });
    colour.setAttribute("aria-label", `Colour of ${column.title}: ${named(column.colour ?? "").toLowerCase()}`);
    colour.addEventListener("click", () =>
      openPopover(colour, `Colour of ${column.title}`, (shut) =>
        createElement(
          "div",
          { className: "kanban-palette", role: "radiogroup", "aria-label": `Colour of ${column.title}` },
          COLOURS.map(({ value, label }) =>
            createElement("button", {
              key: value,
              type: "button",
              role: "radio",
              "aria-checked": value === (column.colour ?? ""),
              "aria-label": label,
              title: label,
              className: "embed-option-choice swatch",
              "data-colour": value || undefined,
              onClick: () => {
                // The board is drawn again with the colour, and the button that opened this has the focus there.
                shut();
                colour.focus();
                write(colourColumn(board, c, value || null));
              },
            }),
          ),
        ),
      ),
    );

    const heading = h("h3", {}, h("span", { className: "kanban-title" }, column.title), ...controls(colour), h("span", { className: "kanban-count" }, String(cards.length)));
    const section = h("section", { className: "kanban-column", data: column.colour ? { colour: column.colour } : {} }, heading, list, ...controls(adding));
    section.setAttribute("aria-label", column.title);
    const mine = (e: DragEvent) => dragging?.drawn === drawn && e.dataTransfer?.types.includes(CARD_DRAG);
    section.addEventListener("dragover", (e) => {
      if (!mine(e)) return;
      e.preventDefault();
      section.classList.add("drop");
    });
    section.addEventListener("dragleave", (e) => !section.contains(e.relatedTarget as Node | null) && section.classList.remove("drop"));
    section.addEventListener("drop", (e) => {
      section.classList.remove("drop");
      if (!mine(e)) return;
      e.preventDefault();
      write(moveCard(board, dragging!.from, { column: c, card: dropIndex(list, e.clientY) }));
    });
    return section;
  });

  el.append(h("div", { className: "kanban" }, h("div", { className: "kanban-columns" }, ...columns)));
  return {};
}

/**
 * A kanban board kept in a note as a block: `/kanban()`, then its markdown in a fence under it, a
 * heading for each column with its cards as a list under it. Moving or adding a card rewrites that markdown, and so does giving
 * a column a colour, which its heading then ends with: `## Doing {.blue}`.
 */
export const kanban: Plugin = {
  id: "kanban",
  name: "Kanban",
  description: "A board of columns and cards kept in a note as headings and lists.",
  icon: "board",
  screenshots: [{ src: "/plugin-shots/kanban-light.png", dark: "/plugin-shots/kanban-dark.png", alt: "A board in a note: three columns of cards, each with a button to add a card." }],
  activate(host) {
    host.embeds.register({ name: "kanban", title: "Kanban board", block: true, content: "markdown", starts: { body: "## To do\n\n## Doing\n\n## Done\n" }, description: "Columns of cards to drag from one to another", preview: { image: PICTURE }, options, render: draw });
  },
};
