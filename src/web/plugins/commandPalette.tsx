import type { Plugin } from "../plugin-api.ts";
import { Palette } from "./lib/Palette.tsx";

const SHOW = "commands.show";

export const commandPalette: Plugin = {
  id: "command-palette",
  name: "Command palette",
  description: "Every command in one list, found by typing and run from the keyboard.",
  icon: "command",
  activate(host) {
    host.commands.register({ id: SHOW, title: "Show all commands", keys: ["mod+shift+p"], run: () => host.app().toggleOverlay("commands") });
    host.views.register("overlay", {
      id: "commands",
      component: ({ close }) => (
        <Palette
          label="Commands"
          placeholder="Run a command"
          empty="No commands match."
          items={host.commands
            .list()
            .filter((c) => c.id !== SHOW)
            .map((c) => ({ id: c.id, label: c.title, hint: c.shortcut }))}
          onPick={(id) => host.commands.run(id)}
          onClose={close}
        />
      ),
    });
  },
};
