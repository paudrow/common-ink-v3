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
          const run = document.createElement("button");
          run.type = "button";
          run.className = "media-load";
          const action = document.createElement("span");
          action.className = "media-load-action";
          action.textContent = "Run HTML";
          const says = document.createElement("span");
          says.className = "media-load-from";
          says.textContent = "Written in this note. It runs shut off from the app and the network.";
          run.append(action, says);
          run.addEventListener("click", () => {
            const made = sandboxed(body, { title: "HTML embed" });
            stop = made.stop;
            run.replaceWith(made.frame);
          });
          into.append(run);
          return () => stop();
        },
      },
    });
  },
};
