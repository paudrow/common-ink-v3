import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { Plugin } from "../../plugin-api.ts";
import { drawnInView, ghost, ghostLook, lineTouched, redraw, whenSeen } from "../lib/live.ts";
import { tokenColors } from "./colors.ts";
import { fencedIn } from "./fence.ts";

type Highlighted = typeof import("./highlighting.ts").highlighted;

const svg = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  wrap: svg('<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>'),
  scroll: svg('<path d="M3 6h18"/><path d="M3 12h17"/><path d="m17 9 3 3-3 3"/><path d="M3 18h10"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
};

const look = EditorView.baseTheme({
  ".code-line": { fontFamily: "var(--mono)", fontSize: "0.9em", backgroundColor: "var(--code-bg)", padding: "0 0.9em !important", position: "relative" },
  ".code-first": { borderRadius: "8px 8px 0 0", paddingTop: "0.3em !important", color: "var(--muted)" },
  ".code-last": { borderRadius: "0 0 8px 8px", paddingBottom: "0.3em !important", color: "var(--muted)" },
  ".code-first.code-last": { borderRadius: "8px" },
  ".code-nowrap": { whiteSpace: "pre" },
  // Two quiet icons at the block's top right, seen while the pointer is over the block and always where there is no pointer.
  // They float at the line's right end and stick to the right edge of what is on screen: without wrapping a line is as
  // wide as the longest line of code in the note, and its end is far off to the side.
  // They take no room of their own, so no line of code is shorter for them.
  ".code-tools": { float: "right", position: "sticky", right: "0.4em", marginRight: "-0.5em", height: "0", alignItems: "flex-start", display: "flex", gap: "2px", fontFamily: "var(--prose)", textIndent: "0", userSelect: "none", opacity: "0", transition: "opacity 0.12s" },
  ".code-tools.code-near, .code-tools:hover, .code-tools:focus-within, .code-tools:has(.code-done)": { opacity: "1" },
  "@media (hover: none)": { ".code-tools": { opacity: "1" } },
  ".code-tools button": { display: "inline-flex", alignItems: "center", gap: "4px", height: "22px", padding: "0 5px", border: "0", borderRadius: "6px", background: "none", color: "var(--muted)", font: "600 calc(11px * var(--text-scale))/1 var(--prose)", cursor: "pointer" },
  ".code-tools button:hover": { background: "var(--hover)", color: "var(--ink)" },
  ".code-tools button:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
  ".code-tools button[aria-pressed=true]": { background: "var(--accent-soft)", color: "var(--accent)" },
  ".code-tools svg": { width: "14px", height: "14px", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" },
});

/**
 * Fenced code blocks drawn as code: a panel in the code font, the language's colors, and two
 * icons at its top right, a toggle for wrapping long lines and Copy. The colors are loaded the first time a note on screen has a fence, and
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
        const button = (name: string, icon: string, run: (button: HTMLButtonElement) => void) => {
          const made = el.appendChild(document.createElement("button"));
          made.type = "button";
          made.setAttribute("aria-label", name);
          made.innerHTML = icon;
          made.addEventListener("mousedown", (event) => event.preventDefault());
          made.addEventListener("click", () => run(made));
          return made;
        };
        // The toggle shows how long lines are laid out now, a line that turns back or one that runs on, and is lit while they wrap, so the two states never read alike.
        const toggle = button("Wrap long lines", this.wrapped ? ICONS.wrap : ICONS.scroll, () => {
          wrap = !wrap;
          host.storage.set("wrap", wrap);
          redrawAll();
        });
        toggle.setAttribute("aria-pressed", String(this.wrapped));
        toggle.title = this.wrapped ? "Long lines wrap. Press to scroll them instead." : "Long lines scroll. Press to wrap them.";
        const copy = button("Copy code", ICONS.copy, (made) => {
          let block: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(view.posAtDOM(el), -1);
          while (block && block.name !== "FencedCode") block = block.parent;
          const fenced = block && fencedIn(view.state.sliceDoc(block.from, block.to));
          if (!fenced) return;
          const say = (icon: string, words: string) => {
            made.innerHTML = icon;
            made.appendChild(document.createElement("span")).textContent = words;
            made.setAttribute("aria-label", words);
            made.classList.add("code-done");
            setTimeout(() => {
              made.innerHTML = ICONS.copy;
              made.setAttribute("aria-label", "Copy code");
              made.classList.remove("code-done");
            }, 1500);
          };
          navigator.clipboard.writeText(fenced.code).then(
            () => say(ICONS.check, "Copied"),
            () => say(ICONS.copy, "Couldn't copy"),
          );
        });
        copy.title = "Copy code";
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

    /** The tools of the block the pointer is over are shown. A block is several lines, which only know each other by standing in a row. */
    let near: Element | null = null;
    const nearing = EditorView.domEventHandlers({
      mousemove(event) {
        let line = event.target instanceof Element ? event.target.closest(".code-line") : null;
        while (line && !line.classList.contains("code-first")) line = line.previousElementSibling?.classList.contains("code-line") ? line.previousElementSibling : null;
        const tools = line?.querySelector(".code-tools") ?? null;
        if (tools === near) return;
        near?.classList.remove("code-near");
        tools?.classList.add("code-near");
        near = tools;
      },
      mouseleave() {
        near?.classList.remove("code-near");
        near = null;
      },
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

    host.editorExtensions.register({ id: "code-blocks", extension: [tracked, nearing, blocks, whenSeen((text) => /^ {0,3}(```|~~~)/m.test(text), load), look, tokenColors, ghostLook] });
    return () => {
      stopped = true;
    };
  },
};
