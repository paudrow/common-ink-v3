import { sandboxed, type Plugin } from "../../plugin-api.ts";
import { arriving } from "../lib/arriving.ts";
import { lettering, outline, sketch } from "../lib/sketch.ts";
import { heightIn } from "./config.ts";
import { runningIn } from "./running.ts";

const START = `<p>Hello from <b>HTML</b>.</p>
`;

/**
 * HTML in a note, run in a frame shut off from the app: `/html()`, then the HTML in a fence under it. It runs
 * by itself the first time its room is on screen, unless the member has asked to be asked first, in
 * which case it runs when Run is pressed. The frame is the body of the block's card, and stays as it
 * is while the rest of the note is written. Until it is drawn, its room shows a placeholder its size.
 * It starts with the app's own background, colour and face, so a few words of HTML read as the note
 * does, in the light theme and the dark. `height=480` in the config gives it another height.
 */
export const html: Plugin = {
  id: "html",
  name: "HTML embeds",
  description: "HTML written in a note, run shut off from the app, and from the network unless an admin lists sites it may reach.",
  icon: "code",
  settings: {
    run: {
      title: "Run HTML embeds",
      description: "Automatically, as soon as one is on screen, or only when you press Run. Either way it runs shut off from the app, and from the network but for the sites an admin lets HTML embeds reach. Unless you choose, it asks first on a server where HTML embeds have no site of their own, and runs by itself where they have.",
      type: "string",
      enum: ["automatically", "ask first"],
      default: "automatically",
      defaultWithoutEmbedSite: "ask first",
      unreadable: "ask first",
    },
  },
  activate(host) {
    const ran = runningIn(host.storage);
    /** The sites HTML embeds may reach in this workspace, as its record last said. None until an admin lists some. */
    let sites: readonly string[] = [];
    /** Each Run button shown now, told when the sites change so it says what it would reach. */
    const saying = new Set<() => void>();
    const learn = (now: readonly string[]) => {
      if (now.join(" ") === sites.join(" ")) return;
      sites = now;
      for (const say of [...saying]) say();
    };
    const read = (): Promise<void> => {
      // A guest is told nothing of the workspace's plugins, and their embeds reach no site.
      if (host.workspace.role === "guest") return Promise.resolve();
      return host.perform({ type: "plugin.list" }).then(
        (record) => {
          const network = record.plugins.find((p) => p.id === "html" && !p.thirdParty)?.permissions.find((p) => p.capability === "network");
          learn(network?.state === "allowed" ? network.origins : []);
        },
        () => {},
      );
    };
    /** The first reading of the record: an embed that runs by itself waits for it, so it runs with the reach the workspace gives it. */
    const known = read();
    host.onNavigate(() => void read());
    /** Each HTML embed drawn now, told when the member's settings change. */
    const following = new Set<() => void>();
    host.settings.subscribe(() => following.forEach((follow) => follow()));
    host.embeds.register({
      name: "html",
      title: "HTML",
      block: true,
      content: "html",
      starts: { body: START },
      description: "A page of your own HTML, run in a frame shut off from the app",
      preview: { image: sketch(outline(10, 8, 180, 68, 5) + `<rect x="10" y="8" width="180" height="14" rx="5" opacity="0.18"/><circle cx="20" cy="15" r="2.5"/><circle cx="29" cy="15" r="2.5"/><circle cx="38" cy="15" r="2.5"/>` + lettering(70, 58, 26, "&lt;/&gt;", 'font-family="ui-monospace, monospace" font-weight="600"')) },
      // All of it is below: the card the host draws has the name and the settings, and the frame is the card's body.
      render() {},
      below: {
        box: ({ config }) => ({ height: heightIn(config) }),
        // Drawn the first time its room is on screen, and again when the HTML changes, which then runs, or asks, again.
        render(into, { body, config, resize }) {
          const asks = () => host.settings.get<string>("run") !== "automatically";
          /** Asked because this HTML runs in another page, or did when that page stopped answering. */
          const elsewhere = ran.elsewhere(body);
          let pressed = false;
          let live = true;
          let halt: (() => void) | null = null;
          let button: HTMLButtonElement | null = null;
          const why = () => (elsewhere ? `${ELSEWHERE} ${reach(sites)}` : `Written in this note. ${reach(sites)}`);
          /**
           * While it asks, the room is tall enough for the Run button and the line under it, however
           * short `height` is. Once it runs, it is `height` again. The room keeps the last height it
           * was given through a change to `height`, so it is given one each time.
           */
          const fit = () => {
            let needs = 0;
            if (button) {
              button.style.height = "auto";
              needs = Math.ceil(button.getBoundingClientRect().height) + ASKING_MARGIN;
              button.style.height = "";
            }
            resize(Math.max(heightIn(config), needs));
          };
          const say = () => {
            button?.querySelector(".media-load-from")?.replaceChildren(why());
            fit();
          };
          // The button's line wraps by the room's width, which it may not have yet when it is drawn, and which changes with the window.
          const sized = new ResizeObserver(() => button && fit());
          sized.observe(into);
          saying.add(say);
          /** Takes away the placeholder an embed that runs by itself holds its room with while the workspace is asked what it may reach. */
          let holding: (() => void) | null = null;
          const release = () => {
            holding?.();
            holding = null;
          };
          const start = (grant: string | null) => {
            // Before the frame's own placeholder, which sets the room busy again.
            release();
            button?.remove();
            button = null;
            fit();
            const made = sandboxed(body, {
              title: "HTML embed",
              grant,
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
          const ask = () => {
            button = runButton(why(), () => {
              pressed = true;
              if (elsewhere) ran.forget(body);
              begin(sites);
            });
            into.append(button);
            release();
            fit();
          };
          /**
           * Runs it with the reach `said`: none, or the sites an admin listed, which need a grant, good once,
           * for a frame whose policy lets it reach them. When the workspace says otherwise by then, it says
           * what it would reach now and waits to be asked again.
           */
          /** Whether a start is on its way, so a change of the setting meanwhile starts nothing more. */
          let starting = false;
          const begin = (said: readonly string[]) => {
            if (said.length === 0) return start(null);
            if (button) button.disabled = true;
            starting = true;
            host.perform({ type: "plugin.frame", id: "html" }).then(
              (grant) => {
                starting = false;
                if (!live) return;
                // Asked to be asked meanwhile, and not pressed: it waits for Run.
                if (!pressed && !elsewhere && asks()) {
                  if (button) button.disabled = false;
                  else ask();
                  return;
                }
                if (grant.token && grant.origins.join(" ") === said.join(" ")) return start(grant.token);
                learn(grant.token ? grant.origins : []);
                if (button) button.disabled = false;
                else ask();
              },
              () => {
                starting = false;
                if (!live) return;
                if (button) button.disabled = false;
                else ask();
              },
            );
          };
          // A change of the setting reaches what is drawn now. What the member ran by pressing Run is left running.
          const follow = () => {
            if (pressed || elsewhere || starting) return;
            if (asks() && halt) {
              halt();
              ask();
            } else if (!asks() && button) begin(sites);
          };
          if (elsewhere || asks()) ask();
          else {
            starting = true;
            // Its room is held with the loading placeholder until the frame is made or the Run button is drawn, so in the meantime it is not an empty box.
            holding = arriving(into, document.createElement("div")).arrived;
            void known.then(() => {
              starting = false;
              if (!live || halt || button) return;
              if (asks()) ask();
              else begin(sites);
            });
          }
          following.add(follow);
          return () => {
            live = false;
            sized.disconnect();
            saying.delete(say);
            following.delete(follow);
            halt?.();
          };
        },
      },
    });
    return () => ran.stop();
  },
};

/** Room above and below the Run button and its line, in pixels, when the room is made taller to show them. */
const ASKING_MARGIN = 24;

const ELSEWHERE = "It was running when a page with it stopped answering, or it runs in another tab now.";

/** What a Run button says HTML reaches once it runs. */
const reach = (sites: readonly string[]) => (sites.length ? `It runs shut off from the app, and can reach ${sites.join(", ")}.` : "It runs shut off from the app and the network.");

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
    if (run.disabled) return;
    start();
  });
  return run;
}
