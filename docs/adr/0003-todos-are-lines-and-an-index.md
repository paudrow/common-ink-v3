# 3. A todo is its line, followed through the note's changes, with an index beside it

Status: accepted by the owner of #18 on 2026-10-11, without the maintainer. Overrule it here if it is wrong.

## Context

A todo is a checkbox line in a note, and its options are tokens on that line. The Todos page lists todos from every note a member can see and changes them without the note open. Two things had to be decided: where the list comes from, and how a change made from a list says which line it means when the note may have been written since.

## Decision

**One parser.** `src/core/todos.ts` reads a line into a todo and rewrites one token of it. The server indexes with it, the editor draws with it, and the Todos page shows what it read. `docs/todos.md` is the grammar.

**An index, kept with the text.** The tables `todos` and `note_tags` are written in the batch that changes a note's text, as `links` is. Listing reads them through `SEEN` and never reads a note's text. They hold nothing the text doesn't say, so they can be made again. A note that has never been indexed is indexed on its next write or the next time its workspace's todos are listed, so nobody runs a command after the migration.

**A rebuild covers every note and says nothing.** `todos.rebuild` and `links.rebuild` are one operation that makes both records again for every note in the workspace, including private notes the admin can't see. It reads their text on the server and writes records that are only read through `SEEN`. Its answer is `{ done }`. This replaces the choice in ADR 2 that a rebuild skips what the admin can't see, which left those notes' records wrong for good.

**A todo has no id.** Nothing is written into the note to name a todo: the note stays plain markdown. A listing gives each todo's note revision, line number and line as written. `todo.set` takes the line that was listed at that revision and maps its place through every change recorded since. The line it arrives at must still read as listed, or as the change asked for would leave it, which is a call made twice. Anything else is a conflict, and nothing is written.

## Considered

- **Reading every note in the browser to list todos.** Simple, and it would put the text of every note a member can see into each page load.
- **An id written into the line, such as `^k3j5`.** It survives any edit. It also puts something nobody typed into every todo, which an agent writing a note has to know to leave alone.
- **Refusing any change from a list that is a revision old.** Simple, and every write to a note by anyone would refuse the next click on the Todos page.
- **Finding the todo by what its line says.** The first version did: the listed line if it read the same, else the one todo that did. Review showed it completing the wrong todo when two read the same: a repeated call took the twin, and so did a line added above. What a line says can't tell two identical lines apart. Its place in the record of changes can.

## Consequences

- A change from an old listing replays the note's record from that revision, as a write based on an old revision does.
- When one of two identical todos is deleted, which one is gone is the record's to say, not the text's. A listing of either then names the one that is left.
- The first listing of todos in a workspace after the migration indexes its notes, 400 a call, so a very large workspace fills in over a few listings.
- Checking a todo's box in the editor is an edit to the note's text like any typing, and does not go through `todo.set`. It writes the line `completeTodo` gives, so the line is the same either way, and what completing does beyond the line (#20) has the note's write to hook as well.
