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
  description: "HTML written in a note, run shut off from the app when a reader presses Run.",
  icon: "code",
  activate(host) {
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
