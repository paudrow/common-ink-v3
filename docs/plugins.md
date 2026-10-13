# Plugins

Most of the web app is plugins. The core is the workspace's data, the editor for one note, focus, the inspector's frame, and the plugin host. The sidebar, folder tree, a folder's list of notes, tabs and splits, command palette, quick open, History, Agents, and the rest are built-in plugins in `src/web/plugins/`.

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
      for: "note",
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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `editor`, `folder`, `inspector`, `page`, `bar`, and `overlay`. A page gets a `go.<id>` command. A page is also shown at every address under its path, so the Plugins page at `/plugins` is the page at `/plugins/tabs` too, and reads which from `app.path`. A page registered at exactly that address wins. A page is opened in the editor area as a note is, which with Tabs and splits on is in a tab, and it does nothing for that: see [Pages are tabs](#pages-are-tabs).
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`.
- `host.editorExtensions` registers an editor extension, added to the editor of every note. It is a value, or a function of the editor that is told its note.
- `host.onNavigate(listener)` calls the listener each time the app arrives at an address.
- `host.report(error)` says on the Plugins page that the plugin is on and something it is for didn't work.
- `host.app()` is the app as it is now: the open note, the notes and folders, and what can be done about them. A view is handed the same thing as its `app` prop.
- `host.perform(op)` performs a workspace operation as the member. The operations are the ones in `src/core/protocol.ts`, except the two on settings.
- `host.settings` reads the plugin's own options.
- `host.storage` keeps JSON for this plugin, in this browser, for this workspace.
- `host.agents` lists, connects, and disconnects the member's agents.
- What the editor area has in front is `app.opened`: `{ kind: "note", id }`, or `{ kind: "folder", id }` for a folder's list of notes, where `id` is a folder's id, or `ALL_NOTES` for every note. `app.noteId` and `app.note` are the note's when a note is in front and null otherwise. `app.folderId` is the folder in front: the one whose list is open, or the folder of the note in front, which is what the folder tree marks. `app.openFolder(id, { preview })` opens a folder's list (a preview unless said, which gives way to the next thing previewed), `app.folderPath(id)` is its address (`/folder/<id>`, `/folder/all`), and `folderTitle(folders, id)` is what it is called. `app.openNote(id, { background: true })` opens a note in a tab of its own without leaving what is in front. There is one preview in the window at most, so a note previewed takes the place of whatever preview is there, a folder's list among them. `app.createNote(folderId?)` puts the note in that folder when it is one, otherwise in the folder in front, otherwise in Unsorted.
- **The `folder` slot** draws a folder's list of notes wherever a folder is open: in a tab when the tabs plugin is on, alone at the folder's address when it is off. It is handed `folderId`, which may name no folder the member can see, and `readNote(noteId)`, which draws a note's text to be read and not changed, as its editor draws it, at its full height. The last view registered is used. With none, the core lists the folder's notes by title. A page that lists notes the same way draws them with `app.readNote(noteId)`, which is the same function: the Search page is the note list's `NoteFinder` (`plugins/noteList.tsx`) of every note, with its view kept in the address where a folder's tab keeps its own for as long as the app is open. With no `editor` view, `/` lists every note, and the command `notes.all` opens that list from anywhere, so there is a way to a note whatever is turned off. No page can be registered at `/folder` or under it.
- **The `editor` slot** is asked to open what the app would otherwise go to: `open(tab, { preview, background })` with a note, a folder's list or a page, and it calls `app.show(tab)` with what ends up in front. It is handed `renderNote`, `renderFolder` and `renderPage` to draw what its tabs hold, `empty` to draw where nothing is open (a line saying to pick a note), and `controls`, the buttons that act on the window and on no one note, one group holding the sidebar's and the inspector's, which it puts once: at the top left corner of the editor area, before the first tab. Focus is the editor area's own to offer: it draws a button for it wherever something can fill the window (the Tabs plugin puts one at the right end of every group's tab row), reads `app.focus`, and calls `app.setFocus(on)`. While `app.focus` is true it puts `data-focus-mode` on its `.groups` element and `data-front` on the one `.group` to show, and the app's styles lay that group over the window and hide the rest. A change that moves a tab to another group (a split, a send) calls `app.setFocus(false)`, so the member sees where it went. An editor area that can show two things at once also has `split(tab, side)`, which opens a note, a folder's list or a page in a part of its own, right of or under what is in front, and keeps it there. `app.openBeside(tab, side)` goes to it, and is null where there is no such editor area.
- **The `column` slot and the closed sidebar.** There are three things a member opens and closes, each kept in the browser: the sidebar (`view.toggleSidebar`, `mod+\`), the inspector (`view.toggleInspector`) and focus (`view.toggleFocus`, `mod+.`). In focus what is in front in the editor area fills the window. At an address with nothing there no group is drawn, so nothing is hidden either: the window is whole until something is in front again. Nothing is taken out of the page for it: the `column` view, the inspector and their bars stay drawn, out of sight (`visibility: hidden`), so leaving focus puts everything back as it was. A `column` view is always drawn. While `app.sidebarOpen` is false it draws itself as a narrow bar of icons, `<nav class="rail">`, for what it lists when open, and `app.toggleSidebar()` opens it again. There is no `rail` slot any more: only the Sidebar plugin used it, for icons once shown down the left edge, and the closed bar is the sidebar's own to draw.
- **A page's link drags and splits by itself.** The Sidebar plugin draws every page that has a `nav` with one component, `PageLink`, in the open sidebar, under More, and in the closed bar. That link is dragged into the editor area as a tab is, to the middle of a group or to one of its edges, and its menu has "Open in a split right" and "Open in a split down" wherever `app.openBeside` is there. A plugin that registers a page does nothing for either. A view of its own that wants the same puts what it stands for on the drag with `carry(e.dataTransfer, tab)`, as a folder's row does, and calls `app.openBeside`. `carried` and `carriesTab` are for the side that takes the drop.
- **The `bar` slot: the bottom bar.** One thin line along the foot of the window, 26px tall, for small things to glance at, as an editor's status bar is. Any plugin puts an item in it: `host.views.register("bar", { id, component, side, order })`. `side` is `"left"` (the default) or `"right"`, the end it sits at. `order` places it among the others at that end, lowest first, 0 unless said; items of one order stay in the order of their plugins. The component is handed `app` like any view and draws its content, text or a button, which the app sets in the bar. One that returns nothing takes no room. The bar is drawn while any plugin has an item in it, whether or not the item has something to say, so nothing above it moves as items come and go, and with no item registered there is no bar. In focus it is out of sight. Word count (`word-count`) is the built-in that uses it: at the right end, the words and reading time of the note in front, or how many of its words are selected.
- **`useOpenNote(noteId)`** is a hook the API exports for a view that says something of a note being written, such as a bar item about `app.noteId`. It answers with `{ text, selected }` as the note's editor holds them now, typing not yet saved included, and draws the view again as either changes. It is null when the note isn't open in an editor. A note open in several editors at once, as another editor area may have it, is read from the one the member was last in, and from another when that one closes. `text` is the same string until the note changes, so a view can count it once and not again as the caret moves. Nothing is asked of the server.
- **The `inspector` slot.** The inspector is about what the editor area has in front, and each view says what it is `for`: `"note"`, `"folder"` or `"page"`. A view is a tab only while one of those is in front, and its component is handed that thing beside `app`: `{ note }` for a note, `{ folderId, name, notes }` for a folder's list, `{ page }` for a page (`Inspected` in the API). A note's views and a folder's are different views with their own ids, which may share a label: History registers `history` for a note and `folder-history` for a folder, and Note info registers `info` and `folder-info`. No built-in has a view for a page, so with a page in front the inspector says "Nothing to show for this view". `badge(app)` flags a tab, as History flags changes the member hasn't seen. With the inspector closed, the bar in its place has an icon for each view for what is in front, with the same flag, and an icon opens the inspector on its view.
- **One remembered pick.** The inspector remembers one tab per person, in this browser: the id of the view they last picked, whatever was in front then. What shows is the view with that id, or else the view with the same label among those for what is in front, so someone who picked Info on a note is shown Info on a folder. Where there is neither, the pick is kept for the next thing that has it, and what shows is the first view with no `badge`: a view with one counts what it flags as seen by being shown, as History does, so it shows unasked only when it is all there is. Someone who has picked nothing is shown Info (`UNPICKED`, the id `info`) and not the first tab, because showing a note's History counts its changes as seen. Only a click on a tab or on an icon in the closed bar changes the pick.
- **Pages are tabs.** <a id="pages-are-tabs"></a>`Opened`, what the editor area has in front and what `app.opened`, `app.show` and the `editor` slot's `open` speak of, has a third kind: `{ kind: "page", id, path }`, where `id` is the page's id and `path` the address it is at. The core makes it from the address, so `app.go("/search")`, a link, the `go.<id>` command and Back all open or turn to the page's tab, and no plugin registers anything more than its `page` view. A page is one tab wherever under its path it is: going from `/plugins` to `/plugins/tabs` moves that tab and opens no other, and the tab keeps the address, so it comes back to it when it is turned to again or the app is reloaded. Two pages can be open side by side, so a page is drawn with an `app` whose `path` and `pageState` are its own and whose `opened` is itself, with `noteId`, `note` and `folderId` null as they were when a page had the editor area to itself. `host.app()` is still the app as a whole, at the address of the tab in front. A page is drawn only while its tab is showing, so what it must keep while another tab is in front belongs in its address. One page is not a tab: a page registered `transient: true` only leads somewhere else, so it is drawn in place of the editor area for that moment and leaves no tab behind. The editor area stays as it is underneath, out of sight, so no open editor is made again.
- **`ResizeHandle`** from the plugin API is the edge between two parts of the window that is dragged to give one more room: a focusable `role="separator"` with the arrow keys, Home, End, Enter and a double-click to put it back. The core uses it for the sidebar's and the inspector's inner edges, whose widths it keeps in the browser for each member, and Tabs and splits for the edge between two groups. The `column` view, while it is open, and the inspector's tabs are given their width and do nothing for it.

A plugin does not call `fetch` or read `localStorage`. The host is where a third-party plugin's permissions will be checked, so a plugin that goes around it can't be trusted later.

## What a plugin says of itself

Three optional fields are what the Plugins page shows of a plugin. Every built-in has the first two, which `test/core/plugin-declarations.test.ts` checks.

- `description`: one line on what it is for, said beside its name in the list and at the top of its details. It names no other plugin, so a row is found by its plugin's name alone.
- `icon`: one of the app's own icons, by name (`IconName`). Without one the plugin stands under the picture every plugin has.
- `screenshots`: pictures of it at work, shown in its details: each `{ src, dark?, alt }`. `src` is a file the app serves, `dark` is the same picture taken in the dark theme and is shown in its place there, and `alt` says what the picture shows and is its caption.

Nothing else on the Plugins page is written by hand. A plugin's details list what it adds from what it registered: its commands, its views by slot, its embeds, its editor extensions and its settings (`PluginState.adds` in `src/web/pluginHost.ts`). A plugin that is off is listed with what it added when it was last on, and one that hasn't been on since the app loaded says so, since nothing but running `activate` could tell.

## Options

A plugin's `settings` are its options, by name. Each is a `Setting`: a `type` (`boolean`, `string`, `number`, `integer`, or `chords`), a `default`, a `title`, and optionally a `description`, an `enum` or `maxLength` for a string, and a `minimum` and `maximum` for a number. The words are JSON Schema's. They are plain data, so the app lists them without running the plugin, and they stay listed while it is off.

An option named `unit` in the plugin `word-count` is the setting `word-count.unit`. The member changes it in the plugin: its details on the Plugins page have every option it declares, each with the control its schema asks for, the reason a value was refused, and Reset. The Settings page has the same options, in the plugin's own category under "Plugins" and in the JSON. Both draw one component (`SettingRow`) and write the one setting, so they are always in step, and only a value that differs from the default is kept. A plugin does nothing for either: declaring the option is all.

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

A note is also drawn where it is only read: an expanded card in a folder's list. That drawing gets the same extensions, called with `{ noteId, reading: true }`, and it can be there beside the note's editor, more than once. So an extension that keeps a note's editor by the note's id (to read its text, or to put the cursor in it) leaves a reading out. Nothing a reading does changes the note. `isReading(state)` from the plugin API says whether a state is a reading's, and `touched` and `lineTouched` in `plugins/lib/live.ts` answer false there, so nothing in a reading is shown as written whatever is selected. A link's shared page is a reading too. `TITLE_MARK` is the `# ` an empty note is opened with in its editor, which vim reads to start such a note in insert mode. A reading is not an editor: an extension that is only for editing, as vim and line numbers are, gives a reading nothing (`(editor) => (editor.reading ? [] : extension)`), so it has no cursor, no mode bar and no keys, and its text is selected and copied as a page's is.

A panel an extension shows under the text (`showPanel`, as vim's mode bar is) is put at the foot of the note's pane by the editor, outside the scrolling text and as wide as the pane, one for each editor. It is styled in `style.css` under `.note-foot`, since it is no longer inside `.cm-editor` for an editor theme to reach.

Plugins' extensions come before the editor's own, in the order of the plugins, so a plugin's keys are tried before the editor's. Wrap one in `Prec` to place it more exactly. An extension given as a value is shared by every editor. Keep what belongs to one editor in a `StateField` or a `ViewPlugin`, or give a function.

A plugin whose editing is heavy loads it when it starts, as Vim mode does with `import("./editing.ts")`, and registers the extension when the import settles unless it was turned off meanwhile. If the import fails it calls `host.report(error)`, which shows the reason against the plugin on the Plugins page.

One limit, for #11 to weigh:

- Only the check when an extension is added, or made for an editor, reaches the Plugins page. An extension that throws later, while an editor is running, is CodeMirror's to log, and nothing holds it against its plugin.

## Keybindings

In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key: on a Mac it is its own key, and elsewhere it is the same key as `mod`, so `ctrl+o` and `mod+o` are one chord there.

The app tries a keybinding before the editor or anything else with focus sees the key, and a key that ran a command goes no further: not to the editor, and not to a key handler of the element that has focus. A command that should stand aside at times gives `when`, a function that answers whether its keys run it now. While it answers false the key is left to whatever has focus. Vim mode's `vim.back` answers false in a text field and in a note in insert mode, where `ctrl+o` is the field's or vim's own.

A command's `keys` are its default chords. The member's are settings too: `keybindings.<command id>` holds a list of chords, and an empty list unbinds the command. The member changes them in the Keyboard shortcuts category of the Settings page, a table of every command with its keys and whether they are the default or the member's: Record takes the keys wanted as they are pressed, one after another for a sequence, with Start over to take them back, and Reset goes back to the default. It warns when another command already has the keys, or has keys that these begin or go on from. A press in the recorder is written down and runs nothing. Enter saves there and Escape cancels, so those two alone are bound in the JSON. A member's keys are whatever the app can run a command on: one chord, with a modifier or bare, or a sequence. Keys that would type, whose first chord has no `mod`, `ctrl`, or `alt` and is neither Escape nor an F key, are left to a field or a note's text while one has focus, unless their command gives a `when` and so says for itself where it runs. So no key that types in a note runs a command that didn't ask to be run there. Enter and Space, alone or with Shift, are likewise left to a button, a link, a checkbox or another control that acts on them while it has focus, unless their command gives a `when`. The palette shows the chord that runs a command now. A plugin does nothing to take part.

A command's default `keys` may be a sequence: chords pressed one after another, written with spaces between them, such as `g g` or `ctrl+w h`. The keys that begin a sequence are taken only while a command that can run now goes on from them, so `g` is nobody's key in a text field. A key that doesn't go on from what was begun runs what it runs by itself, and otherwise goes nowhere. A sequence that was begun is given up when focus moves, when the pointer is pressed, or after a second and a half, and then the next key is whatever it would have been with nothing begun. A default may also be a bare key such as `j`: give such a command a `when` that answers false wherever the key would be typed, since a command with a `when` is trusted with it and one without is never run by such a key while something is being typed in. Don't give one command a key that begins another's sequence: the shorter keys run on their last press and the longer never do. A member who does is told so, in Settings.

### Lists, rows and regions: vim's keys outside a note

With Vim mode on, vim's keys work outside a note's text. They are one table in `plugins/vim/keys.ts`: each row is a surface, the keys, and the command they run, and every row is registered as a command under `vim.`, so the keys are listed in Settings among the keyboard shortcuts and a member can change or remove them. In what an embed draws in a note, the list, row, search and tab surfaces answer no: the keys there are the embed's. Ctrl-w still leaves it. A surface is a question about where focus is, answered by `plugins/vim/surfaces.ts`, and it is the command's `when`.

| Surface | Keys | What they do |
| --- | --- | --- |
| A list, when nothing is being typed | `j` `k`, `g g` `G`, `ctrl+d` `ctrl+u` | next and previous row, first and last, half a page down and up |
| The selected row | `enter` or `l`, `z a`, `h` | open it; expand or collapse it, by its `data-row-toggle` or its button with `aria-expanded`; collapse it, or go to its parent |
| Anywhere a search box is in reach, when nothing is being typed | `/` | go to the search box |
| A text field with a list in reach | `ctrl+j` or `ctrl+n`, `ctrl+k` or `ctrl+p` | next and previous row of the list the field is for |
| A search box, or the field of a row | `escape` | back to the list |
| Anywhere but a text field or a note in insert mode | `ctrl+w` then `h` `j` `k` `l` | the region on that side |
| Anywhere but a note or a text field | `g t`, `g T` | next and previous tab |

In a note in normal mode `gt` and `gT` are mapped in vim itself, to the same commands, since `g` begins many of vim's own keys there.

None of this names a plugin or a page. The keys find lists, rows and regions by what the page says they are, so a plugin's view takes part by saying so:

- **A list** is an element with `role="tree"`, `role="listbox"`, `role="list"` or `role="menu"`, a `<ul>` or `<ol>` with an `aria-label` or `aria-labelledby`, or anything with `data-list`.
- **Its rows** are its `role="treeitem"`, `role="option"` and `role="menuitem…"` elements and anything inside it with `data-row`. A list that has none of those has its children as rows.
- **The selected row** is the one with focus in it. Focus rests on the row when the row can take it, and otherwise on the first thing in it that can be pressed. A row that begins with a text field is given focus itself, so nothing is typed into the field until the member opens the row. The row is marked with `data-vim-at`, which `style.css` draws, and scrolled into view.
- **A list with its own keys** is one that takes focus itself (it has a `tabindex`) and keeps its own cursor, as History's list of changes does with `aria-activedescendant`. Vim's `j` and Ctrl-w put focus on that list and from there every key is the list's own: none of vim's list or row keys run while focus is on it.
- **Opening a row** clicks what the row marks `data-row-open`, or else the row when it is itself the thing pressed, or its first link, or goes into the field it begins with, or clicks what it rests on. Mark the opener when a row has a checkbox before it, as a todo has. A note that comes to the front because of it takes focus in normal mode.
- **`h`** clicks the `data-row-toggle` of a row whose `aria-expanded` is true. Otherwise it goes to the row before it with a lower `aria-level`, or to the row a nested list is in.
- **A list a field is for**: `ctrl+j` and `ctrl+k` are sent to the field as the arrow keys Down and Up, so a field that already answers those needs nothing. A field that doesn't answer them sends focus to the first or last row of the nearest list.
- **A region** is an `<aside>`, `<main>`, or anything with `data-region`; of two that nest, the inner one. Going to a region puts focus where it last was there, or in its note's text, or on its list's row. `data-focused` marks the region to start from when focus is nowhere.
- **Tabs** are the `role="tab"` elements of the first `role="tablist"` in the region, and the one in front has `aria-selected="true"`.

## Turning plugins off

A plugin with `enabledByDefault: false` is off until the member turns it on. Its setting `<id>.enabled` then defaults to false, and only `true` is kept in the member's document.

A member turns a plugin off on the Plugins page, on the plugin's card or in its details, or from the palette (`Disable plugin: Tabs and splits`). Both write the setting `tabs.enabled`, so the choice follows the member to another browser. The Settings page has no switch for a plugin: it shows the setting only as a line of the JSON.

The Plugins page is under More in the sidebar and the Settings page is in the workspace menu. The Plugins page lists each plugin as a card, like a note in a folder's list: a press anywhere on the card opens the plugin's details (the name is a link laid over the card), and the switch on it still only switches. They are always at `/plugins` and `/settings`, and each has a `go.` command. They belong to the core, so they are there by their address when the palette and the sidebar are off. A plugin's details are at `/plugins/<plugin id>`, and a category of settings at `/settings/<category>`, such as `/settings/keyboard` and `/settings/plugins/<plugin id>`; `/settings/json` is the JSON.

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
