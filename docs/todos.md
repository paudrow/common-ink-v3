# Todos

A todo is a checkbox line in a note. There is no other record of it: the note's text is the todo, and everything else is read from that text. This page is the grammar, the index behind the Todos page, and the operations. The code is `src/core/todos.ts`, which the server, the editor and the Todos page all read a todo with.

## How a todo is written

    - [ ] !! Call the bank due:2026-10-14 #money

| Part | Written | Rule |
| --- | --- | --- |
| The todo | `- [ ]` open, `- [x]` done | A list item with a checkbox: `-`, `*`, `+`, `1.` or `1)`, at any indent, then `[ ]`, `[x]` or `[X]`, then a space or the end of the line. Anywhere in a note outside a fenced code block. |
| Importance | `!`, `!!`, `!!!` | Right after the checkbox, one to three marks standing alone. None is normal. |
| Due date | `due:2026-10-14` | A real calendar date as `YYYY-MM-DD`. No time and no time zone. The first one on the line counts; a second is words. |
| Repeat | `every:2w` | One of the rules below. The first one that can be read counts. |
| Last done | `done:2026-10-10x12` | The day a repeating todo was last checked off, and how many times it has been. With no `x12` it was once. Checking the todo off writes it. |
| Tag | `#money` | Letters, digits, `_`, `-` and `/`, with something besides digits, so `#12` is not a tag. It tags the whole note, on a todo's line as on any other. Matched ignoring case. |

A token stands alone: it follows a space, and is followed by a space, the end of the line, or one of `.,;:!?)`. So `a#b` is not a tag. Text in inline code, in a link to a note (`[[…]]`), and in a link's address (`](…)`) is never a token.

Where issue 1 was silent, the choices were made for text that is plain to read and to type, that parses one way, and that an agent can write without asking:

| Question | Choice | Why |
| --- | --- | --- |
| How is a due date written? | `due:YYYY-MM-DD` and nothing else. | Issue 1 says "`due:` followed by a date". One form sorts as text, means the same everywhere, and needs no locale. `due:tomorrow` would mean a different day each day it is read. |
| Does a due date have a time? | No. | `CONTEXT.md`: "A due date is a calendar date". A time needs a zone, and a note has none. |
| What is a todo line inside a quote, or with no list mark? | Not a todo. | It is not a task list item in GitHub-flavored markdown either, and the note list has never counted it. |
| What does removing an option do to the line? | Takes the token and the one space before it. | The line reads as if the token had never been typed. |
| Where does a new option go? | Importance right after the checkbox. A due date, a repeat or a last-done mark at the end of the line. | Importance is defined by its place. The others are easiest to find at the end. |

## Tags and folders, and no projects

A todo is grouped two ways, both of them the note's own. There is nothing else to learn:

- **Tags.** The `#tags` of todos are the `#tags` of notes. A todo counts as tagged with the tags written on its own line and with every tag of its note, wherever in the note that tag is written. So `#work` in a note's title tags each todo in the note, and a list narrowed to `#work` shows them all. The Todos page shows a tag on a todo's card only where the todo's own line writes it. A todo listed for its note's tag has that tag beside its note's name instead, which says why it is there.
- **Folders.** A todo is in the folder its note is in. `todo.list` takes `folderId` and lists the todos of that folder and of every folder under it.

There are no projects. Todos once had a `+Name` token for one. It read like a tag, nothing said how it differed from one, and it was a third way to group beside the two a note already has, so it was taken out. A `+Home` already written on a todo stays in the note as it is, as words of the todo: nothing rewrites it, no chip is drawn for it, and nothing lists by it. To keep such a grouping, write it as a tag.

`rewriteTodo(line, change)` makes a change to a line. It replaces the one token's own characters and leaves every other character of the line as it was, which `test/core/todos-line.test.ts` checks token by token.

## Repeat

A todo with `every:` repeats. The rule is in lower case, and anything else after `every:` is words. `src/core/recurrence.ts` reads a rule and works out the next due date, and `docs/adr/0004-recurrence-is-a-token-and-a-completion-is-one-act.md` says why it is written this way.

| Written | Repeats | Next due date |
| --- | --- | --- |
| `every:3d`, `2w`, `1m`, `1y` | Every N days, weeks, months or years, 1 to 999: N after the due date. | The due date plus N, and again until it is after the day it was done. So done on time or early it is one step on, and done late it skips what was missed and is never left overdue. |
| `every:3d-after-done` | N after it was last completed. | The day it was done plus N. |
| `every:mon,thu` | On those days of the week: `mon tue wed thu fri sat sun`, with commas and no spaces. | The first of those days after both the due date and the day it was done. |
| `every:2w-mon,thu` | On those days of every Nth week, N from 2. Weeks start on Monday and are counted from the week of the due date. | The same, among the weeks that count. |
| `every:3rd-day` | The Nth day of the month, `1st` to `31st`. | The same. A month too short for it gives its last day. |
| `every:last-day`, `every:2nd-last-day` | N days from the end of the month: the last day, the one before it. | The same. A month too short gives its first day. |
| `every:2nd-tue` | The Nth of that weekday in the month, `1st` to `5th`. | The same. A month with no 5th one is skipped. |
| `every:last-fri`, `every:2nd-last-fri` | The same, counted from the end of the month. | The same. |
| `every:1st-day,15th-day`, `every:1st-tue,3rd-tue` | Several days of the month, or several weekdays of it, in one rule. A list is of one kind or the other. | The first of them after both dates. |
| `every:3m-last-fri`, `every:2m-1st-day,15th-day` | Any of the rules of a month, every Nth month, N from 2, counted from the month of the due date. | The same, among the months that count. |
| `every:mar-1` | That date every year: `jan` to `dec` and the day. `feb-29` is the 28th in a year without one. | The first such date after both dates. |
| `every:1st-mon-mar`, `every:last-fri-nov` | That weekday of that month every year. | The same. |
| `every:2y-mar-1` | Either rule of a year, every Nth year, N from 2, counted from the year of the due date. | The same, among the years that count. |
| `-until-2026-12-31` after any rule | It ends: no occurrence after that day. | When the next one would be after that day, there is none. |
| `-times-5` after any rule | It ends: 5 more times, counting the one that is due now. | Each completion and each skip writes one fewer. At `-times-1` there is no next one. |

Each rule has one spelling. Every one is written with no number (`mon`, not `1w-mon`), a list is written in order (days of a week Monday first, days of a month from its 1st to its last, weekdays by their count and then Monday first), and an end is the last thing in the token, one of the two. A token that says a rule another way is words. The one exception is older than the rest: the days of a week alone are read in any order, and written Monday first by anything that sets them.

A rule that ends is still one token, so it is one chip in the editor and one `every` value in every listing: `every:1m-times-5`, `every:mon,thu-until-2026-12-31`, `every:3d-after-done-times-3`. The last time of such a rule checks the todo off for good: its box is checked, its tokens stay as written, and that completion is recorded and filed like any other.

**Skipping** moves a repeating todo to its next due date with nothing checked off, recorded as a completion, or filed: `todo.set` with `skip: true`. The next date is the first after both the due date and the day it is skipped on, as if it had been done on the later of the two. It counts as one of a rule's `-times-N`. A todo that doesn't repeat can't be skipped, and neither can the last time of a rule that ends.

Each client says a rule in the same words, which `src/core/recurrence.ts` makes: `ruleLabel` for a chip ("every 2 weeks on Mon", "monthly on the 1st & 3rd Tue", "yearly on Mar 1", "3 days after done", and " · 5 left" or " · until Jun 30" for an end), and `describeRule` for the sentence a rule is set by ("Every 2 weeks on Monday and Thursday, 5 more times"). `todo.list` gives the first as `recurs` beside `every`.

A due date is a day, so the next one is a day too: no clock is read, and a clock changing changes nothing (`test/zones/` runs the sums in zones whose clocks do). Adding months or years keeps the day of the month, or takes the month's last day when it has no such day: 31 January and a month is 28 February, and a month after that is 28 March. `every:last-day` is how a todo stays on the month's end, and `pastThe28th` is what the editor of a rule asks to say so. A todo with a rule and no due date gets one when it is first checked off, counted from that day. A next due date past the year 9999 checks the todo off for good.

Checking off a todo that repeats does three things as one: the line stays open with its next due date; its `done:` mark says the day and one more time; and the line as it was, checked and without `every:` and `done:`, is filed at the end of the completer's daily note with a link back to the todo's note.

    - [ ] Water the plants due:2026-10-10 every:1w #home                       before, checked off on the 11th
    - [ ] Water the plants due:2026-10-17 every:1w #home done:2026-10-11x1     after, in the same note
    - [x] Water the plants due:2026-10-10 #home [[k3j5h8d9f0a1]]               on the daily note for the 11th

It is the same whichever way the box is checked. `todo.set` with `done` does it, which is the Todos page and an agent's `set_todo`. So does any write of the note that checks a repeating todo's box: the checkbox in the editor, an `x` typed between the brackets, vim, an agent writing the whole note. The server finds those when the write lands (`checkedOff` in `src/core/todos.ts`) and answers with the line rolled forward, which the editor takes as it takes any merge. A todo is checked off by a write when its line was an open todo before and is a done, repeating one after, whatever else on the line the write changed. Which line is which is read from where the write's changes are, so a word typed on the line in the same save changes nothing. A write that puts some lines in the place of a different number of lines doesn't say which became which, and there a line is the one that shares more than half its words with it, pairs kept in order (`following` in `src/core/follow.ts`): a line added above a todo in the save that checks it is still that todo, and two todos that read alike are never crossed. A line written already checked was never open and is left as written, and so is one checked by an undo or a revert, which put a note back and complete nothing. To finish a repeating todo for good, take its `every:` away, or give its rule an end. The editor's checkbox saves at once, so the line comes back open without waiting for a pause in typing.

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
| `todo.history` | `todo_history` | `todo-history` | view |
| `daily.open` | `daily_note` | `daily` | a member who can make notes, and their agent unless it is limited to folders |
| `todos.rebuild` | `rebuild_todos` | `todos-rebuild` | admin |

`todo.list` lists open todos, or done ones too with `includeCompleted`, from the notes the asker can see: open first, then the soonest due with undated ones last, then the most important. It narrows by `folderId` (that folder and every folder under it), by `tag` (a tag of the todo's note, which a tag on the todo's own line is), by `dueFrom` and `dueTo` (both included), by `noDue`, by `importance` (the levels wanted), and by `noteId`. `todo.filters` gives the tags there are to narrow by, and `folder.list` the folders. Both carry `SEEN`: a todo in a note the asker can't see is not listed, not counted, and its tag names are not offered. The folder narrows inside that and never widens it: it is read by `loadFolder`, so a folder the asker can't see, an agent's folder limit included, is "No such folder" as one that was never there is, and a private note inside a folder they can see is still not listed.

`todo.set` rewrites one todo's line as a change to its note by whoever asks. It takes the todo as `todo.list` gave it: `id`, the note's `revision`, `line` and `text`. The line the caller was shown is followed through every change recorded since that revision, by mapping its place through each change, so it is found wherever it has moved to. What a line says never decides which line it is, so another todo that reads the same is never taken for it. When the line itself was changed or deleted since, the call is refused as a conflict and nothing is written. The same call made twice is done once: the second finds the line already reading as asked. Besides `done`, `importance` and `due`, it takes `words`: what the todo says instead, as `todo.list` gives `words` (everything but the checkbox, importance and due date, tags included), on one line. Its importance stays before them and its due date is written after them; nothing else on the line is kept. The Todos page edits a todo's words and adds a tag with it.

One case is not decided by the caller. When one of two identical todos is deleted, the text can't say which, and the record of the change names one of them. The one that is left is then whichever the record kept, for either listing. Nothing else is ever changed in place of a todo the caller pointed at.
Checking a todo off through `todo.set` goes through `completeTodo`, `skip` through `skipTodo`, and `every` sets or clears how it repeats. The editor's checkbox writes `[x]`, and the server completes a repeating todo when that write lands, by the same function.

`todo.history` lists each time a repeating todo was checked off: the day, who did it, and the daily note it was filed on when the asker can see that note. The `completions` table holds one row a completion, written in the batch that made it, with where the todo's line started then. A todo has no id, so its completions are found the way `todo.set` finds a todo: each of those places is followed through every change to the note since, to the line it is now. That keeps a todo's history through being reworded, reordered among its neighbours, and having lines added above it. It loses the history of a line cut out and pasted elsewhere, whose `done:` mark still carries the count. A completion that was undone is left out.

## In the editor

The todos plugin (`src/web/plugins/todos/`) draws five chips on a todo's line: the checkbox, importance, the due date, the repeat, and the last-done mark. Each but the repeat is drawn over the width of its own token (`keepsWidth`), so the line is the same width drawn and as written. A chip is shown as written only while the cursor is on that one token, inside it or at its edge. The cursor anywhere else on the line changes nothing: the box stays a box and the date stays a chip. `test/browser/todos.spec.ts` walks the cursor along every todo's line a letter at a time, at two column widths with a todo that wraps, and checks that one token at most is as written and that nothing else moves. `test/browser/recurrence.spec.ts` measures the repeat and last-done chips.

The Repeat chip says the rule in a few plain words ("every 2 weeks on Mon · 5 left"), which are usually longer than its token, so it takes its own width and stays one piece. When the cursor comes onto its token, the words before it on the line stay where they are, the token starts where the chip did, and the words after it on that row move over by the difference between the two and by nothing else. No other line moves. The one exception is a todo long enough to wrap: the row is then shorter or longer by that difference, and a word may be taken up from the next row or put down onto it, as it would be by typing. The test measures each of these, at two column widths. The token the cursor is on is text, and vim's motions and operators go over it as text. A tag is not a chip: it is the note's text as written.

A click on importance or the due date opens a small popover directly under that chip, the same one the Todos page opens (`plugins/todos/ChipMenu.tsx` in `openPopover`): importance offers every level, and the due date Today, Tomorrow, Next week, Clear and a date field. A pick rewrites the token as the member's edit, undone like typing, and the keyboard goes back to the note. The press doesn't move the cursor, so the line stays drawn. A viewer's chips open nothing. Typing `due:` offers the days of the week ahead.

The Repeat chip opens one flat popover under itself, the same one the Todos page opens from its Repeat chip (`ChipMenu.tsx`), with nothing in it to open further. On the left it says the rule as a sentence ("Every month on the 6th", or "Doesn't repeat yet") and lists six rules that a click sets at once (Daily, Every weekday, Weekly, Every 2 weeks, Monthly, Yearly, the one in force marked "now"), then **Skip this one** with the date it would move to, and **Stop repeating**. Beside them, or under them in a window too narrow for both, the form (`RuleEditor.tsx`) builds any rule the token can write as a sentence: "Every [N] [day, week, month, year]"; for a week, seven days to toggle; for a month, the due date's own day, a list of days, or a list of weekdays; for a year, the due date's own day, a date, or a weekday of a month; whether it repeats from the due date or from completion, which only a rule that names no days can choose; and whether it ends never, on a day, or after so many times. Under them it says the rule as a sentence and the next dates it gives, and when a day past the 28th is chosen, that shorter months use their last day, with a button to use the last day instead. **Edit as text** puts the cursor on the token in the note, shown as written, and **Save** or Enter sets the rule. The form is one `RuleForm` value in `plugins/todos/recurrence.ts`, and `test/core/plugin-recurrence-form.test.ts` checks that every rule the grammar writes opens in it and is said back the same, so there is no rule the editor can't show. Skipping in a note is the member's own edit, by `skipTodo`, the function `todo.set` skips with. The last-done chip says the day and the count, and opens the todo's history from `todo.history`. Checking the box of a repeating todo in the editor writes `[x]` as any typing would. About a second later, when that is saved, the server completes it and the line comes back open with its next due date.

## The Todos page

The list is v1's: one panel, about 660px wide, with a todo to a row. A row has its checkbox, its words, a chip for each thing a todo can have, and its note's name at its right end. Every chip is shown on every row the member can change, set or not: importance (a flag and its `!`s, or "Importance"), the due date (tinted when it is today and when it is past, or "Add date"), the repeat (its rule in a few words after a circling arrow, or "Repeat"), and the tags written at the end of its words, or "Add tag" when there are none. A repeating todo checked off before has a quieter last-done chip after its Repeat chip. A chip of something not set is the same pill, quiet and dashed. A row the member can only view shows what is set and nothing to set. Each chip of importance, the due date and the repeat opens its own popover directly under it, the same one a note's chip opens, and a pick there is saved at once (the repeat's form with its Save). The last-done chip lists the todo's completions, which someone who can only read the note can open too. Away from a note there is no token to put the cursor on, so the Repeat popover's **Edit as text** turns its form into one field for the rule as written, and skipping is `todo.set` with `skip`. Add tag opens a field for a tag with the tags in use under it, narrowed as it is typed into; a pick, or Enter on a whole tag typed, writes `#tag` after the words. A tag's own chip narrows the list to that tag, and pressed again takes that off. A tag inside the sentence stays in it. While a chip's popover is open its row is tinted, so it is plain which todo is being changed. Chips take the keyboard: Enter or Space opens one, Up and Down go through its choices, Enter picks, and Escape goes back to the chip. A date typed into the date field is saved on Enter, since the browser has a whole date after every key.

A press on a todo's words turns them into a one-line field right there, with its chips still on the row after it, as v1's did. Enter or leaving the field saves them with `todo.set` (`words`), Escape puts them back, and a field left empty saves nothing. The tags written after the words stay theirs. With Ctrl or Cmd held, the words open the note instead. The note's name at the row's right opens the note with the cursor on the todo's line. The rest is in one menu, from the row's "…" button, which shows while the row is pointed at or has the keyboard, a right-click on the row, or the menu key or Shift+F10: open the note, and open it to the side.

The inspector is about the notes the listed todos are in (`useInspected`, labelled "Todos"): Info counts them and History is theirs, and both follow the list as it is narrowed.

The list is narrowed by folder, tag, due date and importance, and to completed ones too. The filters are kept in the browser, so the page opens as it was left.

## Undo

Checking a todo off, on the Todos page or with a note's checkbox, shows a toast in the window's bottom right corner, as v1's: a tick, "Task completed", and **Undo**. It doesn't repeat the todo's words: the member has just pressed it. It is in the app's own colours, light or dark, stays ten seconds, and waits while the pointer or the keyboard is on it, with at least two seconds more once they leave. A press on it or Escape sends it away. One is shown at a time, and it is laid over the app, so nothing moves. Opening a todo again shows none. On the Todos page a todo checked off stays in a list of open ones for a moment and a half, ticked and struck through, before it leaves.

Undo opens the todo again as an ordinary change, by the path the tick took. On the Todos page it is `todo.set` with `done: false`, for the line the tick left at the revision it made. In a note it is an edit to the line, which the editor has followed through every change since the tick, so Ctrl+Z takes it back as it does typing. If that editor is gone by then, it is `todo.set`. Either way it is in History as a change of its own. When the line no longer reads as the tick left it, nothing is written and the toast says the todo was changed.

The editor draws a todo on exactly the lines `todosIn` finds in the whole text, which is what the server indexes. So a checkbox nested three deep is a todo in both, though the editor's own parse takes a line indented that far for code.

Checking off a repeating todo did more than check a box: it moved the due date, counted the completion, counted down a rule that ends, and filed a line on the daily note. So its Undo reverts the change that completed it, with `note.revertChanges`, as History reverts a change (`takeBack` in `plugins/todos/completed.ts`). That one revert puts the line back, takes the filed line off the daily note and leaves the completion out of the todo's history, is listed in History as a revert, and is taken by an open editor of the note. The Todos page knows the change from `todo.set`'s answer, and a note's checkbox from the answer to the save it sends, which `app.saveNote` hands back. What was typed before the click is saved first, in a write of its own, so the completion's change holds the check alone. When a later change wrote on the todo's line, nothing is changed and the toast says the todo was changed. A change elsewhere in the note doesn't stop it. The last time of a rule that ends leaves the todo done, and its Undo is the same revert.
