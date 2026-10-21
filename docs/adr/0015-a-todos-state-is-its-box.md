# 15. A todo's state is its box, and backlog is a state, not a place

Status: accepted. The maintainer settled the marks in their journal on 2026-10-20; issue #95 has the reasoning for backlog.

## Context

A todo was open or done, and `done` was a boolean everywhere: in the parsed todo, the index's column, `todo.set`, `list_todos` and the query's `is:open` and `is:done`. The maintainer asked for two more states: abandoned (won't do) and backlog (some day). Issue #95 asked whether backlog is a place todos move to or a state they are in, and how it is written.

## Decision

**The box holds the state, one mark each: `[ ]` open, `[x]` done, `[-]` abandoned, `[>]` backlog.** A state is a fact about the todo, and the box is where the line already says open or done. One character keeps every token where it was, so a state change rewrites one character and nothing else, and an agent reads it at a glance. The alternative, a token such as `~backlog` on the line, would put a second answer to "is it done?" beside the box, and the two could disagree.

**Backlog is a state, not a place.** Moving a todo to a Backlog note would take it out of the note it belongs to and from its links. It stays in its note, dimmed and not struck through, since a strike says it is over. It leaves the Todos page until the query says `is:backlog`.

**One table, one type.** `TodoState` and the table of marks in `src/core/boxes.ts` are what every reader and writer of a box uses: the parser, the index (a `state` column in place of `done`), `todo.set`'s `state`, the query's `is:` words, the help agents are given, and the editor's patterns. No internal code carries a `done` boolean. `todo.set`, `set_todo` and `ink todo` still take `done` at their boundary as the older way to say done or open, because agents already send it.

**A query that names no state lists open todos**, as it did. `includeCompleted` still adds only the done ones. A listing puts open todos first, then the backlog, then done and abandoned ones.

**Only checking off completes.** Abandoning or backlogging a repeating todo writes its box and files nothing; its due date stays and it can't be skipped, so backlog pauses it. Checking it off from either state completes it as from open. A click on the box checks an open todo off and opens any other again.

## Consequences

- Markdown's own task lists know only `[ ]` and `[x]`. Elsewhere `[-]` and `[>]` read as a list item whose words start with the mark, so nothing is lost on export. In the editor, CodeMirror's markdown parser doesn't see them as tasks either, so the todos plugin gives Enter's new item its `[ ]` itself, and the bullets plugin hides a bullet before any box by the table's pattern, not by the parser's Task node.
- Lines written `[-]` or `[>]` before this were not todos. Migration 0059 has every note read in again.
- A new state is a row in the table, a word's meaning in `query.ts`, a name in `plugins/todos/picking.ts`, and how it is drawn. The type makes each of those incomplete until it is added.
