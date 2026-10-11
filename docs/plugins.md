# Plugins

Most of the web app is plugins. The core is the workspace's data, the editor for one note, writing mode, the inspector's frame, and the plugin host. The sidebar, folder tree, a folder's list of notes, tabs and splits, command palette, quick open, History, Agents, Members, and the rest are built-in plugins in `src/web/plugins/`.

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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `rail`, `editor`, `folder`, `inspector`, `page`, `bar`, `overlay`, `mark`, and `notice`. A page gets a `go.<id>` command, and its `order` places its link among the others in its nav: lower first, and pages with none after them. A page is also shown at every address under its path, so the Tags page at `/tags` is the page at `/tags/work` too, and reads which from `app.path`. A page registered at exactly that address wins. A page with `home: true` is also what the app shows at `/`, when no note is addressed and the editor area has none to return to, in place of an editor with nothing in it: the Dashboard is that page, at `/dashboard`, and with it off the app opens to the editor as before. The editor area says what it returns to with `returnsTo` on its `editor` view, which for Tabs and splits is the tab that was last in front. So a member with tabs open comes back to them at `/`, and one with none, or who closes the last, is on the dashboard.
- `host.embeds` registers an embed, drawn wherever a note says `::name{config}`, or `:::name{config}` … `:::` for a block embed. `host.embeds.list()` is every embed that is on, as a menu would offer them. An embed registered with `menu: false` is left out of that list, and so out of the `/` menu: it is for one whose config can't be typed, as a reference to an event is copied from the Calendar page, and for a way of writing that notes are no longer started with and is still drawn where a note has it, as `::youtube{}`, `::social{}` and `::link{}` are.
- `host.completions` registers a completion: a list offered at the cursor while the member types after a trigger, such as the embed menu on `/`.
- `host.editorExtensions` registers an editor extension, added to the editor of every note. It is a value, or a function of the editor that is told its note.
- `host.onNavigate(listener)` calls the listener each time the app arrives at an address.
- `host.onNotes(listener)` calls the listener each time the notes the member can see change: one made, renamed, moved, or changed by anyone. `host.app().notes` then holds them as they are. It is how something drawn from another note's title, such as a link, knows to draw itself again.
- `host.report(error)` says on the Plugins page that the plugin is on and something it is for didn't work.
- `host.app()` is the app as it is now: the open note, the notes and folders, and what can be done about them. A view is handed the same thing as its `app` prop.
- `app.path` is the address the app is at and `app.query` its query, such as `?q=plan`, which a page reads with `URLSearchParams`. `app.go(path)` goes to an address, query included. With `replace: true` it takes the place of the current entry in the browser's history, which is how the Search page keeps what is typed in its address without Back retracing each letter.
- `host.perform(op)` performs a workspace operation as the member. A refusal rejects with an `Error` whose `message` is the server's reason and whose `code` is the kind of refusal, such as `conflict` or `forbidden`. The operations are the ones in `src/core/protocol.ts`, except the two on settings. It also refuses every operation that changes who is in the workspace or reads its invites; `member.list` goes through, and tells an admin the members' emails and anyone else their names and roles alone. A plugin that isn't Common Ink's own is refused the member's data sources as well: `source.*`, `event.*`, `contact.*` and `record.*`. It is refused the member's pins and their last visit too: `pin.*` and `visit.*`.
- `host.settings` reads the plugin's own options.
- `host.storage` keeps JSON for this plugin, in this browser, for this workspace and this member.
- `host.agents` lists, connects, and disconnects the member's agents.
- `host.members` invites by email, sets a member's role, removes a member, leaves, and lists and revokes invites, as the member. The server lets only an admin do all but leave. It is a capability of its own, apart from `host.perform`, so that it can be given to the Members plugin and to no other. After a change that may be to the member themself, `app.reloadWorkspaces()` has the app read again which workspaces they are in and their role in each. A change of role draws the app again from the start, since a plugin is handed the role when it starts.
- `app.toggleOverlay(id, state)` opens an overlay and hands it `state`, which the overlay's view is given as a prop. The Share dialog is the overlay `share`, handed `{ noteId }` or `{ folderId }`, so any plugin can open it while the Sharing plugin is on (its command `sharing.share` is then listed).
- `app.canEdit` says whether the member may change something in the workspace. Whether they may change one note is that note's `access`, which is what an editor, the history controls, and the Info tab go by. `app.canCreateNote` says whether `app.createNote()` can make a note where it would put one, and `app.createNote()` rejects with the server's reason when it is refused. `app.folderId` is `SHARED_WITH_ME` while the list of the notes shared with a guest whose folders they can't see is in front, or one of those notes is, and such a note's `folderId` is null.
- `host.sharing` reads and changes who a note or a folder is shared with, as the member: `of(on)` answers the `Sharing` of one note or folder, `grant(on, to, access)` shares it with a person or changes what they have, where `to` is an email or, for a member of the workspace whose email only an admin is told, `{ memberId }`, `link(on, kind | null)` sets or removes its link, `revoke(grantId)` takes a grant back, `setPrivate(noteId, private)` makes a note private or stops it and answers how many grants and links other people had put on it, which go as it becomes private, and `all()` lists every grant for an admin. `on` is `{ noteId }` or `{ folderId }`. The server decides who may do each, and a view shows only what its answers say: `Sharing.canShare`, `Sharing.note.canSetPrivate`, and a note's `access`. It is a capability of its own, apart from `host.perform`, which refuses `grant.*`, `note.setPrivate`, and `shared.*`.
- `host.sharing` takes an upload too: `on` may be `{ uploadId }` for `of`, `grant` and `revoke`, and `setPrivate({ uploadId }, private)` makes an upload private as `setPrivate(noteId, private)` does a note. `link` is refused for one by the server: an upload has no link of its own, and only a link on a folder opens the uploads in it. The Share dialog takes `{ uploadId, name }` and leaves its Link section out. `host.perform` refuses `upload.setPrivate`.
- `host.uploads` is the workspace's uploads as notes refer to them, and their bytes. `referred(id)` is what the app was last told of an upload, by the read of a note that refers to it (`note.read`'s and `shared.read`'s `uploads`) or by `learn`: its name, type, kind, size and state, `null` for one that isn't there or that the reader can't see, which nothing tells apart, and `undefined` for one nothing has been said of. `onReferred(listener)` hears when any of that changes. `learn(uploads)` tells the app what an upload is now, after an operation that made, changed or removed it, so every note showing it follows. `address(id)` is where its bytes are asked for, good only for whoever is looking: the member's session in the app, and on a link's page the link, never the workspace. `send(file, { name, folderId, private }, onProgress)` sends a file as the member and rejects with the server's reason. Listing, reading, moving, archiving, trashing, restoring and purging are `host.perform`'s `upload.*` operations, which, like `host.uploads` itself, only Common Ink's own plugins are given. `upload.create` and `upload.open` are refused to every plugin as operations: the bytes go through `send` and `address`.

- `app.notes` is every note the member can see that isn't in Trash: the live ones and the archived ones, told apart by `state`. A listing leaves the archived ones out unless the member asked for them, with a toggle of its own that starts off; `listable(notes, includeArchived)` in `plugins/lib/listable.ts` is that rule. `app.trashed` is the notes in Trash, which no listing shows: they are there so a tab or a link can say what one is. `app.note`, the open note, may be in either. A note's state is not a change to the note, so its revision stays: anything that reads again "when a note changes" compares `state` as well.
- `app.noteChanged(note)` tells the app a note as it is now, after an operation that answered with it: its text, its folder, or its state. A folder's list, quick open, open tabs and links follow at once. Folder counts are the server's, so `app.refresh()` after a change of state.
- What the editor area has in front is `app.opened`: `{ kind: "note", id }`, or `{ kind: "folder", id }` for a folder's list of notes, where `id` is a folder's id, `ALL_NOTES` for every note, or `SHARED_WITH_ME` for the notes shared with a guest who can't see their folders. `app.noteId` and `app.note` are the note's when a note is in front and null otherwise. `app.folderId` is the folder in front: the one whose list is open, or the folder of the note in front, which is what the folder tree marks. `app.openFolder(id, { preview })` opens a folder's list (a preview unless said, which gives way to the next folder previewed and never to a note), `app.folderPath(id)` is its address (`/folder/<id>`, `/folder/all`), and `folderTitle(folders, id)` is what it is called. `app.openNote(id, { background: true })` opens a note in a tab of its own without leaving what is in front. `app.createNote(folderId?)` puts the note in that folder when it is one, otherwise in the folder in front, otherwise in Unsorted.
- **The `folder` slot** draws a folder's list of notes wherever a folder is open: in a tab when the tabs plugin is on, alone at the folder's address when it is off. It is handed `folderId`, which may name no folder the member can see, and `readNote(noteId)`, which draws a note's text to be read and not changed, as its editor draws it, at its full height. The last view registered is used. With none, the core lists the folder's notes by title. A page that lists notes the same way draws them with `app.readNote(noteId)`, which is the same function: the Search page is the note list's `NoteFinder` (`plugins/noteList.tsx`) of every note, with its view kept in the address where a folder's tab keeps its own for as long as the app is open. With no `editor` view and no home page, `/` lists every note, and the command `notes.all` opens that list from anywhere, so there is a way to a note whatever is turned off. No page can be registered at `/folder` or under it.
- **The `editor` slot** is asked to open what the app would otherwise go to: `open(tab, { preview, background })` with a note or a folder's list, and it calls `app.show(tab)` with what ends up in front. `returnsTo()` is what it shows at `/`. It is handed `renderNote` and `renderFolder` to draw what its tabs hold.
- `app.notify({ message, action })` tells the member something that just happened, in a line at the foot of the app that goes after ten seconds, or when dismissed, and waits while the pointer or the keyboard is on it. `action` is one button beside it, such as Undo. `stays` keeps it until it is answered or dismissed, for a question such as an offer to share. One notice shows at a time. It is for what the member just did and may want back, not for a standing fact about a note, which is a `mark` or a `notice` view.
- The `mark` slot is a word or two about a note in the bar above its text, in every editor showing it: the Archive and Trash plugin's "Archived" and its Unarchive button. The bar keeps its height, so nothing in the note moves when a mark comes or goes. The `notice` slot is a banner between that bar and the text, for what changes what the member can do with the note: that it is in Trash. Each is handed `note`, and draws nothing when it has nothing to say of it. When a banner appears the text moves down by the banner's height and no further.

A plugin does not call `fetch` or read `localStorage`. The host is where a third-party plugin's permissions will be checked, so a plugin that goes around it can't be trusted later.

## Options

A plugin's `settings` are its options, by name. Each is a `Setting`: a `type` (`boolean`, `string`, `number`, `integer`, or `chords`), a `default`, a `title`, and optionally a `description`, an `enum` or `maxLength` for a string, and a `minimum` and `maximum` for a number. The words are JSON Schema's. They are plain data, so the app lists them without running the plugin, and they stay listed while it is off.

An option named `unit` in the plugin `word-count` is the setting `word-count.unit`. The member changes it on the Settings page, as an option under the plugin's name or in the JSON, and only a value that differs from the default is kept.

`host.settings.get(name)` is the option's value now: the member's when it is valid, the default otherwise. A view is drawn again when settings change, so reading it while drawing is enough. Anything else calls `host.settings.subscribe(listener)`.

A plugin cannot change settings. The host has no call for it, and `host.perform` refuses `settings.write` and `settings.read`, so a plugin can't change them through the server either, or read another plugin's. `test/core/plugin-host.test.ts` checks the refusal with a plugin that tries.

Some names are the app's. A command whose id starts with `go.`, `plugins.`, or `settings.` is refused, and so is a page at an address another page has, and the plugin that asked doesn't start. A page still gets its `go.<id>` command, which the host adds. The core and the Settings and Plugins pages start before every other plugin, so none can take an id they need.

The name `enabled` is taken. Every plugin that can be turned off has the setting `<id>.enabled`, and a plugin that declares its own doesn't start.

## Widgets and where they live

A widget is a small live thing to glance at or press. There are three places one lives, and each has a built-in plugin or two that can be turned off like any other.

| Where | How a plugin adds one | Where its state is | Built in |
| --- | --- | --- | --- |
| In a note, inline | `host.embeds.register({ name, render })`, written `::name{config}` | The note: its config | Timer (`timer`), Stopwatch (`stopwatch`), Link (`media`), Event (`calendar`), Contact (`contacts`) |
| In a note, as a block | `host.embeds.register({ name, block: true, render })`, written `:::name{config}` … `:::` | The note: its config and body | Kanban board (`kanban`) |
| In a note, below its line | An embed, inline or block, that also gives `below: { box, render }` | The note: its config and body | A video's or a post's address alone on a line (`media`, by `below.ofAddress`), HTML (`html`) |
| The bottom bar | `host.views.register("bar", { id, component })` | Whatever it shows: the open note, the app | Note clocks (`note-clocks`), Word count (`word-count`) |
| From the command palette only | A command that opens an `overlay` to ask what it needs, and a `bar` view that shows it | This browser, for this workspace: `host.storage` | Quick timer (`quick-timer`) |

Every embed is in the `/` menu unless it says `menu: false`, and every command-started widget is a command in the palette.

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

With the cursor on an inline embed it is shown as written, so it can be changed as text, the way the markup around it is. The line is as tall either way. A block is different: it stays drawn, with its lines hidden under the drawing, and the cursor steps over them, by arrow key or vim's `j` and `k`, so passing a board changes nothing. `embed.edit()`, which is kanban's "Edit as markdown", puts the cursor in the lines and shows them under the board, which stays where it is and follows what is typed. They are hidden again when the cursor leaves them.

`render(el, embed)` draws into `el` and is handed `embed.config`, `embed.body` (a block's lines, each with its line break), `embed.readOnly`, and two functions:

- `embed.update({ config, body })` rewrites the embed in the note. It is an ordinary edit in that editor by the member: it is saved with their typing, synced, recorded in History as their change, and undone the way typing is. Give only what changes. The edit covers only the characters that differ, so typing elsewhere and other people's changes merge around it.
- `embed.edit()` puts the cursor in the embed as written, and for a block shows its lines.

`embed.readOnly` is true when the member can't change the note, as a viewer can't. The note's editor is then read-only as a whole: no typing, no keys, and `update` does nothing, whatever calls it. An embed draws what it shows and leaves out the controls that would call `update`: the timer is a time that can't be pressed, and the board has no "Add a card" and nothing to drag.

`update` called from inside `render` is carried out right after the drawing, since the editor can't be changed while it draws. An embed that tidies its own config that way is drawn twice.

Two members can act on one embed before either sees the other's change, and the server merges their writes as text. An embed's reading of its config should stand that: two presses of one timer leave two `since=` words, and the timer reads the last and writes one back on the next press. Two moves of one kanban card to different columns leave the card in both, which a merge of text can't tell from two cards, so one of them is deleted by hand.

An embed keeps what it knows in the note. The timer keeps its length and how it is running in its config (`::timer{5m since=2026-10-10T12:00:00.000Z}`), so a reload and another member see the same time, and nothing ticks into the note: the time shown is worked out from the instant it started. Kanban keeps nothing but the markdown: `parseBoard` and `serializeBoard` in `plugins/kanban/board.ts` read the body into columns and cards and write it back line for line, so what a board doesn't understand stays where it was.

Each time the note says something else of an embed, whoever changed it, the embed's `update` is called if `render` gave one back, and otherwise `render` is called again on the same element, emptied. Focus then goes to the element whose `data-focus` equals that of the element that had it, so a control that rewrites the note keeps the keyboard. To send focus somewhere else, set `data-focus` on the focused element before calling `update`, as a kanban card does with the place it is moving to.

`update` is checked against the note as it is when called. A drawing that has left the editor, or one of an embed that the note no longer writes that way, does nothing, so a rewrite computed from a stale body can't land on someone else's newer text. A config holding `{`, `}`, or a line break throws, and so does a body with a line that is only `:::`: an embed can't write its way out of its own range. `test/core/plugin-embed-syntax.test.ts` covers the syntax and the edits, and `test/browser/widgets.spec.ts` the rest.

`starts` is what the embed menu writes for a new one: `{ config: "5m" }` for the timer, and a body of three empty columns for kanban.

`pick` is for an embed a menu can't write, because what it holds is made by doing something: `{ title, detail, run }`. The embed menu lists it under that title after the embeds it writes, and picking it writes nothing and calls `run`, with the keyboard still in the editor it was picked in. "Upload a file" is the `file` embed's: it opens the file picker and writes the upload's embed once the server has the file. A completion item has the same thing as `run`, called once its `insert` is in the note.

### Below the line

An embed that shows more than fits in a line, such as a video or a frame, gives `below`:

```ts
host.embeds.register({
  name: "clip",
  title: "Clip",
  render: (el, embed) => void (el.textContent = "Clip"), // what stands in the line
  below: {
    box: ({ config }) => (clipIn(config) ? { ratio: 16 / 9 } : null), // or { height: 320 }
    render(el, { config }) {
      el.append(playerFor(clipIn(config)!));
      return () => {/* stop what was started */};
    },
  },
});
```

`below.ofAddress(address)` lets the embed claim a web address written alone on a line, with no embed syntax: the address is then kept and drawn below its line exactly as `::name{address}` would be, with the address as `config`, and the line stays a link. `update` does nothing for one. It is how a video or a post is written (`plugins/media/`). An address in a paragraph, a list or code is never asked about.

`box` says what room to keep, from what the note says of the embed alone, so the room is there in the first frame painted and nothing moves when what fills it loads. The room is under the line that writes the embed, or under a block embed's closing line, and stays while the cursor is on that line: the line is shown as written and what is below it is not touched.

`below.render` draws into an element the host keeps outside the note's text, laid over the room. CodeMirror makes its own elements again whenever it likes, and drops the ones scrolled out of sight, and a frame that is taken out of the page, or only moved in it, loads again. So the element is made once, the first time the room is on screen, is never moved in the page, and is only placed where its room is after each change. It lasts while the note says the same of the embed: through typing anywhere else, lines added and removed, the cursor, another member's change, and scrolling far away, where it goes on running. `keep` in `src/web/belowIdentity.ts` says which embed is which after a change. When the note says something else of the embed, what `render` returned is called, the element is emptied, and `render` is called again in it. An edit that passes through a config with nothing to show, such as a video's id with a letter deleted, takes the element out, and the next one is new.

**The room comes from the note, and only from the note.** `render` can't resize it. What is only known after loading gets into the note: `render` is handed `update`, which rewrites the embed as `Embedded.update` does, and `box` then reads it. This is the rule for pictures and files (#22): the upload writes a picture's size into its config when it is inserted (`::image{id 1200x800}`), so its room is right from the first frame for everyone. One written by hand without a size gets a usual room, and writes its size with `update` once it has loaded, which moves the lines below it once and never again. A test in `test/browser/media.spec.ts` does exactly that with a fixture embed.

Not covered: a tab switch or a split makes the editor again, so what was below a line starts over (#36).

`test/browser/media.spec.ts` holds a playing video to this through each kind of change, and checks every painted frame for a room without what fills it.

`box` may give `width` beside `ratio`: `{ ratio: 4 / 3, width: 640 }` is a room no wider than 640 pixels, narrowed to the note's column at the same shape. It is how a picture isn't drawn larger than it is. Like everything `box` answers, it comes from the note's text alone.

### Frames

Nothing in a frame runs when a note is opened. A video, a post and an HTML embed are each a button in their room until the member presses it, so opening a note runs no one else's code and tells no other site that it was opened. A changed embed is a button again: what was run is not remembered past the element it ran in, for any member.

**The keyboard stays with the app** (`src/web/frameGuard.ts`). A frame can focus itself, and whatever is typed after that goes to it and not to the note. The host guards every frame drawn below a line: a frame may have the keyboard only while the member's pointer is on it, having moved or pressed there since their last key or press elsewhere in the app, or right after they pressed Tab. A frame that takes it any other way loses it before another key is typed, is stopped, and its room says so with a button to show it again. A shield lies over a frame until the pointer moves on it, since a frame swallows the pointer events over itself. While a frame has the keyboard its box shows "Back to the note", and a click anywhere in the app does the same. What this does not stop: a frame the member is pointing at can take the keyboard without being clicked. An embed's frame drawn anywhere but below a line is not guarded, and no built-in does that.

**Another site's frame** is sandboxed (`allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation`: it runs as its own site and can open its own links in a new tab, and can't take the app's window anywhere), is sent the app's address and never the note's (`referrerpolicy="strict-origin"`; YouTube refuses to play with none), and its address is built from an id checked against a pattern, never from the note's text. The Worker lists the sites the app may frame (`FRAME_ORIGINS` in `src/worker/frames.ts`) in the page's `frame-src`, so an embed for a site that isn't there shows nothing. Social sites are the ones with a frame of their own that works sandboxed and whose address follows from the post's: X, and Bluesky for an address that carries the account's DID. A site that offers only a script to run in the page is left out. Once the member has started one, that site's frame is that site's: it can go to another address the page may frame, and it can add entries to what Back goes through.

**HTML from a note** is never read as markup by the app. `sandboxed(html, { title })` from the plugin API makes a frame for it. The Worker serves a shell at `/embed-frame` that holds nothing, with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; frame-src 'none'; …`. The app hands the shell the HTML as a string, and the shell puts it in a frame of its own as that frame's whole document (`srcdoc`). That inner frame has no address, an origin no other document has, and the shell's policy. What `test/browser/media.spec.ts` proves of it, by trying from inside:

- It can't read the page around it, the member's session, cookies, or anything the browser keeps.
- It can't fetch, send, or load anything: not from the app, not from anywhere.
- It can't send its own frame, the shell's, or a frame inside it to any address, by `location`, a link, a refresh, or a form. The shell's policy governs it, not the page's, so the sites the app frames are out of reach too. It can't open a window, move the app's, or add to what Back goes through.

What it can do, which nothing a browser offers today closes: **open a WebRTC peer connection.** Chrome does not recognize CSP's `webrtc 'block'` (sent as a header and as a `<meta>`, it logs "Unrecognized Content-Security-Policy directive" and candidates are still gathered), no `Permissions-Policy` feature names WebRTC, and deleting `RTCPeerConnection` before the embed runs is undone by a frame the embed makes inside itself from `srcdoc`, which runs script with one of its own (tried: it answered `function`). A running HTML embed got a `srflx` candidate from a public STUN server, which shows that server the reader's public address, and with a prepared peer a data channel carries anything the embed holds. So an HTML embed is without network except for WebRTC, and only once the member has pressed Run.

It can also post messages to the shell, which listens for nothing after the first one from the app, and spend the reader's processor.

Where the shell is served from: on this machine, in Previews, and in production it is the app's own host, which is the only host each of those has. Its origin is still its own, and the inner frame's another, because the response header says so. The member's session cookie goes with the request for the shell, which is the same empty document for everyone. Setting `EMBED_ORIGIN` on the Worker to a host kept for embeds (and routing that host to the Worker) serves it from there instead: that host answers with the shell and nothing else, and the app's host sends the frame to it. Nothing sets that in production yet.

**For #16.** `embedPolicy({ network })` in `src/worker/frames.ts` is the one switch that lets an embed fetch. A grant must never be a variant of the shell's address, a path or a query: any frame can be sent to any address its ancestors' `frame-src` allows, and `frame-src` ignores the query, so an embed could send a frame to the granted variant and get the network unasked. A grant is an unguessable token for that one grant which the Worker checks before answering with the wider policy, or a separate host for each policy. The inner frame keeps `frame-src 'none'` either way: a grant of the network is not a grant to leave. And an untrusted plugin's embed gets `sandboxed` and nothing else: not `Embed.render`, not `Below.render`.

## Completions

`host.completions.register({ id, trigger, items })` offers a list at the cursor. It opens when the member types the trigger at the start of a line or after a space, and not inside code, so the `/` of a URL, a path, or a date opens nothing. `items(typed)` is asked on each keystroke for what to offer for the text typed after the trigger, best first, and may answer with a promise. Once the list is open, one that answers at once is asked within each keystroke, so a letter and Enter in the same breath picks what that letter narrowed to. The list first opens a moment after the trigger is typed, so a trigger, letters and Enter with no pause at all between them can still reach Enter before there is a list, and break the line. Completions whose triggers both fit share the list, each one's items together, in the order of their plugins. With nothing from any of them the list closes. Each item has a `label`, an optional `detail`, and `insert`, the text that takes the place of the trigger and what was typed. `tone` colours the label: `accent` is the theme colour and `muted` is gray. `select` leaves part of it selected, `block` puts it on lines of its own, and `spaces: true` on the completion lets what is typed hold spaces, as a note's title does. `anywhere: true` opens the list wherever the trigger is typed outside code, right after a bracket or a word too. It is for a trigger nobody types by accident, as `[[` is, and wrong for `/` or `@`.

```ts
host.completions.register({
  id: "people",
  trigger: "@",
  items: (typed) => people.filter((p) => p.name.toLowerCase().startsWith(typed.toLowerCase())).map((p) => ({ label: p.name, insert: `@${p.handle}` })),
});
```

The embed menu is one of these, in `plugins/embedMenu.ts`: it lists `host.embeds.list()`, so an embed is in the menu as soon as its plugin registers it. The list itself is CodeMirror's autocompletion, which one place in the core configures (`src/web/completing.ts`), so completions from several plugins share one list, one set of keys, and vim's insert mode. They are one source to CodeMirror, asked again within each keystroke when every completion that fits answers at once, so an open list is never a key behind what was typed. The first opening still waits on CodeMirror's typing delay, set to nothing, which is one turn of the event loop. A plugin that added its own `autocompletion()` as an editor extension would fight it. A completion that throws offers nothing, and the Plugins page says so.

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

A note is also drawn where it is only read: an expanded card in a folder's list. That drawing gets the same extensions, called with `{ noteId, reading: true }`, and it can be there beside the note's editor, more than once. So an extension that keeps a note's editor by the note's id (to read its text, or to put the cursor in it) leaves a reading out, and one that keeps every editor to draw it again keeps a reading by `editorKey(editor)` from `plugins/lib/live.ts`. Nothing a reading does changes the note. `isReading(state)` from the plugin API says whether a state is a reading's, and `touched`, `within` and `lineTouched` in `plugins/lib/live.ts` answer false there, so nothing in a reading is shown as written whatever is selected. A link's shared page is a reading too. `TITLE_MARK` is the `# ` an empty note is opened with in its editor, which vim reads to start such a note in insert mode. A reading is not an editor: an extension that is only for editing, as vim and line numbers are, gives a reading nothing (`(editor) => (editor.reading ? [] : extension)`), so it has no cursor, no mode bar and no keys, and its text is selected and copied as a page's is.

A panel an extension shows under the text (`showPanel`, as vim's mode bar is) is put at the foot of the note's pane by the editor, outside the scrolling text and as wide as the pane, one for each editor. It is styled in `style.css` under `.note-foot`, since it is no longer inside `.cm-editor` for an editor theme to reach.

Plugins' extensions come before the editor's own, in the order of the plugins, so a plugin's keys are tried before the editor's. Wrap one in `Prec` to place it more exactly. An extension given as a value is shared by every editor. Keep what belongs to one editor in a `StateField` or a `ViewPlugin`, or give a function.

A plugin whose editing is heavy loads it when it starts, as Vim mode does with `import("./editing.ts")`, and registers the extension when the import settles unless it was turned off meanwhile. If the import fails it calls `host.report(error)`, which shows the reason against the plugin on the Plugins page.

One limit:

- Only the check when an extension is added, or made for an editor, reaches the Plugins page. An extension that throws later, while an editor is running, is CodeMirror's to log, and nothing holds it against its plugin. The markdown plugins report what they know can fail: a part of them that couldn't be loaded.

Don't add a `keymap.of(...)` for a key or two. CodeMirror runs all keymaps from one handler, placed where the first keymap is, and a plugin's extension comes before vim's. A keymap in a plugin therefore puts every editor key, Escape among them, ahead of vim, and insert mode stops ending. Register a command with `keys` and `when`, as the outline bullets do, or handle the one key in `EditorView.domEventHandlers`, as tables do for the arrow keys.

## Drawing markdown in a note

A note has one surface, its editor. Markdown is drawn there, in place of its source, and a line is shown as written while the cursor is on it. Six built-in plugins do it, each of which can be turned off alone: `gfm` (emphasis, headings, links, quotes, rules, inline code), `todos` (a todo's checkbox and its options), `tables`, `math`, `code-blocks`, and `bullets`. The editor parses GitHub-flavored markdown whether or not they are on, so each reads the same parse.

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
| `[ ]` of a todo | a checkbox exactly as wide as the three characters (`keepsWidth`) | the characters |
| A todo's `!!`, `due:2026-10-14`, `every:2w`, `done:2026-10-10x12`, `+Project` | a chip exactly as wide as the token (`keepsWidth`) | the token, kept in one piece so the line wraps where it did |
| `**`, `` ` ``, `~~`, a link's address, a formula in a line | taken out of the line | put back: the rest of that line moves along by their width |
| A block of math | the formula, in the room its lines take when written, wrapped rows and blank lines counted | its lines, the last padded to the formula's height |
| A table | a table, always | still a table: a cell is typed in where it is drawn, held at the size it was drawn while it shows its source |
| A code block | code, always | the same: only a fence line changes, as above |

One case moves, and is left that way on purpose: the marks inside a line are taken out when it is drawn, so a paragraph that fills its rows can need more rows with its marks put back, and the lines after it move down by those rows while the cursor is on it. Measured on a three-sentence paragraph with bold, code and a link in each: 2 rows (47px) in a 720px column, 5 rows (118px) in a 314px one. Showing the line as written and moving nothing can't both hold there. The layout test asserts what is kept: the paragraph starts where it did, grows by whole rows, and everything after it moves by exactly that.

A formula's drawn height is kept in the plugin's storage, so a block of math has its room before KaTeX has loaded. The first time a formula is ever drawn in a browser, the lines after it move down once if it is taller than its lines. They never move up.

A table is one thing to the keyboard. The arrow keys go into its cells, vim's `j` and `k` pass it whole, and a deletion that reaches into it from outside (`3dd` from the line above) takes all of it. A line of plain words directly under a table, which GitHub reads as one more row, stays a line of text under the drawn table, so words typed after a table don't vanish into it.

A fold never hides an edit. It opens when the cursor lands in it, when a selection reaches into it, and when anything in it changes. Deleting a folded bullet's line leaves what was under it, shown.

### Chips

A token that is drawn as something else and edits its own source is a chip (`plugins/lib/chips.ts`). The checkbox, the formula, a link to a note, and a todo's options are chips, and a mention will be:

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
host.editorExtensions.register({ id: "todos", extension: chips(checkbox) });
```

A chip is drawn again when the note writes its token another way. One that also shows something from outside the note, such as a linked note's title or today's date, gives `key(token)`, a string of what it read: the chip is drawn again when that changes. To have it asked when nothing in the note changed, dispatch `redraw` (from `plugins/lib/live.ts`) to the editor.

`chips` draws the tokens on screen, leaves the ones in code and on the cursor's line as written, and hands `draw` a `source`: `rewrite(text)` writes the token another way, as the member's edit, and does nothing when the note no longer writes the token as it was drawn; `rewriteLine(next)` does the same for a change that reaches past the token, handing `next` the token's line and writing what it answers, which is how taking a todo's due date away takes the space before it; `edit()` puts the cursor after it, or `edit(offset)` that far into it; `line()` answers the token's line as the editor has it now, `{ index, text }` with the index counted from 0, which is what an operation that finds a todo by its line is handed, and is undefined once the note writes the token another way.

A chip with `written: "within"` is shown as written only while the member is working inside the token itself: a cursor past its first character and before its last, or a selection of part of it. A selection that covers all of it, as selecting a paragraph does, leaves it drawn. The rest of its line stays drawn while the member types on it. It is for a token nobody reads as written, which a link is (`[[k3j5h8d9f0a1]]`) and a mention will be. On a line with several links, the one the cursor is in is shown as written and the others stay drawn, so the only thing that moves is what follows that one link on its line, by the difference in width between the id and the title. Coming to the line, typing on it, and leaving it move nothing. `test/browser/links.spec.ts` measures both.

Such a chip is one thing to the keyboard while it is drawn. A selection that reaches into it takes all of it, and a deletion of any part of it, Backspace at its edge or vim's `x`, `dw`, `cw` or a visual `d`, deletes all of it, so half a token with a raw id is never left in the prose. It is a transaction filter in `chips`, not `EditorView.atomicRanges`, because vim works out its own ranges and never asks. Server changes, undo and redo, and the chip's own `rewrite` pass through untouched. A cursor with nothing selected is let in, by an arrow key or vim's `h`, `l` and `w`, which shows the token as written to be edited as text, and arrowing out draws it again. `source.edit(offset)` from the chip, as a click on a mention does, and `editWithin(chip, view, fromEnd)`, which the command `links.edit` (Alt+Enter with the cursor beside a link) runs, go straight to a place inside. A click on a drawn link follows it instead: see `plugins/links/drawing.ts`.

A chip is not drawn in what the editor's parse calls code. `inCode: true` leaves that to the chip's own `skip`, for one that has a better reading of code than the parse. Draw with elements and `textContent` only. Nothing from a note is ever set as HTML: HTML in a note stays text, and KaTeX is run with `trust` off (`plugins/math/options.ts`), so a formula can't make a link or load an image.

### Todos

The todos plugin (`plugins/todos/`) is the pattern for options written as tokens on a line. `parseTodo` and `rewriteTodo` from the plugin API read and rewrite a line, the same functions the core indexes todos with (`docs/todos.md`). `plugins/lib/todoLines.ts` keeps where `todosIn` finds a todo in the whole text in a state field, and each chip is `inCode: true` with a `skip` that asks it, so a todo is drawn on exactly the lines the server lists. Each chip is `keepsWidth` and shown as written with its line, so its line never changes width. A chip's control is the browser's own, a select or a date field, laid over what the chip says and not painted. It needs no menu of its own, and it is disabled for a member who can only read. On the cursor's line each token is marked `md-todo-token`, which keeps it from wrapping in the middle as its chip can't.

The plugin API has what reads and writes a todo, each the core's own function: `parseTodo`, `rewriteTodo`, `todosIn`, `locateTodo`, `changeTodo(line, change, on)`, which is the line `todo.set` leaves, and `completeTodo(line, on)`, which is what checking a todo off on a day leaves: for a recurring todo the open line with its next due date and `done:` mark, and the checked line that gets filed. For recurrence it has `parseRule`, `writeRule`, `describeRule`, `nextDue`, `WEEKDAYS` and the types `Rule`, `Unit` and `Weekday` (`src/core/recurrence.ts`). `today()` and `dayOf(date)` are the member's calendar day in this browser's time zone, which is the day every completion made in the app is said to be on. `TodoCompletion` is one entry of what `todo.history` answers.

Two chips are for a todo that recurs. The recurrence chip over `every:<rule>` says `↻` and the rule as written, with `describeRule` as its name, and opens a form: the common rules at a click, a row of weekdays, and under Advanced every rule the token can write, kept as one `RuleForm` value that `ruleOf` turns into a `Rule` (`plugins/todos/recurrence.ts`, tested in `test/core/plugin-recurrence-form.test.ts`). Setting it is `rewriteTodo(line, { every })`, and "Doesn't recur" takes the token away. The last-done chip over `done:YYYY-MM-DDxN` says the day and the count, and opens the todo's completions from `todo.history`: the day, who did it, and its daily note a click away. That chip works for a viewer too, since it changes nothing. Neither chip's control is the browser's own, so each opens a panel with `openPopover(anchor, label, content)` from `plugins/lib/Popover.tsx`: an element of its own at the end of the page, laid over the app and placed under the chip, which takes no room in the note. It closes on Escape and on a press outside through `useDismiss`, and when its chip is gone.

The checkbox chip writes `[x]` and then calls `app.saveNote(noteId)`, which sends what is typed in that note's editor at once instead of after the pause in typing, so the write holds the check and not what the member types on the line a moment later. The server completes a recurring todo whose box a write checked, files the line on the member's daily note in the same step, and answers with the line rolled forward, which the editor takes as it takes any merge. So typing `x`, vim, and the chip are one path, and nothing in the browser decides what a completion is. Every `note.write` and `todo.set` the app sends carries `on`, the member's day (`src/web/sync.ts`). When an answer says `filed`, or `unfiled` as an undo of a completion does, the app reads its notes and folders again and an open editor of each daily note takes what was filed on it or taken off it.

`todo.history` finds the todo by `revision`, `line` and `text`. From the editor the chip sends the revision the app knows for the note with `source.line()`. The host saves what is typed before it asks, so that revision can be one behind: the server then refuses, and the chip asks once more at the revision `note.read` answers.

The Todos page changes a todo through `host.perform({ type: "todo.set", … })`. The host saves what is typed in that note's editor first and hands the editor the result, as it does for a move through history. A click on a todo opens its note and puts the cursor on its line: the plugin keeps the todo it is going to, and the editor extension it registers for that note places the cursor when the editor is there.

### Daily notes

The daily plugin (`plugins/daily/`) declares the three settings the server makes a daily note by, under the keys in `DAILY_SETTINGS` from the plugin API, so the name the server reads and the name the member is shown can't drift: `daily.folder`, `daily.private` and `daily.timeZone`. Its page at `/today` is the Today link in the sidebar. It performs `daily.open` with `today()`, tells the app about the note, has it read the folders and notes again, and puts the note at the page's own place in the browser's history with `app.show({ kind: "note", id }, { replace: true })`, so Back goes to where the member was. The command `daily.today` goes to that page. A refusal, as a viewer gets, is shown on the page in the server's words.

### Dashboard

The Dashboard plugin (`plugins/dashboard/`) is the page at `/dashboard` and the home page, so it is what the app opens to when no tab is open, and the pattern for a view made of other views' operations. It asks nothing new of the notes: events are `event.list` over the member's day, todos are `todo.list` with `dueTo` that day, the notes created or edited today are read off `app.notes`, the daily note is `daily.find`, which makes nothing, and the summary is `visit.read` and then `history.list` with `from`, `to` and `notAuthors` naming the member. So the resolver decides everything on it, a guest's is what they were granted, and nothing there counts or names a note the member can't see.

`today.ts` is what "today" means, as pure functions tested in `test/core/plugin-dashboard.test.ts`: `todayAt(now, timeZone)` is the member's date and the two instants it runs between, `aheadToday` keeps the all-day events on that date and the events that haven't ended, `editedToday` keeps the live notes whose `createdAt` or `updatedAt` is in the day, and `summarize` sums changes up by note and author. The page reads `now` with `useNow()`, so an event drops off when it ends and every section reads again at the member's midnight.

Each section reads on its own with `useRead(read, key)`, which keeps what it read before on show until the next answer is there. The key is the member's date and `stampOf(app.notes)`, which changes when any note the member can see is made, changed, or changes state, so the todos and the summary follow the app's own listing of notes and nothing polls. A card is its full size from the first, with bars where its rows will be, and what it lists scrolls inside it: no section moves when another's answer arrives. `test/browser/dashboard.spec.ts` holds every answer back and measures that.

A note is opened with `app.openNote(id, { preview: true })`, as a single click anywhere does. A todo is opened on its line with `todoOpener(host)` from `plugins/lib/openTodo.ts`, which the Todos page uses too: it keeps the todo it is going to, and the editor extension it registers places the cursor once that note's editor is there.

Pins are the member's own, kept by the server (`pin.list`, `pin.set`) and held in the browser by `pinsOf(host)` (`pins.ts`), one store for the page and for the `mark` in a note's bar. The mark is drawn from the first, disabled until the pins are read, so nothing beside it moves. The page lists the pinned notes that `app.notes` says are live, so a pin leaves it the moment the app learns its note was archived, trashed or hidden.

The last visit moves only on Mark as read, which hands `visit.mark` the `now` of the `visit.read` the summary on screen was made from. The summary reads a hundred changes at a time, goes back five readings at most, and then points at the History page.

### Archive and Trash

The Archive and Trash plugin (`plugins/trash/`) is a note's life after it is written. `plugins/lib/lifecycle.ts` holds the steps (`setArchived`, `trash`, `restore`, `purge`) and the menu items a folder's list and a tab's menu offer, so every place that can archive or trash a note does it the same way: perform the operation, hand the answer to `app.noteChanged`, `app.refresh()` for the folder counts, and say a refusal in a notice in the server's words. Moving a note to Trash shows the notice "Moved to Trash" with Undo, which restores it, and archiving one shows "Archived" with Undo, which brings it back. A card in a folder's list has Archive as a button that shows on hover and focus, and as the `E` key while the card has the keyboard. The command `note.toggleArchived` (`mod+shift+e`) and `note.trash` (no key) act on the open note.

The app itself, not the plugin, makes an editor on a note in Trash read-only and stops sending what was typed in it, since the server would refuse it: that has to hold with the plugin off. Typing that wasn't saved before the app learned the note was trashed stays in the editor, the bar says it isn't saved, and it is sent when the note is restored. The plugin adds what the member sees and does: the banner with the days left, Restore, and Delete forever, and the page at `/trash`, last under More. Delete forever is offered to an admin and to an editor, since the app can't know who made a note, and a refusal is shown in the server's words.

### Uploads

The uploads plugin (`plugins/uploads/`) is everything about files: four embeds, the ways a file gets into a note, and the Uploads page. A note refers to an upload by id and never by name, written by `writtenUpload` and read by `uploadIn` and `sizeIn` from the plugin API, the functions the core reads a note's uploads with:

- `::image{id 640x480}` and `::video{id 640x360}` are shown below their line, in a room read from the size after the id (`boxFor` in `sizing.ts`): never larger than the size written, never taller than 480 pixels, and narrowed to the note's column at the same shape. With no size the room is a fixed 480 by 270. The size is written when the file is sent, the server's reading of a picture's bytes or else the browser's own measurement taken before sending, so the room is whole before a byte of the picture arrives and nothing moves when it loads. A picture is an `<img>`, a video a `<video controls preload="metadata">`: nothing plays until asked, and nothing is ever an `<object>`, an `<embed>`, a frame, or markup built from what the server said.
- `::audio{id}` is below its line at a fixed 56 pixels, an `<audio controls preload="none">`.
- `::file{id}` is a chip in its line with the file's name and size, which downloads it.

In the line, an upload shown below it reads as its file name, or as "Image" when the name isn't known, and a click there puts the cursor in the embed as written.

What an embed knows of its upload is `host.uploads.referred(id)`, which the app fills from each read of a note before the note's editor is made. An id nothing was said of, as one typed into a note since it was read, is asked about once with `upload.read`. Each drawing is made once and made again only when what is known of its own upload changes (`live` in `drawing.ts`), so typing elsewhere, the cursor, and other uploads' news leave a picture and a playing video alone. Three things are drawn in place of the file, in the same room:

- For `null`, "This file isn't available", and nothing else: not the name, the type or the size, and its bytes are never asked for. A reader can't tell a file that was deleted from one they may not see.
- For one in Trash, "This file is in Trash" and its name, to those who can see it. An archived upload shows as usual.
- For one whose bytes then fail to load, the first again.

A file gets into a note by a paste, a drop, or "Upload a file" in the `/` menu (`sending.ts`, an editor extension made per note). `pastedFiles` in `pasting.ts` says which pastes are files: any that carry a file, except one that also carries text both plain and formatted, which is what a spreadsheet or a document copies beside a picture of the cells. Pasted text is left to the editor. The file goes to the note's own folder, and private when the note is private, so a picture isn't shown to people the note is hidden from. A file over `MAX_UPLOAD_BYTES` is refused in the browser before any of it is sent, and the server's own refusal, such as a full workspace, is said as it gave it, both through `app.notify`. Nothing is written into the note while a file is on its way: the bottom bar says how far it has got, and once the server has it the embed is written on a line of its own where the file was put (the place is kept through whatever is typed meanwhile), as one edit by the member with the user event `input.paste` or `input.drop`.

Uploads are listed on the Uploads page (`/uploads`, and `/uploads/<id>` with one selected) and nowhere else: a folder's list and the folder counts are of notes. The page narrows by name, kind, folder and archived (`narrowed` in `finding.ts`), and for the selected upload shows the notes that use it, a preview, Download, Move, Archive, Move to Trash (which says first how many notes use it), Private, Share with a person through the Share dialog, and its embed to copy. Trash lists trashed uploads beside trashed notes. Quick open offers uploads by file name after the notes (`openable`), so the notes are ranked among themselves as they are without uploads, and picking one opens the Uploads page on it.

A link's page (`SharedPage.tsx`) starts `uploadDrawing`, the four embeds alone. There `host.uploads.address` is `/api/shared/<token>/uploads/<id>`, `referred` is what `shared.read` said and `null` for anything else, and there is no `send`. A link on a note opens none of the uploads the note refers to, so each is the "isn't available" placeholder. A link on a folder opens the uploads in that folder and below it.

### Links to notes

The links plugin (`plugins/links/`) is the pattern for anything a note stores by id and shows by name. The note says `[[id]]` or `[[id|display text]]` (`docs/adr/0001-links-stored-by-id.md`); `linksOn` and `linksIn` from the plugin API read them, the same functions the core records backlinks with. The editor keeps `linksIn` of the whole text in a state field and draws exactly those, so what is drawn as a link is what the server records as one: text in a fence or in inline code is not, and an indented line is, since a bullet nested three deep is indented as far as a code block. The chip's `key` is the target's title and state from `host.app().notes` and `host.app().trashed`, and `host.onNotes` dispatches `redraw` to the open editors when any of them changed. A link to an archived note reads and opens as any link, and says "Archived" when hovered. A link to a note in Trash reads as its title followed by "(in Trash)", in the line's own size so the line is no taller, and still opens the note. A target that is in neither list is drawn as "Unavailable note" and goes nowhere: that is the one wording for a note removed from Trash, one that never was, and one the member can't see, and the app never has that note's title to leak. `plugins/links/words.ts` holds the wording. The `[[` list is a listing, so it leaves archived notes out. The `[[` list is a completion with `spaces` and `anywhere`; text after a `|` is taken as the link's display text while the list goes on narrowing by what came before it.

Following a link is the command `links.follow`, which opens the note the cursor is on a link to, through `app.openNote` as any note is opened, or opens a web address in a new tab with `noopener` when it starts `http://`, `https://`, or `mailto:`. Vim's `gd` runs that command, and so can a keybinding. ⌘-click does the same for a link to a note, drawn or as written.

### Mentions

The mentions plugin (`plugins/mentions/`) registers the `@` completion, the chip that draws a mention, and the offer to share. `people.ts` is its pure part: what `@` offers for what was typed, how a mention is shown, and who a change newly mentions. The members come from `member.list`, read when the plugin starts and again when `@` is typed more than a minute later. The member's contacts come from one `contact.list` with no query, read when `@` is first typed and kept in memory for ten minutes; what is typed after `@` narrows them in the browser and is sent nowhere. A completion item's `tone` (`accent` or `muted`) colours its label, which is how members are in the theme colour and contacts gray. Where `member.list` is refused, for a guest and on a share link's page, there are no members and every mention is drawn as the name the note writes. The chip is `written: "within"`, as a link's is, with `key` the name it shows, so it is drawn again when the members are read again. On a todo's line it has the look of the todo's other chips. The offer to share is made from an `updateListener` that looks only at transactions with an `input` user event, so a change that arrives from the server asks nothing; it goes through `host.sharing` and `app.notify` with `stays`, and its switch is the plugin's `offerToShare` setting.

### Data sources: Calendar, Contacts, and references

The calendar plugin (`plugins/calendar/`) and the contacts plugin (`plugins/contacts/`) show a member's own data sources, through `host.perform` and the operations `source.*`, `event.*`, `contact.list` and `record.*`. Nothing in either names a provider: which data sources there are, what each is called, whether it is connected, to what account, and whether it takes changes all come from `source.list`. `plugins/lib/Sources.tsx` is the part both pages share: it says each data source's state and offers Connect, Reconnect, and Disconnect, which names every data source that goes with it, since those of one provider are connected as one account. `source.connect` may answer with `redirect`, a path the browser is sent to, which comes back to the page.

Every date the Calendar works out is in `plugins/calendar/dates.ts`, a pure module that is handed the time zone, tested in `test/core/plugin-calendar-dates.test.ts`. A day is a calendar date and never 24 hours: the days of a view are counted as dates, and `startOfDay(day, timeZone)` finds the instant each starts, so a day the clock changes on is 23 or 25 hours long and `spanOf` still asks `event.list` for exactly the days on show. `daysOfEvent` says which days an event is on where the member is: an all-day event on its own dates wherever it is read, any other on the day it starts in the member's zone. The zone is the browser's, and every time is said in it.

An event is changed with `event.update`, which is sent the event's `etag` and only the fields the member changed. A refusal is shown in the server's words, and the events are read again either way. The form is made again for each reading of the event (`key={event.etag}`), so after a refusal for a stale reading it holds the event as it is now, and saving again can't write an old value over someone else's change.

A note references an event or a contact with an inline embed, `::event{ref label}` or `::contact{ref label}`, which `record.refer` writes and "Copy reference" on either page copies. `referenceEmbed` in `plugins/lib/references.tsx` draws both. The chip is drawn at once with the label, which is all the note holds, and then asks `record.read`: the member who made the reference gets the record as it is now, and the chip says its title and when it is, or the contact's name. Anyone else, and anyone at all once the record is gone, is answered `not_found`, and the chip stays the label, in gray, saying that only the member who referenced it sees its details. Nothing else is asked for them. A reading is kept for 30 seconds by member and reference, so a reference written twice is read once and typing in the note asks nothing, and `forgetReferences()` drops them after a change made in the app. The chip is text in the line's own face and size with a tint behind it, not a box: it wraps as words do, so its line is as tall as any other, drawn or as written, and the lines after it stay where they are when its details arrive. One case moves: a line that just fits with the labels can need another row once a chip also says when its event is, the first time it is read. `test/browser/sources.spec.ts` measures both.

### Tags and search

The tags plugin (`plugins/tags/`) draws a `#tag` in a note with a mark that changes its color and nothing else, the same whether or not the cursor is on its line, so there is no drawn and as written to move between. It keeps the marks in a state field read from the whole text with `linesOutsideCode` and `tagsOn` from the plugin API, the functions the core indexes tags with, so what is drawn as a tag is what `tag.list` counts. A todo's line gets the same mark: the todos plugin draws no chip for a tag. ⌘-click on a tag goes to its page, as it follows a link. `test/browser/tags.spec.ts` measures every letter of a tagged line: none moves with the cursor, and against the note with the plugin off none is further than the 1/64 of a pixel the browser places a run of text by.

Its section in the sidebar lists `tag.list`, read again a second after the notes the member can see last changed (`host.onNotes`), and its page at `/tags/<name>` lists `note.list` with `tag`. `tagPath` and `tagOfPath` in `plugins/tags/path.ts` write and read that address.

The search plugin (`plugins/search/`) holds the pattern for a list that asks the server as the member types, which the note list's search bar runs in every folder's tab and on the Search page. What a search is doing is one value, `Search` in `plugins/search/request.ts`: idle, searching, listed, or failed. What it asks is an `Ask`, the `search` operation's own arguments: the query, the folder, which states, the order. Every answer is handed to its reducer with the search it was asked for, and one for any search but the current one changes nothing, so answers can arrive in any order. A matched line is cut into pieces by `pieces` in `plugins/search/marks.ts` and drawn as text nodes and `<mark>`s. `plugins/lib/FoundNote.tsx` has what a found note's row shows and how it opens, which the tag's page shares.

### What is loaded when

KaTeX and its faces are fetched the first time a note on screen has something that reads as a formula (a price such as `$5` does not), and the code colors the first time one has a fence, each language when a block first names it (`whenSeen` in `plugins/lib/live.ts`). A note with neither loads neither. When one can't be fetched the plugin calls `host.report`, and the note shows that markdown as written.

## Keybindings

In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key: on a Mac it is its own key, and elsewhere it is the same key as `mod`, so `ctrl+o` and `mod+o` are one chord there.

The app tries a keybinding before the editor or anything else with focus sees the key, and a key that ran a command goes no further. A command that should stand aside at times gives `when`, a function that answers whether its keys run it now. While it answers false the key is left to whatever has focus. Vim mode's `vim.back` answers false in a text field and in a note in insert mode, where `ctrl+o` is the field's or vim's own.

A command's `keys` are its default chords. The member's are settings too: `keybindings.<command id>` holds a list of chords, and an empty list unbinds the command. A member's chord needs `mod`, `ctrl`, or `alt` unless its key is Escape or an F key, so that no key that types in a note runs a command. The palette shows the chord that runs a command now. A plugin does nothing to take part.

## Turning plugins off

A plugin with `enabledByDefault: false` is off until the member turns it on. Its setting `<id>.enabled` then defaults to false, and only `true` is kept in the member's document.

A member turns a plugin off from the palette (`Disable plugin: Tabs and splits`), on the Plugins page, or in settings, where it is `tabs.enabled`. All three write the same setting, so the choice follows the member to another browser. The Plugins and Settings pages are in the workspace menu and always at `/plugins` and `/settings`. They belong to the core, so they are there when the palette and the sidebar are off.

With every plugin off, the core still opens the note its address names, takes typing, and saves.

A plugin whose `activate` throws is left out whole. A view that throws while being drawn is left out alone, an embed that throws is shown as it is written, and a completion that throws offers nothing. Each way the Plugins page says what failed.

## What third-party plugins must not get as it is

The built-in plugins are trusted, and the host gives them more than an untrusted plugin can have. Third-party plugins (#16) need each of these gated first:

- `host.perform` runs as the member with the member's whole access, and the server records the member, not the plugin, as the author.
- `host.agents`, `host.members` and `host.sharing` are given to Common Ink's own plugins and to no other. The host is told its own plugins as the values it was built with (`trusted` in `createPluginHost`), so a plugin can't become one by the id or name it gives itself, and a plugin put on the page by a test (`window.__INK_FIXTURE_PLUGINS__`) is not one. Any other plugin is handed the same three objects with every method refusing: `<name> isn't given host.sharing.link: only Common Ink's own plugins are`. Each acts as the member where history can't take it back: `agents.connect` mints a token that acts as the member, `members` can invite a stranger as admin or remove the other admins, and `sharing` can put a note behind a public link. `host.members.invites()`, an admin's `member.list` and `host.sharing.all()` also carry emails. What is still open for #16 is giving one of these to a third-party plugin on an admin's say.
- The member's data sources, their contacts and calendar, are refused to a plugin that isn't Common Ink's own through `host.perform` (`ownOnly` in `pluginHost.ts`, the type `OwnOnly`). `member.list` is not: any plugin can read the members' names and roles, and an admin's plugin their emails. #16 decides whether that becomes a permission.
- A member's pins and their last visit are refused to a plugin that isn't Common Ink's own through `host.perform` (`ownOnly`, the type `OwnOnly`): `pin.*` and `visit.*`. One that could mark the summary read would hide from the member what they haven't seen.
- **Uploads.** An untrusted plugin must never be given an upload's bytes or an operation on one. Today that is three gates, and #16 has to keep all three and add a fourth. `host.uploads` (`referred`, `learn`, `address`, `send`) is given only to Common Ink's own plugins; any other is handed one that knows no upload, answers `about:blank` for every address and refuses `send` (`noUploads` in `pluginHost.ts`). Every `upload.*` operation is refused to it through `host.perform` (`ownOnly`, the type `OwnOnly`). And `upload.create`, `upload.open` and `upload.setPrivate` are refused to every plugin as operations. The fourth is the page itself: the bytes are served to the member's session at `/api/workspaces/<id>/uploads/<upload id>`, and a plugin that runs in the page can ask that address without the host, read an `<img>` the uploads plugin drew, or read `note.read`'s `uploads` through `host.perform`, which names files the note refers to. So before a third-party plugin runs, its code must be out of the page (a sandboxed frame has no session and is refused the bytes by `Cross-Origin-Resource-Policy: same-origin`), `Embed.render` and `Below.render` must not hand it an element beside an upload's drawing, and `note.read` must reach it without `uploads`, or with names and types left out.
- What the app draws is in the page, and a plugin runs in the page. So a plugin refused `contact.*` can still read the names and organizations of the contacts the `@` list shows while it is open, as it can read an open note. The list shows no contact's email for that reason. This holds until plugins are isolated from the page (#16).
- `host.commands.run` runs any command, including `plugins.disable.<another plugin>`. That command writes the member's settings, so it is a way around the refusal in `host.perform`. The palette needs it to run what the member picks.
- `Embed.render` is handed a real element inside the note, so it can reach the rest of the page from there. So is `Below.render`, which can also rewrite the embed with `update`. The HTML embed is the pattern for an untrusted one: only a `sandboxed` frame, and nothing drawn by the plugin's own code.
- A `sandboxed` frame can open a WebRTC peer connection once the member runs it, which no header stops. Until a browser offers a way, an untrusted embed has that one way out, and what it is handed must be chosen with that in mind.
- `Embedded.update` changes the note as the member, recorded as the member's change. It can only rewrite the embed's own config and body, but an untrusted embed could do that without the member touching it.
- A completion's `items` is told what the member types after its trigger, and what an item inserts is written into the note as the member.
- An editor extension runs inside the editor with the note's text, every key typed, and the page. It must also be built from the app's own copy of `@codemirror/state`, which a plugin loaded from elsewhere doesn't have.
- `host.storage` is the browser's localStorage under a prefix, which any script on the page can read.
- A view is handed `app`, which carries the member's email, every note's title and first lines, `signOut`, `switchWorkspace`, and `reloadWorkspaces`. Each view is drawn with the `app` its own plugin is given (`provide` in `Workspace.tsx`), so that is the one place to narrow it.
