import { sandboxed } from "../htmlFrame.ts";
import { frameDocument } from "./document.ts";
import type { ToPlugin } from "./protocol.ts";
import { SDK } from "./sdk.ts";

/** The app's colours a frame is drawn in, so a plugin's view looks like part of the app it is in. */
const COLOURS = ["bg", "bg-elev", "bg-side", "ink", "muted", "faint", "line", "line-strong", "hover", "accent", "accent-soft", "on-accent", "danger"] as const;

/** What is behind `box` in the app: the colour of the nearest thing around it that has one. */
function behind(box: HTMLElement): string {
  for (let el: HTMLElement | null = box; el; el = el.parentElement) {
    const colour = getComputedStyle(el).backgroundColor;
    if (/^rgba?\([\d\s,./%]+\)$/.test(colour) && !/^rgba\(.*,\s*0\)$/.test(colour)) return colour;
  }
  return "transparent";
}

/** The app's look as it is now: which scheme, and the styles a frame in `box` starts from. A frame keeps the look it was made with. */
function look(box: HTMLElement): { scheme: "light" | "dark"; styles: string } {
  const root = getComputedStyle(document.documentElement);
  const chosen = document.documentElement.dataset.theme;
  const scheme = chosen === "light" || chosen === "dark" ? chosen : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  // The values are the app's own, from its stylesheet. One that could end a rule is left out all the same.
  const colours = COLOURS.map((name) => [name, root.getPropertyValue(`--${name}`).trim()] as const).filter(([, value]) => /^[#\w\s(),./%-]+$/.test(value));
  const styles = `:root { ${colours.map(([name, value]) => `--${name}: ${value};`).join(" ")} }
html, body { margin: 0; }
body { padding: 12px; background: ${behind(box)}; color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
a { color: var(--accent); }
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 10px; background: var(--bg-elev); cursor: pointer; }
button:hover { background: var(--hover); }`;
  return { scheme, styles };
}

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
export function openFrame(box: HTMLElement, { code, title, grant, heard }: { code: string; title: string; grant: string | null; heard: (data: unknown) => void }): Opened {
  const channel = new MessageChannel();
  const { scheme, styles } = look(box);
  const made = sandboxed(frameDocument({ code, sdk: SDK, styles, scheme }), { title, port: channel.port2, scheme, grant });
  let open = true;
  channel.port1.onmessage = (event) => open && heard(event.data);
  made.frame.style.visibility = "hidden";
  box.append(made.frame);
  return {
    post: (message) => open && channel.port1.postMessage(message),
    show: () => void (made.frame.style.visibility = ""),
    stop() {
      open = false;
      made.stop();
      channel.port1.onmessage = null;
      channel.port1.close();
      made.frame.remove();
    },
  };
}
