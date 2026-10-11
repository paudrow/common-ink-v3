import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { drawnInView, inCode, lineTouched, writable } from "./live.ts";
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
  /** Puts the cursor in the token, which shows it as written. */
  edit(): void;
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
        edit() {
          const token = now();
          if (!token) return;
          view.focus();
          view.dispatch({ selection: { anchor: token.to }, scrollIntoView: true });
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

/** Draws each of the chip's tokens on screen, except in code and on the cursor's line. */
export function chips<T extends Token>(chip: Chip<T>): Extension {
  const drawn = drawnInView((view) => {
    const { state } = view;
    const made: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
        for (const token of chip.find(line.text, line.from)) {
          if (lineTouched(state, token.from) || inCode(state, token.from) || chip.skip?.(state, token)) continue;
          made.push(Decoration.replace({ widget: new ChipWidget(chip, token, state.sliceDoc(token.from, token.to), !writable(state)) }).range(token.from, token.to));
        }
        if (line.to >= to || line.number >= state.doc.lines) break;
      }
    }
    return made;
  });
  return [drawn, look];
}
