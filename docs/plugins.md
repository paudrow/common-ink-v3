# Plugins

Most of the web app is plugins. The core is the workspace's data, the editor for one note, focus, the inspector's frame, and the plugin host. The sidebar, folder tree, a folder's list of notes, tabs and splits, command palette, quick open, History, Agents, and the rest are built-in plugins in `src/web/plugins/`.

The plugin API is one module, `src/web/plugin-api.ts`. Its doc comments are the reference. A plugin imports that module and nothing else from the app. `test/core/plugin-boundary.test.ts` fails when a file under `src/web/plugins/` breaks that rule.

## A plugin

A plugin is a value with an id, a name, an `activate` function, and optionally what it says of itself. The host calls `activate` when the plugin is turned on and hands it a `PluginHost`. Everything the plugin registers is taken back out when it is turned off. A plugin that starts anything else, such as a timer, returns a function from `activate` that stops it.

```tsx
import type { Plugin } from "../plugin-api.ts";

export const wordCount: Plugin = {
  id: "word-count",
  name: "Word count",
  description: "The open note's word count, in the inspector.",
  icon: "text",
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
      for: "note",
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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `editor`, `folder`, `inspector`, `page`, `bar`, and `overlay`. A page gets a `go.<id>` command. A page is also shown at every address under its path, so the Plugins page at `/plugins` is the page at `/plugins/tabs` too, and reads which from `app.path`. A page registered at exactly that address wins. A page is opened in the editor area as a note is, which with Tabs and splits on is in a tab, and it does nothing for that: see [Pages are tabs](#pages-are-tabs).
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`.
- `host.app()` is the app as it is now: the open note, the notes and folders, and what can be done about them. A view is handed the same thing as its `app` prop.
- `host.perform(op)` performs a workspace operation as the member. The operations are the ones in `src/core/protocol.ts`.
- `host.storage` keeps JSON for this plugin, in this browser, for this workspace.
- `host.agents` lists, connects, and disconnects the member's agents.
- What the editor area has in front is `app.opened`: `{ kind: "note", id }`, or `{ kind: "folder", id }` for a folder's list of notes, where `id` is a folder's id, or `ALL_NOTES` for every note. `app.noteId` and `app.note` are the note's when a note is in front and null otherwise. `app.folderId` is the folder in front: the one whose list is open, or the folder of the note in front, which is what the folder tree marks. `app.openFolder(id, { preview })` opens a folder's list (a preview unless said, which gives way to the next thing previewed), `app.folderPath(id)` is its address (`/folder/<id>`, `/folder/all`), and `folderTitle(folders, id)` is what it is called. `app.openNote(id, { background: true })` opens a note in a tab of its own without leaving what is in front. There is one preview in the window at most, so a note previewed takes the place of whatever preview is there, a folder's list among them. `app.createNote(folderId?)` puts the note in that folder when it is one, otherwise in the folder in front, otherwise in Unsorted.
- **The `folder` slot** draws a folder's list of notes wherever a folder is open: in a tab when the tabs plugin is on, alone at the folder's address when it is off. It is handed `folderId`, which may name no folder the member can see, and `readNote(noteId)`, which draws a note's text to be read and not changed, as its editor draws it, at its full height. The last view registered is used. With none, the core lists the folder's notes by title. A page that lists notes the same way draws them with `app.readNote(noteId)`, which is the same function: the Search page is the note list's `NoteFinder` (`plugins/noteList.tsx`) of every note, with its view kept in the address where a folder's tab keeps its own for as long as the app is open. With no `editor` view, `/` lists every note, and the command `notes.all` opens that list from anywhere, so there is a way to a note whatever is turned off. No page can be registered at `/folder` or under it.
- **The `editor` slot** is asked to open what the app would otherwise go to: `open(tab, { preview, background })` with a note, a folder's list or a page, and it calls `app.show(tab)` with what ends up in front. It is handed `renderNote`, `renderFolder` and `renderPage` to draw what its tabs hold, `empty` to draw where nothing is open (a line saying to pick a note), and `controls`, the buttons that act on the window and on no one note, one group holding the sidebar's and the inspector's, which it puts once: at the top left corner of the editor area, before the first tab. Focus is the editor area's own to offer: it draws a button for it wherever something can fill the window (the Tabs plugin puts one at the right end of every group's tab row), reads `app.focus`, and calls `app.setFocus(on)`. While `app.focus` is true it puts `data-focus-mode` on its `.groups` element and `data-front` on the one `.group` to show, and the app's styles lay that group over the window and hide the rest. A change that moves a tab to another group (a split, a send) calls `app.setFocus(false)`, so the member sees where it went. An editor area that can show two things at once also has `split(tab, side)`, which opens a note, a folder's list or a page in a part of its own, right of or under what is in front, and keeps it there. `app.openBeside(tab, side)` goes to it, and is null where there is no such editor area.
- **The `column` slot and the closed sidebar.** There are three things a member opens and closes, each kept in the browser: the sidebar (`view.toggleSidebar`, `mod+\`), the inspector (`view.toggleInspector`) and focus (`view.toggleFocus`, `mod+.`). In focus what is in front in the editor area fills the window. Nothing is taken out of the page for it: the `column` view, the inspector and their bars stay drawn, out of sight (`visibility: hidden`), so leaving focus puts everything back as it was. A `column` view is always drawn. While `app.sidebarOpen` is false it draws itself as a narrow bar of icons, `<nav class="rail">`, for what it lists when open, and `app.toggleSidebar()` opens it again. There is no `rail` slot any more: only the Sidebar plugin used it, for icons once shown down the left edge, and the closed bar is the sidebar's own to draw.
- **A page's link drags and splits by itself.** The Sidebar plugin draws every page that has a `nav` with one component, `PageLink`, in the open sidebar, under More, and in the closed bar. That link is dragged into the editor area as a tab is, to the middle of a group or to one of its edges, and its menu has "Open in a split right" and "Open in a split down" wherever `app.openBeside` is there. A plugin that registers a page does nothing for either. A view of its own that wants the same puts what it stands for on the drag with `carry(e.dataTransfer, tab)`, as a folder's row does, and calls `app.openBeside`. `carried` and `carriesTab` are for the side that takes the drop.
- **The `bar` slot: the bottom bar.** One thin line along the foot of the window, 26px tall, for small things to glance at, as an editor's status bar is. Any plugin puts an item in it: `host.views.register("bar", { id, component, side, order })`. `side` is `"left"` (the default) or `"right"`, the end it sits at. `order` places it among the others at that end, lowest first, 0 unless said; items of one order stay in the order of their plugins. The component is handed `app` like any view and draws its content, text or a button, which the app sets in the bar. One that returns nothing takes no room. The bar is drawn while any plugin has an item in it, whether or not the item has something to say, so nothing above it moves as items come and go, and with no item registered there is no bar. In focus it is out of sight. Word count (`word-count`) is the built-in that uses it: at the right end, the words and reading time of the note in front, or how many of its words are selected.
- **`useOpenNote(noteId)`** is a hook the API exports for a view that says something of a note being written, such as a bar item about `app.noteId`. It answers with `{ text, selected }` as the note's editor holds them now, typing not yet saved included, and draws the view again as either changes. It is null when the note isn't open in an editor. Nothing is asked of the server.
- **The `inspector` slot.** The inspector is about what the editor area has in front, and each view says what it is `for`: `"note"`, `"folder"` or `"page"`. A view is a tab only while one of those is in front, and its component is handed that thing beside `app`: `{ note }` for a note, `{ folderId, name, notes }` for a folder's list, `{ page }` for a page (`Inspected` in the API). A note's views and a folder's are different views with their own ids, which may share a label: History registers `history` for a note and `folder-history` for a folder, and Note info registers `info` and `folder-info`. No built-in has a view for a page, so with a page in front the inspector says "Nothing to show for this view". `badge(app)` flags a tab, as History flags changes the member hasn't seen. With the inspector closed, the bar in its place has an icon for each view for what is in front, with the same flag, and an icon opens the inspector on its view.
- **One remembered pick.** The inspector remembers one tab per person, in this browser: the id of the view they last picked, whatever was in front then. What shows is the view with that id, or else the view with the same label among those for what is in front, so someone who picked Info on a note is shown Info on a folder. Where there is neither, the pick is kept for the next thing that has it, and what shows is the first view with no `badge`: a view with one counts what it flags as seen by being shown, as History does, so it shows unasked only when it is all there is. Someone who has picked nothing is shown Info (`UNPICKED`, the id `info`) and not the first tab, because showing a note's History counts its changes as seen. Only a click on a tab or on an icon in the closed bar changes the pick.
- **Pages are tabs.** <a id="pages-are-tabs"></a>`Opened`, what the editor area has in front and what `app.opened`, `app.show` and the `editor` slot's `open` speak of, has a third kind: `{ kind: "page", id, path }`, where `id` is the page's id and `path` the address it is at. The core makes it from the address, so `app.go("/search")`, a link, the `go.<id>` command and Back all open or turn to the page's tab, and no plugin registers anything more than its `page` view. A page is one tab wherever under its path it is: going from `/plugins` to `/plugins/tabs` moves that tab and opens no other, and the tab keeps the address, so it comes back to it when it is turned to again or the app is reloaded. Two pages can be open side by side, so a page is drawn with an `app` whose `path` and `pageState` are its own and whose `opened` is itself, with `noteId`, `note` and `folderId` null as they were when a page had the editor area to itself. `host.app()` is still the app as a whole, at the address of the tab in front. A page is drawn only while its tab is showing, so what it must keep while another tab is in front belongs in its address. One page is not a tab: a page registered `transient: true` only leads somewhere else, so it is drawn in place of the editor area for that moment and leaves no tab behind. The editor area stays as it is underneath, out of sight, so no open editor is made again.
- **`ResizeHandle`** from the plugin API is the edge between two parts of the window that is dragged to give one more room: a focusable `role="separator"` with the arrow keys, Home, End, Enter and a double-click to put it back. The core uses it for the sidebar's and the inspector's inner edges, whose widths it keeps in the browser for each member, and Tabs and splits for the edge between two groups. The `column` view, while it is open, and the inspector's tabs are given their width and do nothing for it.

A plugin does not call `fetch` or read `localStorage`. The host is where a third-party plugin's permissions will be checked, so a plugin that goes around it can't be trusted later. Settings are not in the API.

## What a plugin says of itself

Three optional fields are what the Plugins page shows of a plugin. Every built-in has the first two, which `test/core/plugin-declarations.test.ts` checks.

- `description`: one line on what it is for, said beside its name in the list and at the top of its details. It names no other plugin, so a row is found by its plugin's name alone.
- `icon`: one of the app's own icons, by name (`IconName`). Without one the plugin stands under the picture every plugin has.
- `screenshots`: pictures of it at work, shown in its details: each `{ src, dark?, alt }`. `src` is a file the app serves, `dark` is the same picture taken in the dark theme and is shown in its place there, and `alt` says what the picture shows and is its caption.

Nothing else on the Plugins page is written by hand. A plugin's details list what it adds from what it registered: its commands, its views by slot and its embeds (`PluginState.adds` in `src/web/pluginHost.ts`). A plugin that is off is listed with what it added when it was last on, and one that hasn't been on since the app loaded says so, since nothing but running `activate` could tell.

## Keybindings

A command's default `keys` may be a sequence: chords pressed one after another, written with spaces between them, such as `g g` or `mod+k l`. The keys that begin a sequence are taken only while a command that can run now goes on from them, so `g` is nobody's key in a text field. A key that doesn't go on from what was begun runs what it runs by itself, and otherwise goes nowhere. A sequence that was begun is given up when focus moves, when the pointer is pressed, or after a second and a half, and then the next key is whatever it would have been with nothing begun. A default may also be a bare key such as `j`: it is never run while something is being typed in. Don't give one command a key that begins another's sequence: the shorter keys run on their last press and the longer never do.

## Turning plugins off

A member turns a plugin off on the Plugins page, on the plugin's card or in its details, or from the palette (`Disable plugin: Tabs and splits`). The choice is kept in this browser per member and workspace until settings hold it.

The Plugins page is under More in the sidebar. It lists each plugin as a card, like a note in a folder's list: a press anywhere on the card opens the plugin's details (the name is a link laid over the card), and the switch on it still only switches. It is always at `/plugins` and has a `go.` command. It belongs to the core, so it is there by its address when the palette and the sidebar are off. A plugin's details are at `/plugins/<plugin id>`.

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
