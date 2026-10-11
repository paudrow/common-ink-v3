# Plugins

Most of the web app is plugins. The core is the workspace's data, the editor for one note, writing mode, the inspector's frame, and the plugin host. The sidebar, folder tree, a folder's list of notes, tabs and splits, command palette, quick open, History, Agents, and the rest are built-in plugins in `src/web/plugins/`.

The plugin API is one module, `src/web/plugin-api.ts`. Its doc comments are the reference. A plugin imports that module and nothing else from the app. `test/core/plugin-boundary.test.ts` fails when a file under `src/web/plugins/` breaks that rule.

## A plugin

A plugin is a value with an id, a name, an `activate` function, and optionally what it says of itself and the `settings` it declares. The host calls `activate` when the plugin is turned on and hands it a `PluginHost`. Everything the plugin registers is taken back out when it is turned off. A plugin that starts anything else, such as a timer, returns a function from `activate` that stops it.

```tsx
import type { Plugin } from "../plugin-api.ts";

export const wordCount: Plugin = {
  id: "word-count",
  name: "Word count",
  description: "The open note's word count, in the inspector.",
  icon: "text",
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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `rail`, `editor`, `folder`, `inspector`, `page`, and `overlay`. A page gets a `go.<id>` command. A page is also shown at every address under its path, so the Plugins page at `/plugins` is the page at `/plugins/tabs` too, and reads which from `app.path`. A page registered at exactly that address wins. A page is opened in the editor area as a note is, which with Tabs and splits on is in a tab, and it does nothing for that: see [Pages are tabs](#pages-are-tabs).
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`.
- `host.app()` is the app as it is now: the open note, the notes and folders, and what can be done about them. A view is handed the same thing as its `app` prop.
- `host.perform(op)` performs a workspace operation as the member. The operations are the ones in `src/core/protocol.ts`, except the two on settings.
- `host.settings` reads the plugin's own options.
- `host.storage` keeps JSON for this plugin, in this browser, for this workspace.
- `host.agents` lists, connects, and disconnects the member's agents.
- What the editor area has in front is `app.opened`: `{ kind: "note", id }`, or `{ kind: "folder", id }` for a folder's list of notes, where `id` is a folder's id, or `ALL_NOTES` for every note. `app.noteId` and `app.note` are the note's when a note is in front and null otherwise. `app.folderId` is the folder in front: the one whose list is open, or the folder of the note in front, which is what the folder tree marks. `app.openFolder(id, { preview })` opens a folder's list (a preview unless said, which gives way to the next folder previewed and never to a note), `app.folderPath(id)` is its address (`/folder/<id>`, `/folder/all`), and `folderTitle(folders, id)` is what it is called. `app.openNote(id, { background: true })` opens a note in a tab of its own without leaving what is in front. `app.createNote(folderId?)` puts the note in that folder when it is one, otherwise in the folder in front, otherwise in Unsorted.
- **The `folder` slot** draws a folder's list of notes wherever a folder is open: in a tab when the tabs plugin is on, alone at the folder's address when it is off. It is handed `folderId`, which may name no folder the member can see, and `readNote(noteId)`, which draws a note's text to be read and not changed, as its editor draws it, at its full height. The last view registered is used. With none, the core lists the folder's notes by title. A page that lists notes the same way draws them with `app.readNote(noteId)`, which is the same function: the Search page is the note list's `NoteFinder` (`plugins/noteList.tsx`) of every note, with its view kept in the address where a folder's tab keeps its own for as long as the app is open. With no `editor` view, `/` lists every note, and the command `notes.all` opens that list from anywhere, so there is a way to a note whatever is turned off. No page can be registered at `/folder` or under it.
- **The `editor` slot** is asked to open what the app would otherwise go to: `open(tab, { preview, background })` with a note, a folder's list or a page, and it calls `app.show(tab)` with what ends up in front. It is handed `renderNote`, `renderFolder` and `renderPage` to draw what its tabs hold, `empty` to draw where nothing is open (a line saying to pick a note), and `controls`, the buttons that act on the window and on no one note (the inspector and writing mode), which it puts once at the top right corner of the editor area. They were in a note's bar, where they read as the note's and were missing whenever no note was in front.
- **Pages are tabs.** <a id="pages-are-tabs"></a>`Opened`, what the editor area has in front and what `app.opened`, `app.show` and the `editor` slot's `open` speak of, has a third kind: `{ kind: "page", id, path }`, where `id` is the page's id and `path` the address it is at. The core makes it from the address, so `app.go("/search")`, a link, the `go.<id>` command and Back all open or turn to the page's tab, and no plugin registers anything more than its `page` view. A page is one tab wherever under its path it is: going from `/plugins` to `/plugins/tabs` moves that tab and opens no other, and the tab keeps the address, so it comes back to it when it is turned to again or the app is reloaded. Two pages can be open side by side, so a page is drawn with an `app` whose `path` and `pageState` are its own and whose `opened` is itself, with `noteId`, `note` and `folderId` null as they were when a page had the editor area to itself. `host.app()` is still the app as a whole, at the address of the tab in front. A page is drawn only while its tab is showing, so what it must keep while another tab is in front belongs in its address. One page is not a tab: a page registered `transient: true` only leads somewhere else, so it is drawn in place of the editor area for that moment and leaves no tab behind.
- **`ResizeHandle`** from the plugin API is the edge between two parts of the window that is dragged to give one more room: a focusable `role="separator"` with the arrow keys, Home, End, Enter and a double-click to put it back. The core uses it for the sidebar's and the inspector's inner edges, whose widths it keeps in the browser for each member, and Tabs and splits for the edge between two groups. The `column` view and the inspector's tabs are given their width and do nothing for it.

A plugin does not call `fetch` or read `localStorage`. The host is where a third-party plugin's permissions will be checked, so a plugin that goes around it can't be trusted later.

## What a plugin says of itself

Three optional fields are what the Plugins page shows of a plugin. Every built-in has the first two, which `test/core/plugin-declarations.test.ts` checks.

- `description`: one line on what it is for, said beside its name in the list and at the top of its details. It names no other plugin, so a row is found by its plugin's name alone.
- `icon`: one of the app's own icons, by name (`IconName`). Without one the plugin stands under the picture every plugin has.
- `screenshots`: pictures of it at work, shown in its details: each `{ src, dark?, alt }`. `src` is a file the app serves, `dark` is the same picture taken in the dark theme and is shown in its place there, and `alt` says what the picture shows and is its caption.

Nothing else on the Plugins page is written by hand. A plugin's details list what it adds from what it registered: its commands, its views by slot, its embeds and its settings (`PluginState.adds` in `src/web/pluginHost.ts`). A plugin that is off is listed with what it added when it was last on, and one that hasn't been on since the app loaded says so, since nothing but running `activate` could tell.

## Options

A plugin's `settings` are its options, by name. Each is a `Setting`: a `type` (`boolean`, `string`, `number`, `integer`, or `chords`), a `default`, a `title`, and optionally a `description`, an `enum` or `maxLength` for a string, and a `minimum` and `maximum` for a number. The words are JSON Schema's. They are plain data, so the app lists them without running the plugin, and they stay listed while it is off.

An option named `unit` in the plugin `word-count` is the setting `word-count.unit`. The member changes it on the Settings page, in the plugin's own category under "Plugins" or in the JSON, and only a value that differs from the default is kept. A plugin's details on the Plugins page list its options and link to that category.

`host.settings.get(name)` is the option's value now: the member's when it is valid, the default otherwise. A view is drawn again when settings change, so reading it while drawing is enough. Anything else calls `host.settings.subscribe(listener)`.

A plugin cannot change settings. The host has no call for it, and `host.perform` refuses `settings.write` and `settings.read`, so a plugin can't change them through the server either, or read another plugin's. `test/core/plugin-host.test.ts` checks the refusal with a plugin that tries.

Some names are the app's. A command whose id starts with `go.`, `plugins.`, or `settings.` is refused, and so is a page at an address another page has, and the plugin that asked doesn't start. A page still gets its `go.<id>` command, which the host adds. The core and the Settings and Plugins pages start before every other plugin, so none can take an id they need.

The name `enabled` is taken. Every plugin that can be turned off has the setting `<id>.enabled`, and a plugin that declares its own doesn't start.

## Keybindings

A command's `keys` are its default chords. The member's are settings too: `keybindings.<command id>` holds a list of chords, and an empty list unbinds the command. The member changes them in the Keyboard shortcuts category of the Settings page, a table of every command with its keys and whether they are the default or the member's: Record takes the keys wanted as they are pressed, one after another for a sequence, with Start over to take them back, and Reset goes back to the default. It warns when another command already has the keys, or has keys that these begin or go on from. A press in the recorder is written down and runs nothing. Enter saves there and Escape cancels, so those two alone are bound in the JSON. A member's keys are whatever the app can run a command on: one chord, with a modifier or bare, or a sequence. Keys that would type, whose first chord has no `mod` or `alt` and is neither Escape nor an F key, are left to a field or a note's text while one has focus. So no key that types in a note runs a command. The palette shows the chord that runs a command now. A plugin does nothing to take part.

A command's default `keys` may be a sequence: chords pressed one after another, written with spaces between them, such as `g g` or `mod+k l`. The keys that begin a sequence are taken only while a command that can run now goes on from them, so `g` is nobody's key in a text field. A key that doesn't go on from what was begun runs what it runs by itself, and otherwise goes nowhere. A default may also be a bare key such as `j`: it is never run while something is being typed in. Don't give one command a key that begins another's sequence: the shorter keys run on their last press and the longer never do. A member who does is told so, in Settings.


## Turning plugins off

A member turns a plugin off on the Plugins page, in the list or in the plugin's details, or from the palette (`Disable plugin: Tabs and splits`). Both write the setting `tabs.enabled`, so the choice follows the member to another browser. The Settings page has no switch for a plugin: it shows the setting only as a line of the JSON.

The Plugins page is under More in the sidebar and the Settings page is in the workspace menu. They are always at `/plugins` and `/settings`, and each has a `go.` command. They belong to the core, so they are there by their address when the palette and the sidebar are off. A plugin's details are at `/plugins/<plugin id>`, and a category of settings at `/settings/<category>`, such as `/settings/keyboard` and `/settings/plugins/<plugin id>`; `/settings/json` is the JSON.

With every plugin off, the core still opens the note its address names, takes typing, and saves.

A plugin whose `activate` throws is left out whole. A view that throws while being drawn is left out alone, and an embed that throws is shown as it is written. Either way the Plugins page says what failed.

## What third-party plugins must not get as it is

The built-in plugins are trusted, and the host gives them more than an untrusted plugin can have. Third-party plugins (#16) need each of these gated first:

- `host.perform` runs as the member with the member's whole access, and the server records the member, not the plugin, as the author.
- `host.agents.connect` mints a token that acts as the member.
- `host.commands.run` runs any command, including `plugins.disable.<another plugin>`. That command writes the member's settings, so it is a way around the refusal in `host.perform`. The palette needs it to run what the member picks.
- `Embed.render` is handed a real element inside the note, so it can reach the rest of the page from there.
- `host.storage` is the browser's localStorage under a prefix, which any script on the page can read.
- A view is handed `app`, which carries the member's email, every note's title and first lines, `signOut`, and `switchWorkspace`. Each view is drawn with the `app` its own plugin is given (`provide` in `Workspace.tsx`), so that is the one place to narrow it.
