# Plugins

Most of the web app is plugins. The core is the workspace's data, the editor for one note, writing mode, the inspector's frame, and the plugin host. The sidebar, folder tree, a folder's list of notes, tabs and splits, command palette, quick open, History, Agents, and the rest are built-in plugins in `src/web/plugins/`.

The plugin API is one module, `src/web/plugin-api.ts`. Its doc comments are the reference. A plugin imports that module and nothing else from the app. `test/core/plugin-boundary.test.ts` fails when a file under `src/web/plugins/` breaks that rule.

## A plugin

A plugin is a value with an id, a name, and an `activate` function. The host calls `activate` when the plugin is turned on and hands it a `PluginHost`. Everything the plugin registers is taken back out when it is turned off. A plugin that starts anything else, such as a timer, returns a function from `activate` that stops it.

```tsx
import type { Plugin } from "../plugin-api.ts";

export const wordCount: Plugin = {
  id: "word-count",
  name: "Word count",
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
      component: ({ note }) => <p>{note.snippet.split(/\s+/).filter(Boolean).length} words in the first lines</p>,
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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `rail`, `editor`, `folder`, `inspector`, `page`, and `overlay`. A page gets a `go.<id>` command.
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`.
- `host.app()` is the app as it is now: the open note, the notes and folders, and what can be done about them. A view is handed the same thing as its `app` prop.
- `host.perform(op)` performs a workspace operation as the member. The operations are the ones in `src/core/protocol.ts`.
- `host.storage` keeps JSON for this plugin, in this browser, for this workspace.
- `host.agents` lists, connects, and disconnects the member's agents.
- What the editor area has in front is `app.opened`: `{ kind: "note", id }`, or `{ kind: "folder", id }` for a folder's list of notes, where `id` is a folder's id, or `ALL_NOTES` for every note. `app.noteId` and `app.note` are the note's when a note is in front and null otherwise. `app.folderId` is the folder in front: the one whose list is open, or the folder of the note in front, which is what the folder tree marks. `app.openFolder(id, { preview })` opens a folder's list (a preview unless said, which gives way to the next folder previewed and never to a note), `app.folderPath(id)` is its address (`/folder/<id>`, `/folder/all`), and `folderTitle(folders, id)` is what it is called. `app.openNote(id, { background: true })` opens a note in a tab of its own without leaving what is in front. `app.createNote(folderId?)` puts the note in that folder when it is one, otherwise in the folder in front, otherwise in Unsorted.
- **The `folder` slot** draws a folder's list of notes wherever a folder is open: in a tab when the tabs plugin is on, alone at the folder's address when it is off. It is handed `folderId`, which may name no folder the member can see, and `readNote(noteId)`, which draws a note's text to be read and not changed, as its editor draws it, at its full height. The last view registered is used. With none, the core lists the folder's notes by title. A page that lists notes the same way draws them with `app.readNote(noteId)`, which is the same function: the Search page is the note list's `NoteFinder` (`plugins/noteList.tsx`) of every note, with its view kept in the address where a folder's tab keeps its own for as long as the app is open. With no `editor` view, `/` lists every note, and the command `notes.all` opens that list from anywhere, so there is a way to a note whatever is turned off. No page can be registered at `/folder` or under it.
- **The `editor` slot** is asked to open what the app would otherwise go to: `open(tab, { preview, background })` with a note or a folder's list, and it calls `app.show(tab)` with what ends up in front. It is handed `renderNote` and `renderFolder` to draw what its tabs hold.

A plugin does not call `fetch` or read `localStorage`. The host is where a third-party plugin's permissions will be checked, so a plugin that goes around it can't be trusted later. Settings are not in the API.

## Turning plugins off

A member turns a plugin off from the palette (`Disable plugin: Tabs and splits`) or on the Plugins page, which is in the workspace menu and always at `/plugins`. The page belongs to the core, so it is there when the palette and the sidebar are off. The choice is kept in this browser per member and workspace until settings hold it.

With every plugin off, the core still opens the note its address names, takes typing, and saves.

A plugin whose `activate` throws is left out whole. A view that throws while being drawn is left out alone, and an embed that throws is shown as it is written. Either way the Plugins page says what failed.

## What third-party plugins must not get as it is

The built-in plugins are trusted, and the host gives them more than an untrusted plugin can have. Third-party plugins (#16) need each of these gated first:

- `host.perform` runs as the member with the member's whole access, and the server records the member, not the plugin, as the author.
- `host.agents.connect` mints a token that acts as the member.
- `host.commands.run` runs any command, including `plugins.disable.<another plugin>`.
- `Embed.render` is handed a real element inside the note, so it can reach the rest of the page from there.
- `host.storage` is the browser's localStorage under a prefix, which any script on the page can read.
- A view is handed `app`, which carries the member's email, every note's title and first lines, `signOut`, and `switchWorkspace`. Each view is drawn with the `app` its own plugin is given (`provide` in `Workspace.tsx`), so that is the one place to narrow it.
