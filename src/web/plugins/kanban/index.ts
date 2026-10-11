import { createElement } from "react";
import { SWATCHES, type Drawn, type EmbedOptions, type Embedded, type Plugin, type Swatch } from "../../plugin-api.ts";
import { openPopover } from "../lib/Popover.tsx";
import { addCard, cardsOf, colourColumn, moveCard, parseBoard, serializeBoard, type Board, type Place } from "./board.ts";

const CARD_DRAG = "application/x-common-ink-card";

/** The card being dragged, and the drawing of the board it was picked up from. A board drawn again since then isn't that one, so the drop does nothing. */
let dragging: { drawn: object; from: Place } | null = null;

/** A card being typed into "Add a card" on a board, kept by the board's element so it is still there when a change to the note draws the board again. */
const drafts = new WeakMap<HTMLElement, { column: number; text: string }>();

interface Props {
  className?: string;
  textContent?: string;
  type?: string;
  placeholder?: string;
  title?: string;
  draggable?: boolean;
  tabIndex?: number;
  data?: Record<string, string>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, { data, ...props }: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  Object.assign(el.dataset, data);
  el.append(...children);
  return el;
}

const focusKey = ({ column, card }: Place) => `card:${column}:${card}`;

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

  /** What the arrow keys stop at in each column, from the top: its cards, then "Add a card". */
  const stops: HTMLElement[][] = board.columns.map(() => []);
  /** Moves the focus from the `i`th stop of column `c`: up and down its column and out of the board past either end, and across to a card of the next column where it has one. */
  const step = (e: KeyboardEvent, c: number, i: number) => {
    const across = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const down = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    const there = stops[c + across];
    if (!there) return;
    e.preventDefault();
    const cards = there.filter((stop) => stop.matches(".kanban-card"));
    const onCard = stops[c]![i]!.matches(".kanban-card");
    if (across) (onCard && cards.length ? cards[Math.min(i, cards.length - 1)] : there.at(-1))?.focus();
    else if (there[i + down]) there[i + down]!.focus();
    else embed.leave(down < 0 ? "above" : "below");
  };
  const arrow = (e: KeyboardEvent) => e.key.startsWith("Arrow") && !e.altKey && !e.ctrlKey && !e.metaKey;

  const columns = board.columns.map((column, c) => {
    const cards = cardsOf(column);
    const list = h("ol", { className: "kanban-cards" });
    list.setAttribute("aria-label", `${column.title} cards`);
    cards.forEach((card, i) => {
      const at = { column: c, card: i };
      const item = h("li", { className: "kanban-card", tabIndex: 0, data: { focus: focusKey(at) } }, h("span", { className: "kanban-card-text" }, card.text));
      if (card.more.trim()) item.append(h("span", { className: "kanban-card-more" }, card.more));
      if (!embed.readOnly) {
        item.draggable = true;
        item.title = "Drag to move, or hold Shift and press an arrow key";
        item.setAttribute("aria-keyshortcuts", "Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown");
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
      item.addEventListener("keydown", (e) => {
        if (!arrow(e) || (e.shiftKey && embed.readOnly)) return;
        if (!e.shiftKey) return step(e, c, i);
        const across = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        const down = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        const there = board.columns[c + across];
        if (!there) return;
        e.preventDefault();
        const to = { column: c + across, card: Math.max(0, Math.min(i + down, cardsOf(there).length - (across ? 0 : 1))) };
        // The card is drawn again in its new place, and takes the focus there.
        item.dataset.focus = focusKey(to);
        write(moveCard(board, at, to));
      });
      stops[c]!.push(item);
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
      swap(input, add);
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
    /** Swaps the button for the field, or back, in the column and among its stops. */
    const swap = (from: HTMLElement, to: HTMLElement) => {
      from.replaceWith(to);
      stops[c] = stops[c]!.map((stop) => (stop === from ? to : stop));
    };
    add.addEventListener("click", () => {
      swap(add, input);
      input.focus();
    });
    add.addEventListener("keydown", (e) => arrow(e) && !e.shiftKey && step(e, c, cards.length));
    const draft = drafts.get(el);
    if (draft?.column === c) {
      input.value = draft.text;
      input.setSelectionRange(draft.text.length, draft.text.length);
    }
    const adding = draft?.column === c ? input : add;
    if (!embed.readOnly) stops[c]!.push(adding);

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
  return {
    // The cursor comes in at the first column that has anything to stop at: its top from above, its foot from below.
    enter(from) {
      const column = stops.find((column) => column.length);
      const stop = column?.at(from === "above" ? 0 : -1);
      stop?.focus();
      return !!stop && document.activeElement === stop;
    },
  };
}

/**
 * A kanban board kept in a note as a block: `:::kanban{}`, a heading for each column with its cards
 * as a list under it, then `:::`. Moving or adding a card rewrites that markdown, and so does giving
 * a column a colour, which its heading then ends with: `## Doing {.blue}`.
 */
export const kanban: Plugin = {
  id: "kanban",
  name: "Kanban",
  description: "A board of columns and cards kept in a note as headings and lists.",
  icon: "board",
  screenshots: [{ src: "/plugin-shots/kanban-light.png", dark: "/plugin-shots/kanban-dark.png", alt: "A board in a note: three columns of cards, each with a button to add a card." }],
  activate(host) {
    host.embeds.register({ name: "kanban", title: "Kanban board", block: true, entered: true, starts: { body: "## To do\n\n## Doing\n\n## Done\n" }, options, render: draw });
  },
};
