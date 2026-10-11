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
- `host.views.register(slot, view)` puts a view in a slot. The slots are `column`, `section`, `rail`, `editor`, `inspector`, `page`, `bar`, and `overlay`. A page gets a `go.<id>` command.
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
| In a note, inline | `host.embeds.register({ name, render })`, written `::name{config}` | The note: its config | Timer (`timer`), Stopwatch (`stopwatch`), Link (`media`) |
| In a note, as a block | `host.embeds.register({ name, block: true, render })`, written `:::name{config}` … `:::` | The note: its config and body | Kanban board (`kanban`) |
| In a note, below its line | An embed, inline or block, that also gives `below: { box, render }` | The note: its config and body | YouTube video and Social post (`media`), HTML (`html`) |
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

`box` says what room to keep, from what the note says of the embed alone, so the room is there in the first frame painted and nothing moves when what fills it loads. The room is under the line that writes the embed, or under a block embed's closing line, and stays while the cursor is on that line: the line is shown as written and what is below it is not touched.

`below.render` draws into an element the host keeps outside the note's text, laid over the room. CodeMirror makes its own elements again whenever it likes, and drops the ones scrolled out of sight, and a frame that is taken out of the page, or only moved in it, loads again. So the element is made once, the first time the room is on screen, is never moved in the page, and is only placed where its room is after each change. It lasts while the note says the same of the embed: through typing anywhere else, lines added and removed, the cursor, another member's change, and scrolling far away, where it goes on running. `keep` in `src/web/belowIdentity.ts` says which embed is which after a change. When the note says something else of the embed, what `render` returned is called, the element is emptied, and `render` is called again in it. An edit that passes through a config with nothing to show, such as a video's id with a letter deleted, takes the element out, and the next one is new.

**The room comes from the note, and only from the note.** `render` can't resize it. What is only known after loading gets into the note: `render` is handed `update`, which rewrites the embed as `Embedded.update` does, and `box` then reads it. This is the rule for pictures and files (#22): the upload writes a picture's size into its config when it is inserted (`::image{id 1200x800}`), so its room is right from the first frame for everyone. One written by hand without a size gets a usual room, and writes its size with `update` once it has loaded, which moves the lines below it once and never again. A test in `test/browser/media.spec.ts` does exactly that with a fixture embed.

Not covered: a tab switch or a split makes the editor again, so what was below a line starts over (#36).

`test/browser/media.spec.ts` holds a playing video to this through each kind of change, and checks every painted frame for a room without what fills it.

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

`host.completions.register({ id, trigger, items })` offers a list at the cursor. It opens when the member types the trigger at the start of a line or after a space, and not inside code, so the `/` of a URL, a path, or a date opens nothing. `items(typed)` is asked on each keystroke for what to offer for the text typed after the trigger, best first, and may answer with a promise. One that answers at once is in the list by the member's next key, so a name typed after `/` and Enter with no pause picks it. Completions whose triggers both fit share the list, each one's items together, in the order of their plugins. With nothing from any of them the list closes. Each item has a `label`, an optional `detail`, and `insert`, the text that takes the place of the trigger and what was typed. `select` leaves part of it selected, `block` puts it on lines of its own, and `spaces: true` on the completion lets what is typed hold spaces, as a note's title does.

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
- `host.agents.connect` mints a token that acts as the member.
- `host.commands.run` runs any command, including `plugins.disable.<another plugin>`. That command writes the member's settings, so it is a way around the refusal in `host.perform`. The palette needs it to run what the member picks.
- `Embed.render` is handed a real element inside the note, so it can reach the rest of the page from there. So is `Below.render`, which can also rewrite the embed with `update`. The HTML embed is the pattern for an untrusted one: only a `sandboxed` frame, and nothing drawn by the plugin's own code.
- A `sandboxed` frame can open a WebRTC peer connection once the member runs it, which no header stops. Until a browser offers a way, an untrusted embed has that one way out, and what it is handed must be chosen with that in mind.
- `Embedded.update` changes the note as the member, recorded as the member's change. It can only rewrite the embed's own config and body, but an untrusted embed could do that without the member touching it.
- A completion's `items` is told what the member types after its trigger, and what an item inserts is written into the note as the member.
- An editor extension runs inside the editor with the note's text, every key typed, and the page. It must also be built from the app's own copy of `@codemirror/state`, which a plugin loaded from elsewhere doesn't have.
- `host.storage` is the browser's localStorage under a prefix, which any script on the page can read.
- A view is handed `app`, which carries the member's email, every note's title and first lines, `signOut`, and `switchWorkspace`. Each view is drawn with the `app` its own plugin is given (`provide` in `Workspace.tsx`), so that is the one place to narrow it.
