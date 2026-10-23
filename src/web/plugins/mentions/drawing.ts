import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { following, mentionsIn, mentionsOn, parseTodo, type WrittenMention } from "../../plugin-api.ts";
import { chips, editWithin, unitAtCursor, type Chip } from "../lib/chips.ts";
import { drawnInView, within } from "../lib/live.ts";
import { shown, type People } from "./people.ts";

type Drawn = WrittenMention & { assignee: boolean };

const mentionsOf = (text: string) => new Map(mentionsIn(text).map((mention) => [mention.from, mention]));

/**
 * The note's mentions, by where each starts, read from the whole text by the function the server
 * indexes them with. So what is drawn as a mention is what is one, where the editor's own parse
 * would say otherwise: in a deeply nested bullet, which is indented as far as a code block is.
 */
export const noteMentions = StateField.define<ReadonlyMap<number, WrittenMention>>({
  create: (state) => mentionsOf(state.doc.toString()),
  update: (mentions, tr) => (tr.docChanged ? mentionsOf(tr.state.doc.toString()) : mentions),
});

const isMention = (state: EditorState, mention: WrittenMention) => state.field(noteMentions).has(mention.from);

/** What reads as a mention on one line, and whether it is on a todo, where it is who the todo is assigned to. */
function mentionsDrawnOn(line: string, offset: number): Drawn[] {
  const found = mentionsOn(line, offset);
  if (!found.length) return [];
  const assigned = new Set(parseTodo(line, offset)?.assignees.map((a) => a.from));
  return found.map((mention) => ({ ...mention, assignee: assigned.has(mention.from) }));
}

/** How far before a mention's end its name is typed: before the closing brackets. */
const BEFORE_END = 2;

const classOf = (member: boolean) => (member ? "md-mention-member" : "md-mention-other");

/** Opens the page of the person a mention is of, by its target: a member's id, or a name. Null where there is no page to go to, as on a link's page. */
export type OpenPerson = ((target: string) => void) | null;

/**
 * Draws a mention as `@` and a name: a member's as it is now, in the theme colour, and anyone
 * else's as written, in gray. On a todo it is a chip, as the todo's other options are. It is shown
 * as written only while the cursor is inside it, since what is written holds an id. A click opens
 * the person's page; the keys go into it to change it.
 */
function mentionChip(people: () => People, open: () => OpenPerson): Chip<Drawn> {
  return {
    id: "mention",
    find: mentionsDrawnOn,
    written: "within",
    inCode: true,
    skip: (state, mention) => !isMention(state, mention),
    key: (mention) => JSON.stringify(shown(mention, people().members)),
    draw(el, mention, source) {
      const { text, member, hint } = shown(mention, people().members);
      el.textContent = text;
      el.title = mention.assignee ? `Assigned to ${hint}` : hint;
      el.classList.add(classOf(member));
      if (mention.assignee) el.classList.add("md-mention-assignee");
      const going = open();
      if (going) el.setAttribute("role", "link");
      el.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const to = open();
        if (to) to(mention.target);
        else source.edit(mention.to - mention.from - BEFORE_END);
      });
    },
  };
}

/** A mention shown as written keeps its colour, so it still reads as one. */
const asWritten = (people: () => People) =>
  drawnInView((view) => {
    const { state } = view;
    const drawn: Range<Decoration>[] = [];
    for (const range of state.selection.ranges) {
      const line = state.doc.lineAt(range.head);
      for (const mention of mentionsOn(line.text, line.from)) {
        if (!within(state, mention.from, mention.to) || !isMention(state, mention)) continue;
        drawn.push(Decoration.mark({ class: `md-mention ${classOf(shown(mention, people().members).member)}` }).range(mention.from, mention.to));
      }
    }
    return drawn;
  });

const look = EditorView.baseTheme({
  // Words of the line's own size, so a line is as tall with a mention drawn as with it written.
  ".md-mention-member": { color: "var(--accent)" },
  ".md-mention-other": { color: "var(--muted)" },
  // A name is someone else's text, set apart from the line so one written right to left turns nothing around it.
  ".md-chip-mention": { cursor: "pointer", whiteSpace: "nowrap", unicodeBidi: "isolate" },
  ".md-mention-assignee": { padding: "0 0.35em", borderRadius: "4px", background: "var(--hover)" },
  ".md-mention-assignee.md-mention-member": { background: "var(--accent-soft)" },
});

/** Vim's gd on a mention, drawn or as written, opens the person's page as a click does. */
const followed = (open: () => OpenPerson) =>
  following.of((view) => {
    const { head } = view.state.selection.main;
    const mention = [...view.state.field(noteMentions).values()].find((m) => m.from <= head && head < m.to);
    const to = open();
    if (!mention || !to) return false;
    to(mention.target);
    return true;
  });

/** The editor extension that draws mentions, a way to put the cursor inside the one it is at, and whether it is at one. */
export function mentionDrawing(people: () => People, open: () => OpenPerson): { extension: Extension; edit: (view: EditorView) => void; canEdit: (view: EditorView) => boolean } {
  const chip = mentionChip(people, open);
  return { extension: [noteMentions, chips(chip), asWritten(people), look, followed(open)], edit: (view) => editWithin(chip, view, BEFORE_END), canEdit: (view) => !!unitAtCursor(chip, view.state) };
}
