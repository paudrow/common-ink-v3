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
  description: "The open note's word count and reading time, in the bottom bar.",
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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `rail`, `editor`, `folder`, `inspector`, `page`, `bar`, and `overlay`. A page gets a `go.<id>` command. A page is also shown at every address under its path, so the Plugins page at `/plugins` is the page at `/plugins/tabs` too, and reads which from `app.path`. A page registered at exactly that address wins. A page is opened in the editor area as a note is, which with Tabs and splits on is in a tab, and it does nothing for that: see [Pages are tabs](#pages-are-tabs).
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`, or `:::name{config}` … `:::` for a block embed. `host.embeds.list()` is every embed that is on, as a menu would offer them.
- `host.completions` registers a completion: a list offered at the cursor while the member types after a trigger, such as the embed menu on `/`.
- `host.editorExtensions` registers an editor extension, added to the editor of every note. It is a value, or a function of the editor that is told its note.
- `host.onNavigate(listener)` calls the listener each time the app arrives at an address.
- `host.report(error)` says on the Plugins page that the plugin is on and something it is for didn't work.
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
- `screenshots`: pictures of it at work, shown in its details: each `{ src, dark?, alt }`. `src` is a file the app serves, `dark` is the same picture taken in the dark theme and is shown in its place there, and `alt` says what the picture shows and is its caption. Kanban and Tables have them, in `public/plugin-shots/`.

Nothing else on the Plugins page is written by hand. A plugin's details list what it adds from what it registered: its commands, its views by slot, its embeds, its completions, its editor extensions and its settings (`PluginState.adds` in `src/web/pluginHost.ts`). A plugin that is off is listed with what it added when it was last on, and one that hasn't been on since the app loaded says so, since nothing but running `activate` could tell.

## Options

A plugin's `settings` are its options, by name. Each is a `Setting`: a `type` (`boolean`, `string`, `number`, `integer`, or `chords`), a `default`, a `title`, and optionally a `description`, an `enum` or `maxLength` for a string, and a `minimum` and `maximum` for a number. The words are JSON Schema's. They are plain data, so the app lists them without running the plugin, and they stay listed while it is off.

An option named `unit` in the plugin `word-count` is the setting `word-count.unit`. The member changes it on the Settings page, in the plugin's own category under "Plugins" or in the JSON, and only a value that differs from the default is kept. A plugin's details on the Plugins page list its options and link to that category.

`host.settings.get(name)` is the option's value now: the member's when it is valid, the default otherwise. A view is drawn again when settings change, so reading it while drawing is enough. Anything else calls `host.settings.subscribe(listener)`.

A plugin cannot change settings. The host has no call for it, and `host.perform` refuses `settings.write` and `settings.read`, so a plugin can't change them through the server either, or read another plugin's. `test/core/plugin-host.test.ts` checks the refusal with a plugin that tries.

Some names are the app's. A command whose id starts with `go.`, `plugins.`, or `settings.` is refused, and so is a page at an address another page has, and the plugin that asked doesn't start. A page still gets its `go.<id>` command, which the host adds. The core and the Settings and Plugins pages start before every other plugin, so none can take an id they need.

The name `enabled` is taken. Every plugin that can be turned off has the setting `<id>.enabled`, and a plugin that declares its own doesn't start.

## Widgets and where they live

A widget is a small live thing to glance at or press. There are three places one lives, and each has a built-in plugin or two that can be turned off like any other.

| Where | How a plugin adds one | Where its state is | Built in |
| --- | --- | --- | --- |
| In a note, inline | `host.embeds.register({ name, render })`, written `::name{config}` | The note: its config | Timer (`timer`), Stopwatch (`stopwatch`) |
| In a note, as a block | `host.embeds.register({ name, block: true, render })`, written `:::name{config}` … `:::` | The note: its config and body | Kanban board (`kanban`) |
| The bottom bar | `host.views.register("bar", { id, component })` | Whatever it shows: the open note, the app | Note clocks (`note-clocks`), Word count (`word-count`) |
| From the command palette only | A command that opens an `overlay` to ask what it needs, and a `bar` view that shows it | This browser, for this workspace: `host.storage` | Quick timer (`quick-timer`) |

Every embed is in the `/` menu, and every command-started widget is a command in the palette.

The other slots are not places for widgets. `column`, `section`, `editor`, and `page` are the structure of the app: where notes are found and read. A `section` is in a popover in writing mode, so a widget there would be out of sight just when a timer matters. `rail` holds icons that open something, not things that are live themselves. The `inspector` holds tabs about the open note, and which tabs it has is part of the product (History, Backlinks, Info), so a count or a clock is in the bar and not a fourth tab. An `overlay` is where a command-started widget asks its question, not where it stays.

**The bottom bar** is one line along the bottom of the app, drawn only while some plugin has a view in it. It is 26px tall whatever is in it, in writing mode too, so a widget that appears or goes moves nothing above it. A bar view that has nothing to show draws nothing. `plugins/lib/openNotes.ts` gives a bar widget the open note's text as the editor has it, typing not yet saved included, through an editor extension of the plugin's own.

**A widget with no note** says where its state is. The quick timer keeps `{ length, since }` under `host.storage`: it runs on through a reload in this browser, another browser doesn't have it, nobody else sees it, there is one at a time, and nothing is written to any note or to History. A viewer can run one.

**Widgets don't flash.** A widget appears whole, at its size, in the first frame it is in, and is changed where it stands after that. `test/browser/widgets-steady.spec.ts` watches every frame from the start of the page, through a reload, typing elsewhere, someone else's change, the embed's own rewrite, the cursor passing, a plugin turned off, and a tab or split opening: no frame shows an embed as written or empty, none is taken out of the page, and each stays the same element at the same place and size. What that asks of a plugin:

- Register an embed in `activate`, not after something has loaded, and draw all of it before `render` returns. An embed whose drawing needs code that isn't loaded yet still registers at once and draws a holder of its final size, which it fills in place. Otherwise the note shows `::name{}` first.
- Give `render` a `Drawn` with `update` when the embed can change what it drew, as the clocks do: the same button shows the new time. Without it the embed's element is emptied and drawn again in one step, which keeps the element and its place and loses anything inside it that the embed didn't keep itself, as kanban keeps a half-typed card.
- Keep its size when its state changes. The clock's reset button is there, unseen, before there is anything to reset, so starting it doesn't push the rest of the line along.
- A tab that comes back makes its editor again, so those are new elements, drawn whole in their first frame.

## Embeds

An embed is drawn where a note writes its name. An inline embed is written `::name{config}` on one line. A block embed, one registered with `block: true`, is written on lines of its own:

```
:::kanban{}
## To do
- write the announcement
## Done
:::
```

The lines between the opening and the closing `:::` are its body. An embed is written one way: `::kanban{}` and `:::timer{5m}` … `:::` both stay as text. So does a block with no closing line, one inside a code fence, and any name nobody registered.

Each embed is drawn in a frame the host owns: the embed draws in the frame's first element, and its options button, where it has one, is the frame's second.

With the cursor on an inline embed it is shown as written, so it can be changed as text, the way the markup around it is, and its drawing is taken out: the line is then exactly what the note says. That would stop a drawing that is doing something, so an embed registered with `live: true`, as the timer and the stopwatch are, is drawn another way. Its drawing is a widget of its own before the embed's text, and the text is hidden after it. With the cursor on the embed the text is shown after the drawing, in gray, and the drawing is the same element, in the same place, doing what it was doing: a running stopwatch keeps running. The line is as tall either way and starts where it did. What comes after a live embed on its line moves over by the width of its text while the cursor is on it, and a line that was nearly full wraps: that is the one thing that moves, and the reason `live` is asked for and not the rule.

A block always stays drawn, with its lines hidden under the drawing. The cursor never goes into the hidden lines. From the line above or below, an arrow key, or vim's `j` and `k`, goes over a block, unless the embed is registered with `entered: true`: then `render` gives back `enter(from)`, with `from` `"above"` or `"below"`, which focuses something it drew and returns true, and the keyboard is the drawing's. The drawing hands it back with `embed.leave("above" | "below")`, which puts the cursor on that line of the note. Kanban does this: its cards and "Add a card" are stops for the arrow keys, Shift with an arrow moves a card, and past the first or last stop of a column the cursor is back in the note. With vim on, `h`, `j`, `k` and `l` in any embed's drawing are the arrow keys (`arrowsInEmbeds` in `plugins/vim/index.ts`), so the same code serves both. An `enter` that returns false, as a board nobody can change with no cards does, sends the cursor over the block. A press, a search, or a key that jumps, such as Ctrl+End, doesn't go in. Where two blocks have no line between them, leaving one lands past the other.

`embed.edit()` puts the cursor in the embed as written: in an inline embed's config, or in a block's lines, which are then shown under the drawing, which stays where it is and follows what is typed. They are hidden again when the cursor leaves them. The host offers it as "Edit as markdown" in every embed's options, which for a block is the only way to its lines.

### Options

Every block a member can change has an options button at its top corner, in a narrow column of its own beside the drawing, so it never lies over what the embed draws. An inline embed has one after its drawing when it declares options. A member who can't change the note has none. The button opens a small panel laid over the app, which moves nothing in the note: a field for each option the embed declares, then "Edit as markdown".

```ts
host.embeds.register({
  name: "timer",
  title: "Timer",
  render,
  options: {
    fields: ({ config }) => [{ id: "length", label: "Length", kind: "text", value: lengthIn(config), hint: "Write it like 25m." }],
    set: ({ config }, id, value) => (durationOf(value) ? { config: withLength(config, value) } : "Write it like 25m."),
  },
});
```

`fields` and `set` are given what the note says of the embed now, `{ config, body }`, and nothing else. A field is `kind: "text"`, typed and taken on Enter or when the keyboard leaves it, or `kind: "choice"`, one of a few `choices`. A choice with a `swatch` is drawn as a dot of that colour: one of `SWATCHES` (`red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `gray`), or `""` for none. Any element with `data-colour` set to one of those names has `--swatch` to draw with, one value for both themes, meant to be mixed into the theme's own surface with `color-mix` as a kanban column does. `set` returns the new `{ config, body }`, which the host writes exactly as `embed.update` does, so it is the member's change, saved, recorded, undone, and seen in every other open editor. Or it returns a sentence saying why the value can't be taken, which is shown under the fields and nothing is written. The embed is then changed where it stands, as after any rewrite, and the panel stays open and shows the new values. `fields` that returns none, as for a config that can't be read, leaves an inline embed with no button.

The timer's option is its length and the stopwatch's is how long it has run. Kanban has a colour for each column, and HTML its height. `test/browser/widgets-cursor.spec.ts` covers the button, the panel, and each of these.

`render(el, embed)` draws into `el` and is handed `embed.config`, `embed.body` (a block's lines, each with its line break), `embed.readOnly`, and two functions:

- `embed.update({ config, body })` rewrites the embed in the note. It is an ordinary edit in that editor by the member: it is saved with their typing, synced, recorded in History as their change, and undone the way typing is. Give only what changes. The edit covers only the characters that differ, so typing elsewhere and other people's changes merge around it.
- `embed.edit()` puts the cursor in the embed as written, and for a block shows its lines.
- `embed.leave(to)`, for a block that takes the keyboard, gives it back to the note.

`embed.readOnly` is true when the member can't change the note, as a viewer can't. The note's editor is then read-only as a whole: no typing, no keys, and `update` does nothing, whatever calls it. An embed draws what it shows and leaves out the controls that would call `update`: the timer is a time that can't be pressed, and the board has no "Add a card", no colours to set and nothing to drag.

`update` called from inside `render` is carried out right after the drawing, since the editor can't be changed while it draws. An embed that tidies its own config that way is drawn twice.

Two members can act on one embed before either sees the other's change, and the server merges their writes as text. An embed's reading of its config should stand that: two presses of one timer leave two `since=` words, and the timer reads the last and writes one back on the next press. Two moves of one kanban card to different columns leave the card in both, which a merge of text can't tell from two cards, so one of them is deleted by hand.

An embed keeps what it knows in the note. The timer keeps its length and how it is running in its config (`::timer{5m since=2026-10-10T12:00:00.000Z}`), so a reload and another member see the same time, and nothing ticks into the note: the time shown is worked out from the instant it started. Kanban keeps nothing but the markdown: `parseBoard` and `serializeBoard` in `plugins/kanban/board.ts` read the body into columns and cards and write it back line for line, so what a board doesn't understand stays where it was. A column's colour is the class its heading ends with, the way Pandoc and kramdown write one: `## Doing {.blue}`. Only the eight names in `SWATCHES` are read as a colour, and any other braces are part of the title.

A clock says what its buttons do: the time, then Start (Stop for a running stopwatch, Pause for a running timer), then Reset. What the buttons say is drawn by the stylesheet from `data-label` and is not text in the note's line, so the time is all a clock adds to it, and the button is as wide whichever word it says.

Each time the note says something else of an embed, whoever changed it, the embed's `update` is called if `render` gave one back, and otherwise `render` is called again on the same element, emptied. Focus then goes to the element whose `data-focus` equals that of the element that had it, so a control that rewrites the note keeps the keyboard. To send focus somewhere else, set `data-focus` on the focused element before calling `update`, as a kanban card does with the place it is moving to.

`update` is checked against the note as it is when called. A drawing that has left the editor, or one of an embed that the note no longer writes that way, does nothing, so a rewrite computed from a stale body can't land on someone else's newer text. A config holding `{`, `}`, or a line break throws, and so does a body with a line that is only `:::`: an embed can't write its way out of its own range. `test/core/plugin-embed-syntax.test.ts` covers the syntax and the edits, and `test/browser/widgets.spec.ts` the rest.

`starts` is what the embed menu writes for a new one: `{ config: "5m" }` for the timer, and a body of three empty columns for kanban.

## Completions

`host.completions.register({ id, trigger, items })` offers a list at the cursor. It opens when the member types the trigger at the start of a line or after a space, and not inside code, so the `/` of a URL, a path, or a date opens nothing. `items(typed)` is asked on each keystroke for what to offer for the text typed after the trigger, best first, and may answer with a promise. One that answers at once is in the list by the member's next key, so a name typed after `/` and Enter with no pause picks it. Completions whose triggers both fit share the list, each one's items together, in the order of their plugins. With nothing from any of them the list closes. Enter and Tab both pick the highlighted item, and with no list open Tab is whatever it is elsewhere in a note. Each item has a `label`, an optional `detail`, and `insert`, the text that takes the place of the trigger and what was typed. `select` leaves part of it selected, `block` puts it on lines of its own, and `spaces: true` on the completion lets what is typed hold spaces, as a note's title does.

```ts
host.completions.register({
  id: "people",
  trigger: "@",
  items: (typed) => people.filter((p) => p.name.toLowerCase().startsWith(typed.toLowerCase())).map((p) => ({ label: p.name, insert: `@${p.handle}` })),
});
```

The embed menu is one of these, in `plugins/embedMenu.ts`: it lists `host.embeds.list()`, so an embed is in the menu as soon as its plugin registers it. The list itself is CodeMirror's autocompletion, which one place in the core configures (`src/web/completing.ts`), so completions from several plugins share one list, one set of keys, and vim's insert mode. A plugin that added its own `autocompletion()` as an editor extension would fight it. A completion that throws offers nothing, and the Plugins page says so.

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

One limit:

- Only the check when an extension is added, or made for an editor, reaches the Plugins page. An extension that throws later, while an editor is running, is CodeMirror's to log, and nothing holds it against its plugin. The markdown plugins report what they know can fail: a part of them that couldn't be loaded.

Don't add a `keymap.of(...)` for a key or two. CodeMirror runs all keymaps from one handler, placed where the first keymap is, and a plugin's extension comes before vim's. A keymap in a plugin therefore puts every editor key, Escape among them, ahead of vim, and insert mode stops ending. Register a command with `keys` and `when`, as the outline bullets do, or handle the one key in `EditorView.domEventHandlers`, as tables do for the arrow keys.

## Drawing markdown in a note

A note has one surface, its editor. Markdown is drawn there, in place of its source, and a line is shown as written while the cursor is on it. Five built-in plugins do it, each of which can be turned off alone: `gfm` (emphasis, headings, links, quotes, rules, inline code, task checkboxes), `tables`, `math`, `code-blocks`, and `bullets`. The editor parses GitHub-flavored markdown whether or not they are on, so each reads the same parse.

Three rules hold for all of them, and for anything drawn later:

- The note's text is never changed by drawing it. What a drawing changes, it changes with an ordinary edit dispatched to its editor (`userEvent: "input.<what>"`), so it is saved, synced, in History as the member's, and undone like typing. Ask `writable(state)` first: a member who can only read gets no way to write.
- Only what is on screen is drawn. `drawnInView` in `plugins/lib/live.ts` redraws from `view.visibleRanges`. Blocks that replace whole lines must come from the state, with `drawnInState`, and must find themselves cheaply.
- Nothing moves when a line goes between drawn and written. The first letter of the line stays where it is, the line keeps its height, and the lines after it stay put. `test/browser/markdown-layout.spec.ts` measures it.

How each kind of mark keeps the third rule:

| What | Drawn | With the cursor on its line |
| --- | --- | --- |
| A heading's `#`s | hang in the left margin, not painted | painted, in the same place |
| `>`, `---`, a code fence | kept in the line, not painted (`ghost`) | painted |
| A bullet's `-` | kept in the line, a dot painted over it | painted |
| `[ ]` of a task | a checkbox exactly as wide as the three characters (`keepsWidth`) | the characters |
| `**`, `` ` ``, `~~`, a link's address, a formula in a line | taken out of the line | put back: the rest of that line moves along by their width |
| A block of math | the formula, in the room its lines take when written, wrapped rows and blank lines counted | its lines, the last padded to the formula's height |
| A table | a table, always | still a table: a cell is typed in where it is drawn, held at the size it was drawn while it shows its source |
| A code block | code, always | the same: only a fence line changes, as above |

One case moves, and is left that way on purpose: the marks inside a line are taken out when it is drawn, so a paragraph that fills its rows can need more rows with its marks put back, and the lines after it move down by those rows while the cursor is on it. Measured on a three-sentence paragraph with bold, code and a link in each: 2 rows (47px) in a 720px column, 5 rows (118px) in a 314px one. Showing the line as written and moving nothing can't both hold there. The layout test asserts what is kept: the paragraph starts where it did, grows by whole rows, and everything after it moves by exactly that.

A formula's drawn height is kept in the plugin's storage, so a block of math has its room before KaTeX has loaded. The first time a formula is ever drawn in a browser, the lines after it move down once if it is taller than its lines. They never move up.

A table is one thing to the keyboard. The arrow keys go into its cells, vim's `j` and `k` pass it whole, and a deletion that reaches into it from outside (`3dd` from the line above) takes all of it. A line of plain words directly under a table, which GitHub reads as one more row, stays a line of text under the drawn table, so words typed after a table don't vanish into it.

A fold never hides an edit. It opens when the cursor lands in it, when a selection reaches into it, and when anything in it changes. Deleting a folded bullet's line leaves what was under it, shown.

### Chips

A token that is drawn as something else and edits its own source is a chip (`plugins/lib/chips.ts`). The checkbox and the formula are chips, and a link, a mention, and a todo's options will be:

```ts
const checkbox: Chip<Checkbox> = {
  id: "task",
  find: (line, offset) => checkboxIn(line, offset), // the tokens on one line, with where they are
  keepsWidth: true,                                 // as wide as its source, for a chip at the start of a line
  draw(el, token, source) {
    const box = el.appendChild(document.createElement("input"));
    box.type = "checkbox";
    box.checked = token.checked;
    box.disabled = source.readOnly;
    box.addEventListener("change", () => source.rewrite(box.checked ? "[x]" : "[ ]"));
  },
};
host.editorExtensions.register({ id: "gfm.tasks", extension: chips(checkbox) });
```

A chip is drawn again when the note writes its token another way. One that also shows something from outside the note, such as a linked note's title or today's date, gives `key(token)`, a string of what it read: the chip is drawn again when that changes. To have it asked when nothing in the note changed, dispatch `redraw` (from `plugins/lib/live.ts`) to the editor.

`chips` draws the tokens on screen, leaves the ones in code and on the cursor's line as written, and hands `draw` a `source`: `rewrite(text)` writes the token another way, as the member's edit, and does nothing when the note no longer writes the token as it was drawn; `edit()` puts the cursor on it. Draw with elements and `textContent` only. Nothing from a note is ever set as HTML: HTML in a note stays text, and KaTeX is run with `trust` off (`plugins/math/options.ts`), so a formula can't make a link or load an image.

The task checkbox in `plugins/gfm/tasks.ts` is all the todos plugin (#18) needs to take over: it registers a chip with the same `find` and takes `gfm.tasks` out.

### What is loaded when

KaTeX and its faces are fetched the first time a note on screen has something that reads as a formula (a price such as `$5` does not), and the code colors the first time one has a fence, each language when a block first names it (`whenSeen` in `plugins/lib/live.ts`). A note with neither loads neither. When one can't be fetched the plugin calls `host.report`, and the note shows that markdown as written.

## Keybindings

In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key: on a Mac it is its own key, and elsewhere it is the same key as `mod`, so `ctrl+o` and `mod+o` are one chord there.

The app tries a keybinding before the editor or anything else with focus sees the key, and a key that ran a command goes no further: not to the editor, and not to a key handler of the element that has focus. A command that should stand aside at times gives `when`, a function that answers whether its keys run it now. While it answers false the key is left to whatever has focus. Vim mode's `vim.back` answers false in a text field and in a note in insert mode, where `ctrl+o` is the field's or vim's own.

A command's `keys` are its default chords. The member's are settings too: `keybindings.<command id>` holds a list of chords, and an empty list unbinds the command. The member changes them in the Keyboard shortcuts category of the Settings page, a table of every command with its keys and whether they are the default or the member's: Record takes the keys wanted as they are pressed, one after another for a sequence, with Start over to take them back, and Reset goes back to the default. It warns when another command already has the keys, or has keys that these begin or go on from. A press in the recorder is written down and runs nothing. Enter saves there and Escape cancels, so those two alone are bound in the JSON. A member's keys are whatever the app can run a command on: one chord, with a modifier or bare, or a sequence. Keys that would type, whose first chord has no `mod`, `ctrl`, or `alt` and is neither Escape nor an F key, are left to a field or a note's text while one has focus, unless their command gives a `when` and so says for itself where it runs. So no key that types in a note runs a command that didn't ask to be run there. The palette shows the chord that runs a command now. A plugin does nothing to take part.

A command's default `keys` may be a sequence: chords pressed one after another, written with spaces between them, such as `g g` or `ctrl+w h`. The keys that begin a sequence are taken only while a command that can run now goes on from them, so `g` is nobody's key in a text field. A key that doesn't go on from what was begun runs what it runs by itself, and otherwise goes nowhere. A default may also be a bare key such as `j`: give such a command a `when` that answers false wherever the key would be typed, since a command with a `when` is trusted with it and one without is never run by such a key while something is being typed in. Don't give one command a key that begins another's sequence: the shorter keys run on their last press and the longer never do. A member who does is told so, in Settings.

### Lists, rows and regions: vim's keys outside a note

With Vim mode on, vim's keys work outside a note's text. They are one table in `plugins/vim/keys.ts`: each row is a surface, the keys, and the command they run, and every row is registered as a command under `vim.`, so the keys are listed in Settings among the keyboard shortcuts and a member can change or remove them. In what an embed draws in a note, such as a kanban board, the list, row, search and tab surfaces answer no: the keys there are the embed's. Ctrl-w still leaves it. A surface is a question about where focus is, answered by `plugins/vim/surfaces.ts`, and it is the command's `when`.

| Surface | Keys | What they do |
| --- | --- | --- |
| A list, when nothing is being typed | `j` `k`, `g g` `G`, `ctrl+d` `ctrl+u` | next and previous row, first and last, half a page down and up |
| The selected row | `enter` or `l`, `h` | open it; collapse it, or go to its parent |
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
- **Opening a row** clicks what the row marks `data-row-open`, or else the row when it is itself the thing pressed, or its first link, or goes into the field it begins with, or clicks what it rests on. Mark the opener when a row has a checkbox before it, as a todo has. A note that comes to the front because of it takes focus in normal mode.
- **`h`** clicks the `data-row-toggle` of a row whose `aria-expanded` is true. Otherwise it goes to the row before it with a lower `aria-level`, or to the row a nested list is in.
- **A list a field is for**: `ctrl+j` and `ctrl+k` are sent to the field as the arrow keys Down and Up, so a field that already answers those needs nothing. A field that doesn't answer them sends focus to the first or last row of the nearest list.
- **A region** is an `<aside>`, `<main>`, or anything with `data-region`; of two that nest, the inner one. Going to a region puts focus where it last was there, or in its note's text, or on its list's row. `data-focused` marks the region to start from when focus is nowhere.
- **Tabs** are the `role="tab"` elements of the first `role="tablist"` in the region, and the one in front has `aria-selected="true"`.

## Turning plugins off

A plugin with `enabledByDefault: false` is off until the member turns it on. Its setting `<id>.enabled` then defaults to false, and only `true` is kept in the member's document.

A member turns a plugin off on the Plugins page, in the list or in the plugin's details, or from the palette (`Disable plugin: Tabs and splits`). Both write the setting `tabs.enabled`, so the choice follows the member to another browser. The Settings page has no switch for a plugin: it shows the setting only as a line of the JSON.

The Plugins page is under More in the sidebar and the Settings page is in the workspace menu. They are always at `/plugins` and `/settings`, and each has a `go.` command. They belong to the core, so they are there by their address when the palette and the sidebar are off. A plugin's details are at `/plugins/<plugin id>`, and a category of settings at `/settings/<category>`, such as `/settings/keyboard` and `/settings/plugins/<plugin id>`; `/settings/json` is the JSON.

With every plugin off, the core still opens the note its address names, takes typing, and saves.

A plugin whose `activate` throws is left out whole. A view that throws while being drawn is left out alone, an embed that throws is shown as it is written, and a completion that throws offers nothing. Each way the Plugins page says what failed.

## What third-party plugins must not get as it is

The built-in plugins are trusted, and the host gives them more than an untrusted plugin can have. Third-party plugins (#16) need each of these gated first:

- `host.perform` runs as the member with the member's whole access, and the server records the member, not the plugin, as the author.
- `host.agents.connect` mints a token that acts as the member.
- `host.commands.run` runs any command, including `plugins.disable.<another plugin>`. That command writes the member's settings, so it is a way around the refusal in `host.perform`. The palette needs it to run what the member picks.
- `Embed.render` is handed a real element inside the note, so it can reach the rest of the page from there.
- `Embedded.update` changes the note as the member, recorded as the member's change. It can only rewrite the embed's own config and body, but an untrusted embed could do that without the member touching it.
- A completion's `items` is told what the member types after its trigger, and what an item inserts is written into the note as the member.
- An editor extension runs inside the editor with the note's text, every key typed, and the page. It must also be built from the app's own copy of `@codemirror/state`, which a plugin loaded from elsewhere doesn't have.
- `host.storage` is the browser's localStorage under a prefix, which any script on the page can read.
- A view is handed `app`, which carries the member's email, every note's title and first lines, `signOut`, and `switchWorkspace`. Each view is drawn with the `app` its own plugin is given (`provide` in `Workspace.tsx`), so that is the one place to narrow it.
