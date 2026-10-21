import { sandboxed } from "../htmlFrame.ts";
import { onLook, themeNow } from "../theme.ts";
import { frameDocument } from "./document.ts";
import type { ToPlugin } from "./protocol.ts";
import { SDK } from "./sdk.ts";

/** The app's colours a frame is drawn in, so a plugin's view looks like part of the app it is in. */
const COLOURS = ["bg", "bg-elev", "bg-side", "ink", "muted", "faint", "line", "line-strong", "hover", "accent", "accent-soft", "accent-ink", "on-accent", "danger", "added", "warn", "code-bg"] as const;

/**
 * The rest of the app's look a plugin may draw with, the same in either theme: its faces, its sizes
 * of text, its corners and its spacing. Documented in `docs/plugins.md` ("Styling a plugin").
 */
const TOKENS = `--prose: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --text-small: 12px; --text: 14px; --text-large: 16px; --radius-small: 6px; --radius: 10px; --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;`;

/**
 * The app's controls, drawn as the app draws them, for a plugin to take by class: `ink-button` (with
 * `primary` or `quiet`), `ink-input`, `ink-chip`, `ink-card`, `ink-title`, `ink-muted`, `ink-row` and
 * `ink-stack`. A plugin that puts `ink-kit` on its body has its bare buttons, fields, lists and
 * headings drawn that way too, which is the one line a plugin needs to look like the app.
 */
const KIT = `
.ink-button, .ink-kit button { display: inline-flex; align-items: center; gap: var(--space-1); height: 30px; padding: 0 var(--space-3); border: 1px solid var(--line-strong); border-radius: var(--radius-small); background: var(--bg-elev); color: var(--ink); font: 600 13px/1 var(--prose); cursor: pointer; }
.ink-button:hover, .ink-kit button:hover { background: var(--hover); }
.ink-button.primary, .ink-kit button.primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.ink-button.quiet, .ink-kit button.quiet { border-color: transparent; background: none; color: var(--muted); }
.ink-button:disabled, .ink-kit button:disabled { opacity: 0.5; cursor: default; }
.ink-input, .ink-kit input:not([type=checkbox]):not([type=radio]), .ink-kit select, .ink-kit textarea { box-sizing: border-box; min-height: 30px; padding: var(--space-1) var(--space-2); border: 1px solid var(--line-strong); border-radius: var(--radius-small); background: var(--bg-elev); color: var(--ink); font: var(--text)/1.4 var(--prose); }
.ink-input:focus, .ink-kit input:focus, .ink-kit select:focus, .ink-kit textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.ink-chip { display: inline-flex; align-items: center; height: 22px; padding: 0 var(--space-2); border-radius: 999px; background: var(--hover); color: var(--muted); font: 600 var(--text-small)/1 var(--prose); }
.ink-card { padding: var(--space-3) var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-elev); }
.ink-title, .ink-kit h1, .ink-kit h2, .ink-kit h3 { margin: 0 0 var(--space-2); color: var(--muted); font: 650 11px/1.2 var(--prose); letter-spacing: 0.08em; text-transform: uppercase; }
.ink-muted { color: var(--muted); font-size: var(--text-small); }
.ink-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.ink-stack { display: flex; flex-direction: column; gap: var(--space-2); }
.ink-kit ul, .ink-kit ol { margin: 0; padding-left: var(--space-4); }`;

/** What is behind `box` in the app: the colour of the nearest thing around it that has one. */
function behind(box: HTMLElement): string {
  for (let el: HTMLElement | null = box; el; el = el.parentElement) {
    const colour = getComputedStyle(el).backgroundColor;
    if (/^rgba?\([\d\s,./%]+\)$/.test(colour) && !/^rgba\(.*,\s*0\)$/.test(colour)) return colour;
  }
  return "transparent";
}

/** The app's look as it is now: which scheme, and the styles a frame in `box` is drawn with. They are sent again each time the look changes. */
function look(box: HTMLElement, bar: boolean): { scheme: "light" | "dark"; styles: string } {
  const root = getComputedStyle(document.documentElement);
  const scheme = themeNow();
  // The values are the app's own, from its stylesheet. One that could end a rule is left out all the same.
  const colours = COLOURS.map((name) => [name, root.getPropertyValue(`--${name}`).trim()] as const).filter(([, value]) => /^[#\w\s(),./%-]+$/.test(value));
  const styles = `:root { color-scheme: ${scheme}; ${colours.map(([name, value]) => `--${name}: ${value};`).join(" ")} ${TOKENS} }
html, body { margin: 0; }
body { padding: 12px; background: ${behind(box)}; color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
a { color: var(--accent); }
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 10px; background: var(--bg-elev); cursor: pointer; }
button:hover { background: var(--hover); }${KIT}${bar ? BAR : ""}`;
  return { scheme, styles };
}

/** A frame in the bottom bar is one line of small text, as everything else there is, with nothing around it. What it draws is as wide as its words, which is what the app is told to make the frame as wide as. */
const BAR = `
html, body { height: 100%; overflow: hidden; }
#ink-root { display: inline-block; }
body { padding: 0; color: var(--muted); font-size: 12px; line-height: 25px; white-space: nowrap; font-variant-numeric: tabular-nums; }
button { border: 0; border-radius: 5px; padding: 1px 8px; background: none; line-height: 18px; }
button:hover { color: var(--ink); }`;

/** What a frame of one of Common Ink's own plugins is named. */
export const OWN_FRAME = "ink-own-plugin";

export interface Opened {
  post(message: ToPlugin): void;
  /** Lets the frame be seen. Until then it holds its place and shows nothing, so the box it is in looks as it did before. */
  show(): void;
  /** Closes the port and takes the frame out. Nothing the frame sends after this is heard. */
  stop(): void;
}

/**
 * Puts a frame in `box` that runs `code` shut off from the app, with a port between the two. `heard`
 * is called with whatever the frame sends, which is anything at all. `grant` is a token for a frame
 * that may reach the network.
 */
export function openFrame(box: HTMLElement, { code, title, grant, heard, bar = false, own = false }: { code: string; title: string; grant: string | null; heard: (data: unknown) => void; bar?: boolean; own?: boolean }): Opened {
  const channel = new MessageChannel();
  const { scheme, styles } = look(box, bar);
  const made = sandboxed(frameDocument({ code, sdk: SDK, styles, scheme }), { title, port: channel.port2, scheme, grant, name: own ? OWN_FRAME : undefined });
  let open = true;
  channel.port1.onmessage = (event) => open && heard(event.data);
  // Nothing in the bar holds the keyboard, so Tab passes its frames by.
  if (bar) made.frame.tabIndex = -1;
  made.frame.style.visibility = "hidden";
  box.append(made.frame);
  // The frame follows the app from one look to the next, night shift's included, as everything else in the window does.
  const unfollow = onLook(() => open && channel.port1.postMessage({ v: 1, event: "look", ...look(box, bar) } satisfies ToPlugin));
  return {
    post: (message) => open && channel.port1.postMessage(message),
    show: () => void (made.frame.style.visibility = ""),
    stop() {
      open = false;
      unfollow();
      made.stop();
      channel.port1.onmessage = null;
      channel.port1.close();
      made.frame.remove();
    },
  };
}
