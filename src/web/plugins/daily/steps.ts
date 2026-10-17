import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { dayHeading } from "./days.ts";

const shown = StateEffect.define<string | null>();

class Steps extends WidgetType {
  constructor(
    readonly day: string,
    readonly step: (from: string, by: number) => void,
  ) {
    super();
  }

  override eq(other: Steps) {
    return other.day === this.day;
  }

  toDOM() {
    const anchor = document.createElement("span");
    anchor.className = "daily-steps";
    const steps = anchor.appendChild(document.createElement("span"));
    steps.className = "daily-steps-buttons";
    for (const [label, glyph, by] of [["Previous day", "‹", -1], ["Next day", "›", 1]] as const) {
      const button = steps.appendChild(document.createElement("button"));
      button.type = "button";
      button.textContent = glyph;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.step(this.day, by));
    }
    return anchor;
  }

  override ignoreEvent() {
    return true;
  }
}

// The anchor has no width, so the line's text is laid out as it is with no controls at all. The
// buttons hang from it to the right of the date and only show while the line is hovered or they have focus.
const look = EditorView.theme({
  ".daily-steps": { position: "relative", display: "inline-block", width: "0", verticalAlign: "middle" },
  ".daily-steps-buttons": { position: "absolute", left: "0.75em", top: "50%", transform: "translateY(-62%)", display: "flex", gap: "2px", opacity: "0", transition: "opacity 120ms", whiteSpace: "nowrap" },
  ".cm-line:hover .daily-steps-buttons, .daily-steps-buttons:focus-within": { opacity: "1" },
  ".daily-steps-buttons button": { font: "inherit", fontFamily: "system-ui, sans-serif", fontWeight: "400", fontSize: "calc(1.375rem * var(--text-scale))", lineHeight: "1", color: "var(--faint)", background: "transparent", border: "none", borderRadius: "4px", padding: "0 0.3em 0.1em", cursor: "pointer" },
  ".daily-steps-buttons button:hover": { color: "var(--ink)", background: "var(--hover)" },
  ".daily-steps-buttons button:focus-visible": { color: "var(--ink)", outline: "2px solid var(--accent)", outlineOffset: "-2px" },
});

/**
 * ‹ and › after a daily note's date heading, which go to the day before and the day after. They are
 * drawn only once the server says the note is the member's daily note for the day its heading names.
 */
export function dayStepper(noteId: string, isDaily: (noteId: string, day: string) => Promise<boolean>, step: (from: string, by: number) => void): Extension {
  const day = StateField.define<string | null>({
    create: () => null,
    update: (value, tr) => tr.effects.reduce((v, e) => (e.is(shown) ? e.value : v), value),
  });
  const decorations = EditorView.decorations.compute([day], (state) => {
    const shownDay = state.field(day);
    const first = state.doc.line(1);
    if (shownDay === null || dayHeading(first.text) !== shownDay) return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new Steps(shownDay, step), side: 1 }).range(first.to)]);
  });
  const watch = ViewPlugin.fromClass(
    class {
      heading: string | null = null;
      constructor(readonly view: EditorView) {
        this.check();
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.check();
      }
      destroy() {
        this.heading = null;
      }
      check() {
        const heading = dayHeading(this.view.state.doc.line(1).text);
        if (heading === this.heading) return;
        this.heading = heading;
        if (heading === null) return;
        void isDaily(noteId, heading).then((yes) => {
          if (this.heading === heading) this.view.dispatch({ effects: shown.of(yes ? heading : null) });
        });
      }
    },
  );
  return [day, decorations, watch, look];
}
