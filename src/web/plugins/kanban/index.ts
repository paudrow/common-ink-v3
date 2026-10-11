import type { Embedded, Plugin } from "../../plugin-api.ts";
import { addCard, cardsOf, moveCard, parseBoard, serializeBoard, type Board, type Place } from "./board.ts";

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

/** Where a card dropped at height `y` over a list of cards goes: before the first card whose middle is below it. */
function dropIndex(list: HTMLElement, y: number): number {
  const cards = [...list.querySelectorAll<HTMLElement>(".kanban-card:not(.dragging)")];
  const at = cards.findIndex((card) => {
    const box = card.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return at < 0 ? cards.length : at;
}

function draw(el: HTMLElement, embed: Embedded) {
  const board = parseBoard(embed.body);
  const drawn = {};
  const write = (next: Board) => next !== board && embed.update({ body: serializeBoard(next) });

  const editAsMarkdown = h("button", { type: "button", className: "kanban-edit", textContent: "Edit as markdown" });
  editAsMarkdown.addEventListener("click", () => embed.edit());
  /** What only a member who can change the note is given. */
  const controls = (...nodes: Node[]) => (embed.readOnly ? [] : nodes);
  if (!board.columns.length) {
    el.append(h("div", { className: "kanban kanban-empty" }, h("p", {}, "A kanban board has a column for each heading, such as ## To do, and a card for each list item under it."), ...controls(editAsMarkdown)));
    return;
  }

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
        if (!e.key.startsWith("Arrow") || e.altKey || e.ctrlKey || e.metaKey || (e.shiftKey && embed.readOnly)) return;
        const across = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        const down = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        const column = c + across;
        const there = board.columns[column];
        if (!there) return;
        e.preventDefault();
        const others = cardsOf(there).length - (across ? 0 : 1);
        const to = { column, card: Math.max(0, Math.min(i + down, e.shiftKey ? others : others - (across ? 1 : 0))) };
        if (e.shiftKey) {
          // The card is drawn again in its new place, and takes the focus there.
          item.dataset.focus = focusKey(to);
          write(moveCard(board, at, to));
        } else el.querySelector<HTMLElement>(`[data-focus="${focusKey(to)}"]`)?.focus();
      });
      list.append(item);
    });

    const add = h("button", { type: "button", className: "kanban-add", textContent: "Add a card", data: { focus: `add:${c}` } });
    add.setAttribute("aria-label", `Add a card to ${column.title}`);
    const input = h("input", { type: "text", className: "kanban-add-text", placeholder: "New card", data: { focus: `add:${c}` } });
    input.setAttribute("aria-label", `New card in ${column.title}`);
    const close = () => {
      drafts.delete(el);
      input.value = "";
      input.replaceWith(add);
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
    input.addEventListener("blur", () => input.isConnected && !input.value.trim() && close());
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

    const section = h("section", { className: "kanban-column" }, h("h3", {}, column.title, h("span", { className: "kanban-count" }, String(cards.length))), list, ...controls(adding));
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

  el.append(h("div", { className: "kanban" }, h("div", { className: "kanban-columns" }, ...columns), ...controls(editAsMarkdown)));
}

/**
 * A kanban board kept in a note as a block: `:::kanban{}`, a heading for each column with its cards
 * as a list under it, then `:::`. Moving or adding a card rewrites that markdown.
 */
export const kanban: Plugin = {
  id: "kanban",
  name: "Kanban",
  activate(host) {
    host.embeds.register({ name: "kanban", title: "Kanban board", block: true, starts: { body: "## To do\n\n## Doing\n\n## Done\n" }, render: draw });
  },
};
