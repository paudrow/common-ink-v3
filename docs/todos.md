# Todos

A todo is a checkbox line in a note. There is no other record of it: the note's text is the todo, and everything else is read from that text. This page is the grammar, the index behind the Todos page, and the operations. The code is `src/core/todos.ts`, which the server, the editor and the Todos page all read a todo with.

## How a todo is written

    - [ ] !! Call the bank due:2026-10-14 +Home #money

| Part | Written | Rule |
| --- | --- | --- |
| The todo | `- [ ]` open, `- [x]` done | A list item with a checkbox: `-`, `*`, `+`, `1.` or `1)`, at any indent, then `[ ]`, `[x]` or `[X]`, then a space or the end of the line. Anywhere in a note outside a fenced code block. |
| Importance | `!`, `!!`, `!!!` | Right after the checkbox, one to three marks standing alone. None is normal. |
| Due date | `due:2026-10-14` | A real calendar date as `YYYY-MM-DD`. No time and no time zone. The first one on the line counts; a second is words. |
| Recurrence | `every:2w` | One of the rules below. The first one that can be read counts. |
| Last done | `done:2026-10-10x12` | The day a recurring todo was last checked off, and how many times it has been. With no `x12` it was once. Checking the todo off writes it. |
| Project | `+Home` | A letter, then letters, digits, `_` and `-`. A todo can be in several. Matched ignoring case. |
| Tag | `#money` | Letters, digits, `_`, `-` and `/`, with something besides digits, so `#12` is not a tag. It tags the whole note, on a todo's line as on any other. Matched ignoring case. |

A token stands alone: it follows a space, and is followed by a space, the end of the line, or one of `.,;:!?)`. So `C++`, `a+b`, `1 + 2` and `+1` are not projects, and `a#b` is not a tag. Text in inline code, in a link to a note (`[[…]]`), and in a link's address (`](…)`) is never a token.

Where issue 1 was silent, the choices were made for text that is plain to read and to type, that parses one way, and that an agent can write without asking:

| Question | Choice | Why |
| --- | --- | --- |
| How is a due date written? | `due:YYYY-MM-DD` and nothing else. | Issue 1 says "`due:` followed by a date". One form sorts as text, means the same everywhere, and needs no locale. `due:tomorrow` would mean a different day each day it is read. |
| Does a due date have a time? | No. | `CONTEXT.md`: "A due date is a calendar date". A time needs a zone, and a note has none. |
| Can a todo be in several projects? | Yes. | Nothing says otherwise, and `+A +B` already reads that way. |
| What is a todo line inside a quote, or with no list mark? | Not a todo. | It is not a task list item in GitHub-flavored markdown either, and the note list has never counted it. |
| What does removing an option do to the line? | Takes the token and the one space before it. | The line reads as if the token had never been typed. |
| Where does a new option go? | Importance right after the checkbox. A due date, a recurrence, a last-done mark or a project at the end of the line. | Importance is defined by its place. The others are easiest to find at the end. |

`rewriteTodo(line, change)` makes a change to a line. It replaces the one token's own characters and leaves every other character of the line as it was, which `test/core/todos-line.test.ts` checks token by token.

## Recurrence

A todo with `every:` recurs. The rule is in lower case, and anything else after `every:` is words. `src/core/recurrence.ts` reads a rule and works out the next due date, and `docs/adr/0004-recurrence-is-a-token-and-a-completion-is-one-act.md` says why it is written this way.

| Written | Recurs | Next due date |
| --- | --- | --- |
| `every:3d`, `2w`, `1m`, `1y` | Every N days, weeks, months or years, 1 to 999: N after the due date. | The due date plus N, and again until it is after the day it was done. So done on time or early it is one step on, and done late it skips what was missed and is never left overdue. |
| `every:3d-after-done` | N after it was last completed. | The day it was done plus N. |
| `every:mon,thu` | On those days of the week: `mon tue wed thu fri sat sun`, with commas and no spaces. | The first of those days after both the due date and the day it was done. |
| `every:3rd-day` | The Nth day of the month, `1st` to `31st`. | The same. A month too short for it gives its last day. |
| `every:last-day`, `every:2nd-last-day` | N days from the end of the month: the last day, the one before it. | The same. A month too short gives its first day. |
| `every:2nd-tue` | The Nth of that weekday in the month, `1st` to `5th`. | The same. A month with no 5th one is skipped. |
| `every:last-fri`, `every:2nd-last-fri` | The same, counted from the end of the month. | The same. |

A due date is a day, so the next one is a day too: no clock is read, and a clock changing changes nothing (`test/zones/` runs the sums in zones whose clocks do). Adding months or years keeps the day of the month, or takes the month's last day when it has no such day: 31 January and a month is 28 February, and a month after that is 28 March. `every:last-day` is how a todo stays on the month's end. A todo with a rule and no due date gets one when it is first checked off, counted from that day. A next due date past the year 9999 checks the todo off for good.

Checking off a todo that recurs does three things as one: the line stays open with its next due date; its `done:` mark says the day and one more time; and the line as it was, checked and without `every:` and `done:`, is filed at the end of the completer's daily note with a link back to the todo's note.

    - [ ] Water the plants due:2026-10-10 every:1w +Home                       before, checked off on the 11th
    - [ ] Water the plants due:2026-10-17 every:1w +Home done:2026-10-11x1     after, in the same note
    - [x] Water the plants due:2026-10-10 +Home [[k3j5h8d9f0a1]]               on the daily note for the 11th

It is the same whichever way the box is checked. `todo.set` with `done` does it, which is the Todos page and an agent's `set_todo`. So does any write of the note that checks a recurring todo's box: the checkbox in the editor, an `x` typed between the brackets, vim, an agent writing the whole note. The server finds those when the write lands (`checkedOff` in `src/core/todos.ts`) and answers with the line rolled forward, which the editor takes as it takes any merge. A todo is checked off by a write when its line was an open todo before and is a done, recurring one after, whatever else on the line the write changed. Which line is which is read from where the write's changes are, never from what a line says, so a word typed on the line in the same save changes nothing. A line written already checked was never open and is left as written, and so is one checked by an undo or a revert, which put a note back and complete nothing. To finish a recurring todo for good, take its `every:` away. The editor's checkbox saves at once, so the line comes back open without waiting for a pause in typing.

Both notes change in one batch with the record of the completion, so they change together or not at all, and each change is recorded as the completer's. Asked twice, it is done once: `todo.set` follows the line it was shown and changes nothing when that line already reads as the call would leave it, and a write sent again, or made on a revision from before someone else completed the todo, finds a completion recorded on that line since the revision it was based on, and leaves its box open.

Taking a completion back takes back what it filed. An undo, a revert to a revision, a revert of chosen changes and reverting an author all put the todo's line back, count and all, since both are in the text. In the same batch the line that completion filed is taken off the daily note, as a change by whoever took it back. It is found by following the place it was filed at through the daily note's changes since (`completions.daily_revision` and `daily_at`), never by what it says, and everything else on the daily note is left alone. A filed line the member has edited or deleted since is left as they have it, and the answer's `unfiled.left` counts it. A redo, or reverting the change that reverted the completion, files the line again unless it is still there. So a completion that stands has one filed line however often it was undone and redone.

## Daily notes

A member has one daily note for a day: `daily_notes` holds which note it is, by workspace, member and day, and is what stops two being made at once. The note itself is an ordinary note headed `# 2026-10-11`. It is made the first time it is needed, by a completion or by `daily.open`, in the folder at the top of the workspace that the member's setting `daily.folder` names, ignoring case, default `Daily`. The folder is made too when there is none. Changing the setting changes where the next one is made and moves nothing. A daily note is found by that row and not by its title or folder, so it stays the member's daily note when they move it or rewrite its heading.

A new daily note is private to its member unless their setting `daily.private` is false. A line filed on it is a copy of a todo from a note that may itself be private or shared with only a few, and the Daily folder is an ordinary folder that every member sees. So the todo's words are filed only where whoever reads the daily note could read the todo: on a daily note that is private to the completer and shared with nobody, or when neither the todo's note nor the daily note is private and there is no grant and no share link on either of them or on any folder above them. Anywhere else what is filed is the link back alone, `- [x] [[id]]`, which shows the note's title to those who can see it and reads as unavailable to the rest.

A member's daily notes don't keep them from leaving a workspace, though they are private notes. As the member leaves, each stops being private and records whose it was, the way a removed member's private notes do. Any other private note still has to be handed over first, and the refusal says how many there are.

An agent's completion is filed on the daily note of the member it acts for, as the agent's change. Someone who can't have a daily note here completes the todo all the same and files nothing: a guest, and a member who can't write in their daily folder. The answer's `filed.dailyNoteId` is then null.

## Today

A due date is a day, and whether it is today depends on who is looking. The browser works out today from its own clock and time zone (`src/web/plugins/todos/dates.ts`). The server never works out today: `todo.list` takes `dueFrom` and `dueTo` as days, so "overdue" is asked for as "due on or before yesterday", with yesterday said by the asker. An agent passes the days it means.

The one place the server does work out a day is a completion with no day given. `todo.set`, `note.write` and `daily.open` take `on`, the completer's day, and the app always sends it. An agent that leaves it out gets today in the zone its member's setting `daily.timeZone` names, or in UTC when it names none. The server reads those three settings of the member's to file a completion. It tells an agent none of them.

## The index

Three tables hold what the Todos page lists, so that no note's text is read to list todos:

- `todos`: one row for each todo, with its note, its line counted from 0, whether it is done, its importance, its due date, and the line as written.
- `todo_projects`: one row for each project of each todo, as a key in lower case and the name as written.
- `note_tags`: one row for each tag of each note, the same way. #21 lists notes by tag from here.

They are written in the same batch as every change to a note's text (`indexing` in `src/core/operations.ts`, beside `linking`): creating a note, a write, a revert, an undo, a redo, and reverting an author all go through `record`. So the index never says anything the text doesn't. A part that a change leaves the same is not rewritten.

The index mends itself. Each note carries `indexed`, which is 0 until its links and its index have been made from its text. A note at 0, as every note written before the tables existed is, has all of it made on its next write, and `todo.list` and `todo.filters` first make it for every such note in the workspace, 400 a call. This covers notes the asker can't see, their text read on the server only: what is written is read back through `SEEN`, so nothing of them reaches the asker. Nobody runs anything after the migration.

`todos.rebuild` and `links.rebuild` are one operation under two names, for an admin, for an index changed some other way. It sets every note in the workspace back to 0 and makes them again, private notes of other members included. Its answer is `{ done }` and nothing else, so it says nothing of how many notes there are: ask again while `done` is false.

## Operations

| Operation | Tool | `ink` | Needs |
| --- | --- | --- | --- |
| `todo.list` | `list_todos` | `todos` | view |
| `todo.filters` | `todo_filters` | `todo-filters` | view |
| `todo.set` | `set_todo` | `todo` | edit on the note |
| `todo.history` | `todo_history` | `todo-history` | view |
| `daily.open` | `daily_note` | `daily` | a member who can make notes |
| `todos.rebuild` | `rebuild_todos` | `todos-rebuild` | admin |

`todo.list` lists open todos, or done ones too with `includeCompleted`, from the notes the asker can see: open first, then the soonest due with undated ones last, then the most important. It narrows by `project`, by `tag` (the note's), by `dueFrom` and `dueTo` (both included), by `noDue`, by `importance` (the levels wanted), and by `noteId`. `todo.filters` gives the projects and tags there are to narrow by. Both carry `SEEN`: a todo in a note the asker can't see is not listed, not counted, and its project and tag names are not offered.

`todo.set` rewrites one todo's line as a change to its note by whoever asks. It takes the todo as `todo.list` gave it: `id`, the note's `revision`, `line` and `text`. The line the caller was shown is followed through every change recorded since that revision, by mapping its place through each change, so it is found wherever it has moved to. What a line says never decides which line it is, so another todo that reads the same is never taken for it. When the line itself was changed or deleted since, the call is refused as a conflict and nothing is written. The same call made twice is done once: the second finds the line already reading as asked.

One case is not decided by the caller. When one of two identical todos is deleted, the text can't say which, and the record of the change names one of them. The one that is left is then whichever the record kept, for either listing. Nothing else is ever changed in place of a todo the caller pointed at.
Checking a todo off through `todo.set` goes through `completeTodo`, and `every` sets or clears how it recurs. The editor's checkbox writes `[x]`, and the server completes a recurring todo when that write lands, by the same function.

`todo.history` lists each time a recurring todo was checked off: the day, who did it, and the daily note it was filed on when the asker can see that note. The `completions` table holds one row a completion, written in the batch that made it, with where the todo's line started then. A todo has no id, so its completions are found the way `todo.set` finds a todo: each of those places is followed through every change to the note since, to the line it is now. That keeps a todo's history through being reworded, reordered among its neighbours, and having lines added above it. It loses the history of a line cut out and pasted elsewhere, whose `done:` mark still carries the count. A completion that was undone is left out.

## In the editor

The todos plugin (`src/web/plugins/todos/`) draws six chips on a todo's line: the checkbox, importance, the due date, the recurrence, the last-done mark, and each project. Each is drawn over the width of its own token (`keepsWidth`), so the line is the same width drawn and as written, and nothing moves when the cursor comes to the line. `test/browser/todos.spec.ts` measures it at two column widths, with a todo that wraps. `test/browser/recurrence.spec.ts` does the same for the recurrence and last-done chips. On the cursor's line the tokens are text, and vim's motions and operators go over them as text.

A chip is the browser's own control laid over what it says: a select for importance and for the project, with the projects there are in the notes the member can see, and a date field for the due date. Changing one rewrites the token as the member's edit. A viewer's are disabled. Typing `due:` offers the days of the week ahead.

The editor draws a todo on exactly the lines `todosIn` finds in the whole text, which is what the server indexes. So a checkbox nested three deep is a todo in both, though the editor's own parse takes a line indented that far for code.

The recurrence chip says `↻` and the rule as written, and opens a form to set it: the common rules first, then every kind under Advanced, and a way to stop it recurring. The last-done chip says the day and the count, and opens the todo's history from `todo.history`. Checking the box of a recurring todo in the editor writes `[x]` as any typing would. About a second later, when that is saved, the server completes it and the line comes back open with its next due date.
