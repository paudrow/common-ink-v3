import { sandboxed, type Plugin } from "../../plugin-api.ts";
import { arriving } from "../lib/arriving.ts";
import { heightIn } from "./config.ts";
import { runningIn } from "./running.ts";

const START = `<p>Hello from <b>HTML</b>.</p>
`;

/**
 * HTML in a note, run in a frame shut off from the app: `:::html{}`, the HTML, then `:::`. It runs
 * by itself the first time its room is on screen, unless the member has asked to be asked first, in
 * which case it runs when Run is pressed. The frame is the body of the block's card, and stays as it
 * is while the rest of the note is written. Until it is drawn, its room shows a placeholder its size.
 * It starts with the app's own background, colour and face, so a few words of HTML read as the note
 * does, in the light theme and the dark. `height=480` in the config gives it another height.
 */
export const html: Plugin = {
  id: "html",
  name: "HTML embeds",
  description: "HTML written in a note, run shut off from the app and the network.",
  icon: "code",
  settings: {
    run: {
      title: "Run HTML embeds",
      description: "Automatically, as soon as one is on screen, or only when you press Run. Either way it runs shut off from the app and the network.",
      type: "string",
      enum: ["automatically", "ask first"],
      default: "automatically",
      unreadable: "ask first",
    },
  },
  activate(host) {
    const ran = runningIn(host.storage);
    /** Each HTML embed drawn now, told when the member's settings change. */
    const following = new Set<() => void>();
    host.settings.subscribe(() => following.forEach((follow) => follow()));
    host.embeds.register({
      name: "html",
      title: "HTML",
      block: true,
      starts: { body: START },
      options: {
        fields: ({ config }) => [{ id: "height", label: "Height", kind: "text", value: String(heightIn(config)), hint: "In pixels, from 40 to 2000." }],
        set({ config }, _id, value) {
          const height = Number(value.trim());
          if (!Number.isInteger(height) || height < 40 || height > 2000) return "Write a whole number of pixels from 40 to 2000.";
          const rest = config.split(/\s+/).filter((word) => word && !word.startsWith("height="));
          return { config: [...rest, `height=${height}`].join(" ") };
        },
      },
      // All of it is below: the card the host draws has the name and the options, and the frame is the card's body.
      render() {},
      below: {
        box: ({ config }) => ({ height: heightIn(config) }),
        // Drawn the first time its room is on screen, and again when the HTML changes, which then runs, or asks, again.
        render(into, { body }) {
          const asks = () => host.settings.get<string>("run") !== "automatically";
          /** Asked because this HTML runs in another page, or did when that page stopped answering. */
          const elsewhere = ran.elsewhere(body);
          let pressed = false;
          let halt: (() => void) | null = null;
          let button: HTMLButtonElement | null = null;
          const start = () => {
            button?.remove();
            button = null;
            const made = sandboxed(body, {
              title: "HTML embed",
              drawn: () => shown.arrived(),
              // Said, and not left as an empty box that looks like HTML with nothing in it.
              refused() {
                shown.arrived();
                listed();
                const notice = document.createElement("div");
                notice.className = "embed-below-stopped";
                notice.setAttribute("role", "alert");
                notice.textContent = "This browser wouldn't load the frame HTML runs in, so nothing was run.";
                made.frame.replaceWith(notice);
              },
            });
            const shown = arriving(into, made.frame);
            const listed = ran.started(body);
            into.prepend(made.frame);
            halt = () => {
              made.stop();
              listed();
              shown.arrived();
              into.replaceChildren();
              halt = null;
            };
          };
          const ask = (why: string) => {
            button = runButton(why, () => {
              pressed = true;
              if (elsewhere) ran.forget(body);
              start();
            });
            into.append(button);
          };
          // A change of the setting reaches what is drawn now. What the member ran by pressing Run is left running.
          const follow = () => {
            if (pressed || elsewhere) return;
            if (asks() && halt) {
              halt();
              ask(ASKED);
            } else if (!asks() && button) start();
          };
          if (elsewhere) ask("It was running when a page with it stopped answering, or it runs in another tab now. It runs shut off from the app and the network.");
          else if (asks()) ask(ASKED);
          else start();
          following.add(follow);
          return () => {
            following.delete(follow);
            halt?.();
          };
        },
      },
    });
    return () => ran.stop();
  },
};

const ASKED = "Written in this note. It runs shut off from the app and the network.";

/** What an HTML embed shows when the member has asked to be asked before one runs. */
function runButton(why: string, start: () => void): HTMLButtonElement {
  const run = document.createElement("button");
  run.type = "button";
  run.className = "media-load";
  const action = document.createElement("span");
  action.className = "media-load-action";
  action.textContent = "Run HTML";
  const says = document.createElement("span");
  says.className = "media-load-from";
  says.textContent = why;
  run.append(action, says);
  run.addEventListener("click", () => {
    run.remove();
    start();
  });
  return run;
}
