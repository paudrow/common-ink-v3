import { sandboxed, type Plugin } from "../../plugin-api.ts";
import { heightIn } from "./config.ts";

const START = `<style>body { font: 16px system-ui; }</style>
<p>Hello from HTML.</p>
`;

/**
 * HTML in a note, run in a frame shut off from the app when the member asks for it: `:::html{}`,
 * the HTML, then `:::`. The frame is kept below the block and stays as it is while the rest of the
 * note is written. `height=480` in
 * the config gives it another height.
 */
export const html: Plugin = {
  id: "html",
  name: "HTML embeds",
  activate(host) {
    /** The sites HTML embeds may reach in this workspace, as its record last said. None until an admin lists some. */
    let sites: readonly string[] = [];
    const drawn = new Set<() => void>();
    const learn = (now: readonly string[]) => {
      if (now.join(" ") === sites.join(" ")) return;
      sites = now;
      for (const say of [...drawn]) say();
    };
    const read = () => {
      // A guest is told nothing of the workspace's plugins, and their embeds reach no site.
      if (host.workspace.role === "guest") return;
      host.perform({ type: "plugin.list" }).then(
        (record) => {
          const network = record.plugins.find((p) => p.id === "html" && !p.thirdParty)?.permissions.find((p) => p.capability === "network");
          learn(network?.state === "allowed" ? network.origins : []);
        },
        () => {},
      );
    };
    read();
    host.onNavigate(read);
    host.embeds.register({
      name: "html",
      title: "HTML",
      block: true,
      starts: { body: START },
      render(into, embed) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "html-embed-edit";
        edit.textContent = "HTML";
        edit.title = "Click to edit";
        edit.addEventListener("click", () => embed.edit());
        into.append(edit);
      },
      below: {
        box: ({ config }) => ({ height: heightIn(config) }),
        // Nothing of it runs until the member asks, each time it is drawn: a note that is only opened
        // runs nothing, and HTML that has changed since it was last run asks again.
        render(into, { body }) {
          let stop = () => {};
          let live = true;
          const run = document.createElement("button");
          run.type = "button";
          run.className = "media-load";
          const action = document.createElement("span");
          action.className = "media-load-action";
          action.textContent = "Run HTML";
          const says = document.createElement("span");
          says.className = "media-load-from";
          const say = () => void (says.textContent = sites.length ? `Written in this note. It runs shut off from the app, and can reach ${sites.join(", ")}.` : "Written in this note. It runs shut off from the app and the network.");
          say();
          drawn.add(say);
          run.append(action, says);
          const start = (grant: string | null) => {
            drawn.delete(say);
            const made = sandboxed(body, { title: "HTML embed", grant });
            stop = made.stop;
            run.replaceWith(made.frame);
          };
          run.addEventListener("click", () => {
            const said = sites;
            if (said.length === 0) return start(null);
            run.disabled = true;
            host.perform({ type: "plugin.frame", id: "html" }).then(
              (grant) => {
                if (!live) return;
                // It runs only with the reach the button named. If that has changed, the button says what it is now and waits to be pressed again.
                if (grant.token && grant.origins.join(" ") === said.join(" ")) return start(grant.token);
                run.disabled = false;
                learn(grant.token ? grant.origins : []);
              },
              () => void (run.disabled = false),
            );
          });
          into.append(run);
          return () => {
            live = false;
            drawn.delete(say);
            stop();
          };
        },
      },
    });
  },
};
