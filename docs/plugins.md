# Plugins

Most of the web app is plugins. The core is the workspace's data, the editor for one note, writing mode, the inspector's frame, and the plugin host. The sidebar, folder tree, note list, tabs and splits, command palette, quick open, History, Agents, and the rest are built-in plugins in `src/web/plugins/`.

The plugin API is one module, `src/web/plugin-api.ts`. Its doc comments are the reference. A plugin imports that module and nothing else from the app. `test/core/plugin-boundary.test.ts` fails when a file under `src/web/plugins/` breaks that rule.

## A plugin

A plugin is a value with an id, a name, an `activate` function, and optionally the `settings` it declares. The host calls `activate` when the plugin is turned on and hands it a `PluginHost`. Everything the plugin registers is taken back out when it is turned off. A plugin that starts anything else, such as a timer, returns a function from `activate` that stops it.

```tsx
import type { Plugin } from "../plugin-api.ts";

export const wordCount: Plugin = {
  id: "word-count",
  name: "Word count",
  settings: {
    unit: { type: "string", default: "words", enum: ["words", "characters"], title: "Count", description: "What the inspector counts." },
  },
  activate(host) {
    host.commands.register({
      id: "wordCount.open",
      title: "Go to the longest note",
      keys: ["mod+alt+l"],
      run() {
        const { notes, openNote } = host.app();
        const longest = [...(notes ?? [])].sort((a, b) => b.snippet.length - a.snippet.length)[0];
        if (longest) openNote(longest.id);
      },
    });

    host.views.register("inspector", {
      id: "words",
      label: "Words",
      icon: "info",
      component: ({ note }) => {
        const unit = host.settings.get<string>("unit");
        const count = unit === "words" ? note.snippet.split(/\s+/).filter(Boolean).length : note.snippet.length;
        return <p>{count} {unit} in the first lines</p>;
      },
    });

    host.embeds.register({
      name: "today",
      title: "Today's date",
      render(el) {
        el.textContent = new Date().toLocaleDateString();
      },
    });
  },
};
```

Add it to `BUILT_INS` in `src/web/plugins/index.ts`. Its place in that list is its place in the palette, the inspector's tabs, and every other slot.

## What a plugin is handed

- `host.commands` registers commands, lists every command, and runs one by id. A command's `keys` are its default chords.
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `rail`, `editor`, `inspector`, `page`, and `overlay`. A page gets a `go.<id>` command.
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`.
- `host.editorExtensions` registers an editor extension, added to the editor of every note. It is a value, or a function of the editor that is told its note.
- `host.onNavigate(listener)` calls the listener each time the app arrives at an address.
- `host.report(error)` says on the Plugins page that the plugin is on and something it is for didn't work.
- `host.app()` is the app as it is now: the open note, the notes and folders, and what can be done about them. A view is handed the same thing as its `app` prop.
- `host.perform(op)` performs a workspace operation as the member. The operations are the ones in `src/core/protocol.ts`, except the two on settings.
- `host.settings` reads the plugin's own options.
- `host.storage` keeps JSON for this plugin, in this browser, for this workspace.
- `host.agents` lists, connects, and disconnects the member's agents.

A plugin does not call `fetch` or read `localStorage`. The host is where a third-party plugin's permissions will be checked, so a plugin that goes around it can't be trusted later.

## Options

A plugin's `settings` are its options, by name. Each is a `Setting`: a `type` (`boolean`, `string`, `number`, `integer`, or `chords`), a `default`, a `title`, and optionally a `description`, an `enum` or `maxLength` for a string, and a `minimum` and `maximum` for a number. The words are JSON Schema's. They are plain data, so the app lists them without running the plugin, and they stay listed while it is off.

An option named `unit` in the plugin `word-count` is the setting `word-count.unit`. The member changes it on the Settings page, as an option under the plugin's name or in the JSON, and only a value that differs from the default is kept.

`host.settings.get(name)` is the option's value now: the member's when it is valid, the default otherwise. A view is drawn again when settings change, so reading it while drawing is enough. Anything else calls `host.settings.subscribe(listener)`.

A plugin cannot change settings. The host has no call for it, and `host.perform` refuses `settings.write` and `settings.read`, so a plugin can't change them through the server either, or read another plugin's. `test/core/plugin-host.test.ts` checks the refusal with a plugin that tries.

Some names are the app's. A command whose id starts with `go.`, `plugins.`, or `settings.` is refused, and so is a page at an address another page has, and the plugin that asked doesn't start. A page still gets its `go.<id>` command, which the host adds. The core and the Settings and Plugins pages start before every other plugin, so none can take an id they need.

The name `enabled` is taken. Every plugin that can be turned off has the setting `<id>.enabled`, and a plugin that declares its own doesn't start.

## Editor extensions

`host.editorExtensions.register({ id, extension })` adds a CodeMirror 6 extension to the editor of every note, including notes already open, in every editor group. Turning the plugin off takes it back out the same way. The settings JSON editor doesn't get them.

```ts
import { EditorView } from "@codemirror/view";

host.editorExtensions.register({ id: "wide-caret", extension: EditorView.theme({ ".cm-cursor": { borderLeftWidth: "3px" } }) });
```

The plugin builds the extension from its own imports of `@codemirror/*`, which are packages and not the app, so the boundary test allows them. The API types `extension` as `object` to keep CodeMirror out of the plugin API's own imports. The app checks the value when it is added: one CodeMirror won't take is left out, and the Plugins page says so.

An extension that needs to know its editor is given as a function. It is handed the editor's context, which carries the id of the note the editor holds, and returns the extension for that editor:

```ts
host.editorExtensions.register({ id: "note-links", extension: ({ noteId }) => linksFrom(noteId) });
```

The function is called once for each editor, when the editor is made or when the extension is added to one already open. Two sides of a split each get their own call with their own note, and an editor holds one note for as long as it lasts. What the function returns is checked the way a value is. If it throws, or returns what CodeMirror won't take, the extension is left out of that editor, the note still opens, and the Plugins page says so. That is known only once an editor has been made, so a broken function shows on the Plugins page after a note has been open and not before.

Plugins' extensions come before the editor's own, in the order of the plugins, so a plugin's keys are tried before the editor's. Wrap one in `Prec` to place it more exactly. An extension given as a value is shared by every editor. Keep what belongs to one editor in a `StateField` or a `ViewPlugin`, or give a function.

A plugin whose editing is heavy loads it when it starts, as Vim mode does with `import("./editing.ts")`, and registers the extension when the import settles unless it was turned off meanwhile. If the import fails it calls `host.report(error)`, which shows the reason against the plugin on the Plugins page.

One limit, for #11 to weigh:

- Only the check when an extension is added, or made for an editor, reaches the Plugins page. An extension that throws later, while an editor is running, is CodeMirror's to log, and nothing holds it against its plugin.

## Keybindings

In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key: on a Mac it is its own key, and elsewhere it is the same key as `mod`, so `ctrl+o` and `mod+o` are one chord there.

The app tries a keybinding before the editor or anything else with focus sees the key, and a key that ran a command goes no further. A command that should stand aside at times gives `when`, a function that answers whether its keys run it now. While it answers false the key is left to whatever has focus. Vim mode's `vim.back` answers false in a text field and in a note in insert mode, where `ctrl+o` is the field's or vim's own.

A command's `keys` are its default chords. The member's are settings too: `keybindings.<command id>` holds a list of chords, and an empty list unbinds the command. A member's chord needs `mod`, `ctrl`, or `alt` unless its key is Escape or an F key, so that no key that types in a note runs a command. The palette shows the chord that runs a command now. A plugin does nothing to take part.

## Turning plugins off

A plugin with `enabledByDefault: false` is off until the member turns it on. Its setting `<id>.enabled` then defaults to false, and only `true` is kept in the member's document.

A member turns a plugin off from the palette (`Disable plugin: Tabs and splits`), on the Plugins page, or in settings, where it is `tabs.enabled`. All three write the same setting, so the choice follows the member to another browser. The Plugins and Settings pages are in the workspace menu and always at `/plugins` and `/settings`. They belong to the core, so they are there when the palette and the sidebar are off.

With every plugin off, the core still opens the note its address names, takes typing, and saves.

A plugin whose `activate` throws is left out whole. A view that throws while being drawn is left out alone, and an embed that throws is shown as it is written. Either way the Plugins page says what failed.

## What third-party plugins must not get as it is

The built-in plugins are trusted, and the host gives them more than an untrusted plugin can have. Third-party plugins (#16) need each of these gated first:

- `host.perform` runs as the member with the member's whole access, and the server records the member, not the plugin, as the author.
- `host.agents.connect` mints a token that acts as the member.
- `host.commands.run` runs any command, including `plugins.disable.<another plugin>`. That command writes the member's settings, so it is a way around the refusal in `host.perform`. The palette needs it to run what the member picks.
- `Embed.render` is handed a real element inside the note, so it can reach the rest of the page from there.
- An editor extension runs inside the editor with the note's text, every key typed, and the page. It must also be built from the app's own copy of `@codemirror/state`, which a plugin loaded from elsewhere doesn't have.
- `host.storage` is the browser's localStorage under a prefix, which any script on the page can read.
- A view is handed `app`, which carries the member's email, every note's title and first lines, `signOut`, and `switchWorkspace`. Each view is drawn with the `app` its own plugin is given (`provide` in `Workspace.tsx`), so that is the one place to narrow it.
