import { createElement, useState } from "react";
import { SWATCHES, type Drawn, type EmbedOptions, type Embedded, type Plugin, type Swatch } from "../../plugin-api.ts";
import { openPopover } from "../lib/Popover.tsx";
import { panel, sketch, words } from "../lib/sketch.ts";
import { addCard, addColumn, cardEnd, cardsOf, changeCard, colourColumn, deleteColumn, moveCard, moveColumn, parseBoard, renameColumn, serializeBoard, type Board } from "./board.ts";

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

/** What a column's menu does, each a change to the board but Rename, which opens its title to type in. */
interface ColumnActions {
  title: string;
  cards: number;
  /** The column to its left, which Delete offers to move its cards to, if it has one. */
  left: string | null;
  right: boolean;
  rename: () => void;
  move: (by: -1 | 1) => void;
  remove: (keepCards: boolean) => void;
  shut: () => void;
}

/** A column's menu. Delete asks first when the column has cards, and offers to move them to the column on its left. */
function ColumnMenu({ title, cards, left, right, rename, move, remove, shut }: ColumnActions) {
  const [asking, setAsking] = useState(false);
  const item = (label: string, run: () => void, disabled = false) => createElement("button", { key: label, type: "button", role: "menuitem", className: "kanban-menu-item", disabled, onClick: run }, label);
  if (asking) {
    return createElement(
      "div",
      { className: "kanban-menu", role: "menu", "aria-label": `Delete ${title}` },
      createElement("p", { className: "kanban-menu-ask" }, `Delete ${title} and its ${cards === 1 ? "card" : `${cards} cards`}?`),
      left !== null && item(`Move ${cards === 1 ? "it" : "them"} to ${left}, and delete ${title}`, () => (shut(), remove(true))),
      item(`Delete ${title} and ${cards === 1 ? "its card" : "its cards"}`, () => (shut(), remove(false))),
      item("Cancel", shut),
    );
  }
  return createElement(
    "div",
    { className: "kanban-menu", role: "menu", "aria-label": `${title} column` },
    item("Rename", () => (shut(), rename())),
    item("Move left", () => (shut(), move(-1)), left === null),
    item("Move right", () => (shut(), move(1)), !right),
    item("Delete", () => (cards ? setAsking(true) : (shut(), remove(false)))),
  );
}

/**
 * A field in place of `shown`, to type a name in, with `value` in it to start: Enter writes it, Escape
 * puts `shown` back, and leaving it writes it too, as a field left with something typed in it is taken.
 * With `dropped`, a field left with no new name is that instead: told whether a key left it.
 */
function nameField(shown: HTMLElement, value: string, label: string, focus: string, take: (name: string) => void, dropped?: (keyed: boolean) => void): void {
  const input = h("input", { type: "text", className: "kanban-name", data: { focus } });
  input.value = value;
  input.setAttribute("aria-label", label);
  let done = false;
  /** From a key the keyboard stays where it was, on what the field stood in for, which the board drawn again focuses as it was; from a press elsewhere it stays there. */
  const finish = (name: string | null, keyed: boolean) => {
    if (done) return;
    done = true;
    const taken = name !== null && !!name.trim() && name.trim() !== value.trim();
    if (!taken && dropped) return dropped(keyed);
    input.replaceWith(shown);
    if (keyed) shown.focus();
    if (taken) take(name!);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(input.value, true);
    else if (e.key === "Escape") finish(null, true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(input.value, false));
  shown.replaceWith(input);
  input.focus();
  input.select();
}

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
  /** What takes out each card's drawing, when the board is drawn again or goes. */
  const undrawn: (() => void)[] = [];
  const write = (next: Board) => next !== board && embed.update({ body: serializeBoard(next) });

  /** What only a member who can change the note is given. */
  const controls = (...nodes: Node[]) => (embed.readOnly ? [] : nodes);

  // A column is added at the end of the board: it is there at once, its name to type in its head, and once named the keyboard is on its name.
  const addColumnButton = h("button", { type: "button", className: "kanban-add-column", textContent: "Add column", data: { focus: "add-column" } });
  addColumnButton.addEventListener("click", () => {
    const name = h("button", { type: "button", className: "kanban-title", data: { focus: `title:${board.columns.length}` } });
    const added = h("section", { className: "kanban-column kanban-column-new" }, h("h3", {}, name));
    addColumnButton.before(added);
    const drop = (keyed: boolean) => {
      added.remove();
      if (keyed) addColumnButton.focus();
    };
    // A name that is nothing but a colour mark adds no column, and the one waiting for it goes.
    nameField(name, "", "New column name", `title:${board.columns.length}`, (title) => (addColumn(board, title) === board ? drop(true) : write(addColumn(board, title))), drop);
    added.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  if (!board.columns.length) {
    el.append(h("div", { className: "kanban kanban-empty" }, h("p", {}, "A kanban board has a column for each heading, such as ## To do, and a card for each list item under it."), ...controls(addColumnButton)));
    return {};
  }

  const columns = board.columns.map((column, c) => {
    const cards = cardsOf(column);
    const list = h("ol", { className: "kanban-cards" });
    list.setAttribute("aria-label", `${column.title} cards`);
    cards.forEach((card, i) => {
      const at = { column: c, card: i };
      // A card is drawn as its lines are in the note: a todo's box ticks, a chip opens its menu, and a link is its note's title.
      const text = h("div", { className: "kanban-card-text" });
      const item = h("li", { className: "kanban-card" }, text);
      // A card is changed as it is written: a press on its words puts the cursor at the end of its line in the board's markdown, which is shown above the board.
      const editCard = () => embed.edit(cardEnd(board, at) ?? undefined);
      undrawn.push(embed.lines(text, card.lines.join("\n"), { changed: (lines) => write(changeCard(board, at, lines)), pressed: () => !embed.readOnly && editCard() }));
      if (!embed.readOnly) {
        item.draggable = true;
        item.title = "Drag to move, or press to change its text";
        item.addEventListener("click", (e) => e.target === item && editCard());
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

    // The title is renamed in place, by a double-click or Enter on it.
    const title: HTMLElement = h(embed.readOnly ? "span" : "button", { className: "kanban-title", textContent: column.title, data: { focus: `title:${c}` } });
    const rename = () => nameField(title, column.title, `Name of ${column.title}`, `title:${c}`, (name) => write(renameColumn(board, c, name)));
    if (!embed.readOnly) {
      (title as HTMLButtonElement).type = "button";
      title.title = "Double-click or press Enter to rename";
      title.setAttribute("aria-label", `${column.title}, press Enter to rename`);
      title.addEventListener("dblclick", rename);
      title.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        rename();
      });
    }
    const menu = h("button", { type: "button", className: "kanban-column-menu", title: `${column.title} column`, data: { focus: `menu:${c}` } });
    menu.setAttribute("aria-label", `${column.title} column menu`);
    menu.setAttribute("aria-haspopup", "menu");
    menu.addEventListener("click", () =>
      openPopover(menu, `${column.title} column`, (shut) =>
        createElement(ColumnMenu, {
          title: column.title,
          cards: cards.length,
          left: board.columns[c - 1]?.title ?? null,
          right: c < board.columns.length - 1,
          rename,
          move: (by) => write(moveColumn(board, c, c + by)),
          remove: (keepCards) => write(deleteColumn(board, c, keepCards ? c - 1 : null)),
          shut,
        }),
      ),
    );

    const heading = h("h3", {}, title, ...controls(colour), h("span", { className: "kanban-count" }, String(cards.length)), ...controls(menu));
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

  el.append(h("div", { className: "kanban" }, h("div", { className: "kanban-columns" }, ...columns, ...controls(addColumnButton))));
  return { stop: () => undrawn.forEach((undraw) => undraw()) };
}

/**
 * A kanban board kept in a note as a block: `/kanban()`, then its markdown in a fence under it, a
 * heading for each column with its cards as a list under it. Moving or adding a card rewrites that markdown, and so does giving
 * a column a colour, which its heading then ends with: `## Doing {.blue}`, and adding, renaming, moving or deleting a column,
 * from the board itself, so nobody needs the markdown to set a board up.
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
