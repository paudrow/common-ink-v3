import { Annotation, EditorSelection, EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { drawnInView, inCode, lineTouched, within, writable } from "./live.ts";
import { replacing } from "./rewrite.ts";

/** Where a token is in the note. */
export interface Token {
  from: number;
  to: number;
}

/** What a drawn chip can do to the text it was drawn from. */
export interface Source {
  /** Whether the member can only read the note. `rewrite` then does nothing, and a chip should look that way. */
  readOnly: boolean;
  /**
   * Writes the token another way. It is an ordinary edit by the member: saved with their typing,
   * synced, recorded in History as theirs, and undone the way typing is. A chip the note no longer
   * writes the way it was drawn from does nothing.
   */
  rewrite(text: string): void;
  /**
   * Writes the token's line another way: `next` is handed the line as it reads and answers how it
   * should. For a change that reaches past the token, as taking a token away takes the space before
   * it. In every other way it is `rewrite`.
   */
  rewriteLine(next: (line: string) => string): void;
  /** Puts the cursor in the token, which shows it as written: after it, or `offset` characters into it. */
  edit(offset?: number): void;
}

/**
 * A kind of token drawn as a chip: a todo's checkbox, a formula, and later a link or a mention.
 * The note's text stays what it was. The chip is only how the token is shown while the cursor is
 * on another line, and what it changes it changes by rewriting the token.
 */
export interface Chip<T extends Token> {
  /** Names the chip's element (`md-chip-<id>`) and its edits (`input.<id>`). */
  id: string;
  /** The tokens on one line of the note, which starts at `offset`. Asked for the lines on screen. */
  find(line: string, offset: number): T[];
  /** Draws the token into `el`. One that throws is shown as written. */
  draw(el: HTMLElement, token: T, source: Source): void;
  /**
   * Whether the chip is exactly as wide as the token it stands for, so nothing on the line moves when
   * the cursor comes and the token is shown. The chip is then drawn over the token's own width. Give
   * it to a chip at the start of a line, such as a checkbox.
   */
  keepsWidth?: boolean;
  /**
   * What the chip is drawn from besides the token's own text: a linked note's title, a person's
   * name, today's date. A chip is drawn again when the note writes its token another way or this
   * changes. To have it asked again when nothing in the note changed, dispatch `redraw` to the editor.
   */
  key?(token: T): string;
  /**
   * When the token is shown as written: with the cursor anywhere on its line, or `within`, only with
   * the cursor inside the token itself or a selection of part of it. For a token nobody reads as written, such as
   * a link's id: the rest of its line stays drawn while the member types on it, and nothing on the
   * line moves until the cursor goes into the token. Such a token is one thing to the keyboard: the
   * cursor passes it in one step, and a deletion that reaches into it takes all of it. The cursor
   * goes inside only when sent there, by `source.edit(offset)` or `editWithin`.
   */
  written?: "line" | "within";
  /** Whether tokens in what the editor reads as code are drawn too, for a chip whose `skip` leaves code out by its own reading. */
  inCode?: boolean;
  /** Tokens to leave as written, besides those in code. */
  skip?(state: EditorState, token: T): boolean;
}

export class ChipWidget<T extends Token> extends WidgetType {
  constructor(
    private readonly chip: Chip<T>,
    private readonly token: T,
    private readonly written: string,
    private readonly readOnly: boolean,
    private readonly key = chip.key?.(token),
  ) {
    super();
  }

  override eq(other: ChipWidget<T>) {
    return other.chip === this.chip && other.written === this.written && other.readOnly === this.readOnly && other.key === this.key;
  }

  override toDOM(view: EditorView) {
    const { chip, written } = this;
    const el = document.createElement("span");
    el.className = `md-chip md-chip-${chip.id}`;
    let into = el;
    if (chip.keepsWidth) {
      el.classList.add("md-chip-sized");
      el.appendChild(document.createElement("span")).textContent = written;
      into = el.appendChild(document.createElement("span"));
    }
    /** The token where this is drawn now, if the note still writes it the same way. */
    const now = () => {
      let pos: number;
      try {
        pos = view.posAtDOM(el);
      } catch {
        return undefined;
      }
      const line = view.state.doc.lineAt(pos);
      const token = chip.find(line.text, line.from).find((t) => t.from === pos);
      return token && view.state.sliceDoc(token.from, token.to) === written ? token : undefined;
    };
    try {
      chip.draw(into, this.token, {
        readOnly: this.readOnly,
        rewrite(text) {
          const token = writable(view.state) ? now() : undefined;
          const changes = token && replacing(written, text, token.from);
          if (changes) view.dispatch({ changes, userEvent: `input.${chip.id}` });
        },
        rewriteLine(next) {
          const token = writable(view.state) ? now() : undefined;
          if (!token) return;
          const line = view.state.doc.lineAt(token.from);
          const changes = replacing(line.text, next(line.text), line.from);
          if (changes) view.dispatch({ changes, userEvent: `input.${chip.id}` });
        },
        edit(offset) {
          const token = now();
          if (!token) return;
          view.focus();
          view.dispatch({ selection: { anchor: offset === undefined ? token.to : token.from + offset }, scrollIntoView: true, annotations: entering.of(true) });
        },
      });
    } catch {
      el.replaceChildren(written);
    }
    return el;
  }

  /** What happens on a chip is the chip's, so a click on it doesn't move the cursor. */
  override ignoreEvent() {
    return true;
  }
}

const look = EditorView.baseTheme({
  ".md-chip-sized": { position: "relative", display: "inline-block" },
  ".md-chip-sized > :first-child": { opacity: "0", whiteSpace: "pre" },
  ".md-chip-sized > :last-child": { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center" },
});

/** Draws each of the chip's tokens on screen, except in code and where the cursor shows it as written. */
export function chips<T extends Token>(chip: Chip<T>): Extension {
  const drawn = drawnInView((view) => {
    const { state } = view;
    const made: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
        for (const token of chip.find(line.text, line.from)) {
          const shown = chip.written === "within" ? within(state, token.from, token.to) : lineTouched(state, token.from);
          if (shown || !drawable(chip, state, token)) continue;
          made.push(Decoration.replace({ widget: new ChipWidget(chip, token, state.sliceDoc(token.from, token.to), !writable(state)) }).range(token.from, token.to));
        }
        if (line.to >= to || line.number >= state.doc.lines) break;
      }
    }
    return made;
  });
  return [drawn, look, chip.written === "within" ? oneUnit(chip) : []];
}

const drawable = <T extends Token>(chip: Chip<T>, state: EditorState, token: T) => (chip.inCode || !inCode(state, token.from)) && !chip.skip?.(state, token);

/** Marks a selection that was sent inside a token on purpose, which is otherwise passed whole. */
const entering = Annotation.define<boolean>();

/** The chip's tokens on the lines from `from` to `to` that are one thing to the keyboard now. */
function units<T extends Token>(chip: Chip<T>, state: EditorState, from: number, to: number): T[] {
  const found: T[] = [];
  for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
    for (const token of chip.find(line.text, line.from)) {
      if (drawable(chip, state, token) && !within(state, token.from, token.to)) found.push(token);
    }
    if (line.to >= to || line.number >= state.doc.lines) return found;
  }
}

/** The chip's token that the cursor is at or beside and would pass whole, if there is one. */
export function unitAtCursor<T extends Token>(chip: Chip<T>, state: EditorState): T | undefined {
  const { head } = state.selection.main;
  return units(chip, state, head, head).find((t) => t.from <= head && head <= t.to);
}

/** Puts the cursor inside that token, `fromEnd` characters before its end, which shows it as written. */
export function editWithin<T extends Token>(chip: Chip<T>, view: EditorView, fromEnd: number) {
  const token = unitAtCursor(chip, view.state);
  if (token) view.dispatch({ selection: { anchor: token.to - fromEnd }, scrollIntoView: true, annotations: entering.of(true) });
}

/**
 * Keeps a token whole. A deletion of part of it, by any key in any mode, takes the rest of it too,
 * and a cursor or the end of a selection that a key would leave inside it goes on to its far side.
 * Vim works out its own ranges, so this is done to the transaction and not left to the keys.
 */
function oneUnit<T extends Token>(chip: Chip<T>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.annotation(entering) || tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent(`input.${chip.id}`)) return tr;
    const was = tr.startState;
    if (tr.docChanged) {
      const rest: Token[] = [];
      tr.changes.iterChangedRanges((from, to) => {
        if (from === to) return;
        for (const token of units(chip, was, from, to)) {
          if (from >= token.to || to <= token.from) continue;
          if (from > token.from) rest.push({ from: tr.changes.mapPos(token.from, -1), to: tr.changes.mapPos(from, -1) });
          if (to < token.to) rest.push({ from: tr.changes.mapPos(to, 1), to: tr.changes.mapPos(token.to, 1) });
        }
      });
      return rest.length ? [tr, { changes: rest, sequential: true }] : tr;
    }
    if (!tr.selection || tr.isUserEvent("select.pointer")) return tr;
    let moved = false;
    /** The token an end of a selection would be left inside, if any. */
    const cut = (pos: number) => units(chip, was, pos, pos).find((t) => pos > t.from && pos < t.to);
    const ranges = tr.selection.ranges.map((r, i) => {
      const [low, high] = [cut(r.from), cut(r.to)];
      if (!low && !high) return r;
      moved = true;
      if (!r.empty) {
        const [from, to] = [low ? low.from : r.from, high ? high.to : r.to];
        return r.head < r.anchor ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
      }
      const before = (was.selection.ranges[i] ?? was.selection.main).head;
      return EditorSelection.cursor(r.head > before ? low!.to : low!.from);
    });
    return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }] : tr;
  });
}
