import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { Plugin } from "../../plugin-api.ts";
import { drawnInView, ghost, ghostLook, lineTouched, redraw, whenSeen } from "../lib/live.ts";
import { fencedIn } from "./fence.ts";

type Highlighted = typeof import("./highlighting.ts").highlighted;

const look = EditorView.baseTheme({
  ".code-line": { fontFamily: "var(--mono)", fontSize: "0.9em", backgroundColor: "var(--bg-side)", padding: "0 0.9em !important", position: "relative" },
  ".code-first": { borderRadius: "8px 8px 0 0", paddingTop: "0.3em !important", color: "var(--muted)" },
  ".code-last": { borderRadius: "0 0 8px 8px", paddingBottom: "0.3em !important", color: "var(--muted)" },
  ".code-first.code-last": { borderRadius: "8px" },
  ".code-nowrap": { whiteSpace: "pre" },
  ".code-tools": { position: "absolute", top: "0.25em", right: "0.4em", display: "flex", gap: "0.3em", fontFamily: "var(--prose)" },
  ".code-tools button": { font: "inherit", fontSize: "0.78em", lineHeight: "1.4", padding: "0.05em 0.5em", border: "1px solid var(--line)", borderRadius: "6px", background: "var(--bg-elev)", color: "var(--muted)", cursor: "pointer" },
  ".code-tools button:hover, .code-tools button[aria-pressed=true]": { color: "var(--ink)", borderColor: "var(--line-strong)" },
  ".tok-keyword, .tok-operatorKeyword, .tok-modifier": { color: "light-dark(#8b3fc7, #c792ea)" },
  ".tok-string, .tok-string2, .tok-inserted": { color: "light-dark(#3d7a3d, #a5d6a7)" },
  ".tok-comment, .tok-meta": { color: "light-dark(#8a8580, #7d7870)", fontStyle: "italic" },
  ".tok-number, .tok-bool, .tok-atom, .tok-literal": { color: "light-dark(#b25d0f, #f0a868)" },
  ".tok-typeName, .tok-className, .tok-namespace": { color: "light-dark(#0f7a8a, #7fd0dd)" },
  ".tok-propertyName, .tok-macroName, .tok-labelName": { color: "light-dark(#2f5fc4, #8fb4ff)" },
  ".tok-variableName.tok-definition, .tok-heading": { color: "light-dark(#2f5fc4, #8fb4ff)" },
  ".tok-deleted, .tok-invalid": { color: "light-dark(#b3261e, #f28b82)" },
});

/**
 * Fenced code blocks drawn as code: a panel in the code font, the language's colors, and two
 * buttons, Copy and Wrap. The colors are loaded the first time a note on screen has a fence, and
 * each language the first time a block names it.
 */
export const codeBlocks: Plugin = {
  id: "code-blocks",
  name: "Code blocks",
  description: "Fenced code drawn as code, in its language's colors, with Copy and Wrap.",
  icon: "code",
  activate(host) {
    let stopped = false;
    let highlighted: Highlighted | undefined;
    /** Whether long lines of code are wrapped. It is the member's for every block, kept in this browser. */
    let wrap = host.storage.get("wrap") !== false;
    const views = new Set<EditorView>();
    const redrawAll = () => {
      for (const view of views) view.dispatch({ effects: redraw.of(null) });
    };
    const failed = new Set<string>();
    const onFail = (language: string) => {
      if (stopped || failed.has(language)) return;
      failed.add(language);
      host.report(new Error(`The colors for ${language} couldn't be loaded, so that code is shown without them. Reload the page to try again.`));
    };

    class Tools extends WidgetType {
      constructor(private readonly wrapped: boolean) {
        super();
      }

      override eq(other: Tools) {
        return other.wrapped === this.wrapped;
      }

      override toDOM(view: EditorView) {
        const el = document.createElement("span");
        el.className = "code-tools";
        const button = (label: string, run: (button: HTMLButtonElement) => void) => {
          const made = el.appendChild(document.createElement("button"));
          made.type = "button";
          made.textContent = label;
          made.addEventListener("mousedown", (event) => event.preventDefault());
          made.addEventListener("click", () => run(made));
          return made;
        };
        button("Copy", (made) => {
          let block: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(view.posAtDOM(el), -1);
          while (block && block.name !== "FencedCode") block = block.parent;
          const fenced = block && fencedIn(view.state.sliceDoc(block.from, block.to));
          if (!fenced) return;
          navigator.clipboard.writeText(fenced.code).then(
            () => {
              made.textContent = "Copied";
              setTimeout(() => (made.textContent = "Copy"), 1500);
            },
            () => (made.textContent = "Couldn't copy"),
          );
        });
        button("Wrap", () => {
          wrap = !wrap;
          host.storage.set("wrap", wrap);
          redrawAll();
        }).setAttribute("aria-pressed", String(this.wrapped));
        return el;
      }

      override ignoreEvent() {
        return true;
      }
    }

    const blocks = drawnInView((view) => {
      const { state } = view;
      const drawn: Range<Decoration>[] = [];
      const line = Decoration.line({ class: wrap ? "code-line" : "code-line code-nowrap" });
      const seen = new Set<number>();
      for (const visible of view.visibleRanges) {
        syntaxTree(state).iterate({
          from: visible.from,
          to: visible.to,
          enter(node) {
            if (node.name !== "FencedCode") return;
            if (seen.has(node.from)) return false;
            seen.add(node.from);
            const fenced = fencedIn(state.sliceDoc(node.from, node.to));
            if (!fenced) return false;
            const [first, last] = [state.doc.lineAt(node.from), state.doc.lineAt(node.to)];
            for (let at = first; ; at = state.doc.line(at.number + 1)) {
              if (at.to >= visible.from && at.from <= visible.to) {
                drawn.push(line.range(at.from));
                if (at.number === first.number) drawn.push(Decoration.line({ class: "code-first" }).range(at.from));
                if (at.number === last.number) drawn.push(Decoration.line({ class: "code-last" }).range(at.from));
              }
              if (at.number >= last.number) break;
            }
            drawn.push(Decoration.widget({ widget: new Tools(wrap), side: 1 }).range(first.to));
            // The code is drawn the same with the cursor in it. Only a fence changes: off the cursor's line it isn't
            // painted, and keeps its line and its width, so the language stays where it is and nothing moves.
            for (const mark of node.node.getChildren("CodeMark")) if (!lineTouched(state, mark.from)) drawn.push(ghost.range(mark.from, mark.to));
            if (highlighted && fenced.from < fenced.to) {
              drawn.push(...highlighted(fenced.language, state.sliceDoc(node.from + fenced.from, node.from + fenced.to), node.from + fenced.from, visible, redrawAll, onFail));
            }
            return false;
          },
        });
      }
      return drawn;
    });

    const tracked = ViewPlugin.define((view) => {
      views.add(view);
      return { destroy: () => void views.delete(view) };
    });

    const load = () =>
      import("./highlighting.ts").then(
        (module) => {
          if (stopped) return;
          highlighted = module.highlighted;
          redrawAll();
        },
        () => !stopped && host.report(new Error("The colors for code couldn't be loaded, so code is shown without them. Reload the page to try again.")),
      );

    host.editorExtensions.register({ id: "code-blocks", extension: [tracked, blocks, whenSeen((text) => /^ {0,3}(```|~~~)/m.test(text), load), look, ghostLook] });
    return () => {
      stopped = true;
    };
  },
};
