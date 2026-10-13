# Todos

A todo is a checkbox line in a note. There is no other record of it: the note's text is the todo, and everything else is read from that text. This page is the grammar, the index behind the Todos page, and the operations. The code is `src/core/todos.ts`, which the server, the editor and the Todos page all read a todo with.

## How a todo is written

    - [ ] !! Call the bank due:2026-10-14 #money

| Part | Written | Rule |
| --- | --- | --- |
| The todo | `- [ ]` open, `- [x]` done | A list item with a checkbox: `-`, `*`, `+`, `1.` or `1)`, at any indent, then `[ ]`, `[x]` or `[X]`, then a space or the end of the line. Anywhere in a note outside a fenced code block. |
| Importance | `!`, `!!`, `!!!` | Right after the checkbox, one to three marks standing alone. None is normal. |
| Due date | `due:2026-10-14` | A real calendar date as `YYYY-MM-DD`. No time and no time zone. The first one on the line counts; a second is words. |
| Tag | `#money` | Letters, digits, `_`, `-` and `/`, with something besides digits, so `#12` is not a tag. It tags the whole note, on a todo's line as on any other. Matched ignoring case. |

A token stands alone: it follows a space, and is followed by a space, the end of the line, or one of `.,;:!?)`. So `a#b` is not a tag. Text in inline code, in a link to a note (`[[…]]`), and in a link's address (`](…)`) is never a token.

Where issue 1 was silent, the choices were made for text that is plain to read and to type, that parses one way, and that an agent can write without asking:

| Question | Choice | Why |
| --- | --- | --- |
| How is a due date written? | `due:YYYY-MM-DD` and nothing else. | Issue 1 says "`due:` followed by a date". One form sorts as text, means the same everywhere, and needs no locale. `due:tomorrow` would mean a different day each day it is read. |
| Does a due date have a time? | No. | `CONTEXT.md`: "A due date is a calendar date". A time needs a zone, and a note has none. |
| What is a todo line inside a quote, or with no list mark? | Not a todo. | It is not a task list item in GitHub-flavored markdown either, and the note list has never counted it. |
| What does removing an option do to the line? | Takes the token and the one space before it. | The line reads as if the token had never been typed. |
| Where does a new option go? | Importance right after the checkbox. A due date at the end of the line. | Importance is defined by its place. A date is easiest to find at the end. |

## Tags and folders, and no projects

A todo is grouped two ways, both of them the note's own. There is nothing else to learn:

- **Tags.** The `#tags` of todos are the `#tags` of notes. A todo counts as tagged with the tags written on its own line and with every tag of its note, wherever in the note that tag is written. So `#work` in a note's title tags each todo in the note, and a list narrowed to `#work` shows them all. The Todos page shows a tag on a todo's card only where the todo's own line writes it. A todo listed for its note's tag has that tag beside its note's name instead, which says why it is there.
- **Folders.** A todo is in the folder its note is in. `todo.list` takes `folderId` and lists the todos of that folder and of every folder under it.

There are no projects. Todos once had a `+Name` token for one. It read like a tag, nothing said how it differed from one, and it was a third way to group beside the two a note already has, so it was taken out. A `+Home` already written on a todo stays in the note as it is, as words of the todo: nothing rewrites it, no chip is drawn for it, and nothing lists by it. To keep such a grouping, write it as a tag.

`rewriteTodo(line, change)` makes a change to a line. It replaces the one token's own characters and leaves every other character of the line as it was, which `test/core/todos-line.test.ts` checks token by token.

## Today

A due date is a day, and whether it is today depends on who is looking. The browser works out today from its own clock and time zone (`src/web/plugins/todos/dates.ts`). The server never works out today: `todo.list` takes `dueFrom` and `dueTo` as days, so "overdue" is asked for as "due on or before yesterday", with yesterday said by the asker. An agent passes the days it means.

## The index

Two tables hold what the Todos page lists, so that no note's text is read to list todos:

- `todos`: one row for each todo, with its note, its line counted from 0, whether it is done, its importance, its due date, and the line as written.
- `note_tags`: one row for each tag of each note, as a key in lower case and the name as first written. #21 lists notes by tag from here.

Migration `0034` drops the table `todo_projects`, which held the projects. The other two hold what they held, so nothing is made again for it.

They are written in the same batch as every change to a note's text (`indexing` in `src/core/operations.ts`, beside `linking`): creating a note, a write, a revert, an undo, a redo, and reverting an author all go through `record`. So the index never says anything the text doesn't. A part that a change leaves the same is not rewritten.

The index mends itself. Each note carries `indexed`, which is 0 until its links and its index have been made from its text. A note at 0, as every note written before the tables existed is, has all of it made on its next write, and `todo.list` and `todo.filters` first make it for every such note in the workspace, 400 a call. This covers notes the asker can't see, their text read on the server only: what is written is read back through `SEEN`, so nothing of them reaches the asker. Nobody runs anything after the migration.

`todos.rebuild` and `links.rebuild` are one operation under two names, for an admin, for an index changed some other way. It sets every note in the workspace back to 0 and makes them again, private notes of other members included. Its answer is `{ done }` and nothing else, so it says nothing of how many notes there are: ask again while `done` is false.

## Operations

| Operation | Tool | `ink` | Needs |
| --- | --- | --- | --- |
| `todo.list` | `list_todos` | `todos` | view |
| `todo.filters` | `todo_filters` | `todo-filters` | view |
| `todo.set` | `set_todo` | `todo` | edit on the note |
| `todos.rebuild` | `rebuild_todos` | `todos-rebuild` | admin |

`todo.list` lists open todos, or done ones too with `includeCompleted`, from the notes the asker can see: open first, then the soonest due with undated ones last, then the most important. It narrows by `folderId` (that folder and every folder under it), by `tag` (a tag of the todo's note, which a tag on the todo's own line is), by `dueFrom` and `dueTo` (both included), by `noDue`, by `importance` (the levels wanted), and by `noteId`. `todo.filters` gives the tags there are to narrow by, and `folder.list` the folders. Both carry `SEEN`: a todo in a note the asker can't see is not listed, not counted, and its tag names are not offered. The folder narrows inside that and never widens it: it is read by `loadFolder`, so a folder the asker can't see, an agent's folder limit included, is "No such folder" as one that was never there is, and a private note inside a folder they can see is still not listed.

`todo.set` rewrites one todo's line as a change to its note by whoever asks. It takes the todo as `todo.list` gave it: `id`, the note's `revision`, `line` and `text`. The line the caller was shown is followed through every change recorded since that revision, by mapping its place through each change, so it is found wherever it has moved to. What a line says never decides which line it is, so another todo that reads the same is never taken for it. When the line itself was changed or deleted since, the call is refused as a conflict and nothing is written. The same call made twice is done once: the second finds the line already reading as asked.

One case is not decided by the caller. When one of two identical todos is deleted, the text can't say which, and the record of the change names one of them. The one that is left is then whichever the record kept, for either listing. Nothing else is ever changed in place of a todo the caller pointed at.

Checking a todo off, from the editor's checkbox, the Todos page or `todo.set`, goes through `completeTodo`, which is where recurrence (#20) hooks in.

## In the editor

The todos plugin (`src/web/plugins/todos/`) draws three chips on a todo's line: the checkbox, importance, and the due date. Each is drawn over the width of its own token (`keepsWidth`), so the line is the same width drawn and as written. A chip is shown as written only while the cursor is on that one token, inside it or at its edge. The cursor anywhere else on the line changes nothing: the box stays a box and the date stays a chip. `test/browser/todos.spec.ts` walks the cursor along every todo's line a letter at a time, at two column widths with a todo that wraps, and checks that one token at most is as written and that nothing else moves. The token the cursor is on is text, and vim's motions and operators go over it as text. A tag is not a chip: it is the note's text as written.

A chip is the browser's own control laid over what it says: a select for importance, and a date field for the due date. Changing one rewrites the token as the member's edit. A viewer's are disabled. Typing `due:` offers the days of the week ahead.

## The Todos page

Each todo is a card, in the look of the Plugins page and of a folder's notes. A card has two things to press: its checkbox, and its words, which open its note with the cursor on its line. Everything else is in one menu, from the card's "…" button, a right-click on the card, or the menu key or Shift+F10 with the keyboard in the card: open the note, open it to the side, set importance, and set, pick or clear the due date. Importance and the due date are shown on the card as plain chips when they are set, and a todo with neither shows neither.

The list is narrowed by folder, tag, due date and importance, and to completed ones too. The filters are kept in the browser, so the page opens as it was left.

## Undo

Checking a todo off, on the Todos page or with a note's checkbox, shows a toast for eight seconds: "Completed", the todo's words, **Undo**, and a button to dismiss it. One is shown at a time, and it is laid over the app, so nothing moves. Opening a todo again shows none.

Undo opens the todo again as an ordinary change, by the path the tick took. On the Todos page it is `todo.set` with `done: false`, for the line the tick left at the revision it made. In a note it is an edit to the line, which the editor has followed through every change since the tick, so Ctrl+Z takes it back as it does typing. If that editor is gone by then, it is `todo.set`. Either way it is in History as a change of its own. When the line no longer reads as the tick left it, nothing is written and the toast says the todo was changed.

The editor draws a todo on exactly the lines `todosIn` finds in the whole text, which is what the server indexes. So a checkbox nested three deep is a todo in both, though the editor's own parse takes a line indented that far for code.
