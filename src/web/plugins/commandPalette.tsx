import { HelpOverlay, type Plugin, type PluginHost } from "../plugin-api.ts";
import { Palette } from "./lib/Palette.tsx";
import { shortcutGroups } from "./lib/shortcutGroups.ts";

const SHOW = "commands.show";
const SHORTCUTS = "shortcuts";
const SHORTCUTS_COMMAND = "commands.shortcuts";

/** Every command that has keys now, under its heading, read from the commands as they are when it opens: a key the member changed is shown changed. */
function ShortcutSheet({ host, close }: { host: PluginHost; close: () => void }) {
  const commands = host.commands.list();
  const own = commands.find((c) => c.id === SHORTCUTS_COMMAND)?.keys ?? [];
  return (
    <HelpOverlay title="Keyboard shortcuts" onClose={close}>
      <p className="help-lead">
        {own.length > 0 && (
          <>
            Press <kbd>{own[0]}</kbd> anywhere but where text is typed to open this.{" "}
          </>
        )}
        {own.length > 0 ? "In a note, open it from the command palette." : "Open this from the command palette."}{" "}
        <a
          href="/settings/keyboard"
          onClick={(e) => {
            e.preventDefault();
            close();
            host.app().go("/settings/keyboard");
          }}
        >
          Change the keys in Settings
        </a>
      </p>
      {shortcutGroups(commands).map(({ name, commands }) => (
        <section key={name} className="shortcut-sheet-group">
          <h3>{name}</h3>
          <table aria-label={name}>
            <tbody>
              {commands.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.title}</th>
                  <td>
                    {c.keys.map((keys) => (
                      <kbd key={keys}>{keys}</kbd>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </HelpOverlay>
  );
}

export const commandPalette: Plugin = {
  id: "command-palette",
  name: "Command palette",
  description: "Every command in one list, found by typing and run from the keyboard, and the keys of every command on one sheet.",
  icon: "command",
  activate(host) {
    host.commands.register({ id: SHOW, title: "Show all commands", keys: ["mod+shift+p"], group: "Navigation", run: () => host.app().toggleOverlay("commands") });
    // ? is Shift and / on most keyboards, written as the key it types. Being a key that types, it is left to every field and note.
    host.commands.register({ id: SHORTCUTS_COMMAND, title: "Keyboard shortcuts", keys: ["shift+?"], group: "Navigation", run: () => host.app().toggleOverlay(SHORTCUTS) });
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
    host.views.register("overlay", { id: SHORTCUTS, component: ({ close }) => <ShortcutSheet host={host} close={close} /> });
  },
};
