# 1. A link is stored as `[[id]]`, and its title is read, never written

Status: accepted by the owner of #13 on 2026-10-11, without the maintainer. Issue 1 asked for the maintainer to confirm this; overrule it here if it is wrong.

## Context

A link has to follow its note through renames (issue 1, stories 13 to 15), and a note is plain markdown that agents read and write through the `ink` command and MCP. So the stored form has to satisfy four things at once:

1. It names the target by id, since a title changes and an id doesn't.
2. An agent can read and write it without keeping a table of ids in its head.
3. It survives a tool that knows nothing of it: a diff, a formatter, a copy into another editor and back.
4. Renaming a note changes no other note. A rename that rewrote N linking notes would record N changes by the renamer, in notes they may not be allowed to edit, and would race every editor that has one open.

Three forms were compared.

| | `[[id]]`, `[[id\|display]]` | `[[Title^id]]` | `[Title](/note/slug-id)` |
|---|---|---|---|
| Follows a rename with no rewrite | yes | yes, if drawn from the id | yes, if drawn from the id |
| Text is never wrong | yes: it holds no title | no: the title in the text goes stale at the first rename | no: same, and the slug too |
| Display text told apart from a title | yes, by the `\|` | yes | no: the words in `[...]` are either, and after a rename nothing says which |
| Reads on its own, outside Common Ink | no: an id | yes, until it is stale | yes, and renders as a link anywhere |
| Round trip through other tools | yes: brackets and letters | yes | yes |
| Agent writes one without a lookup | needs the id, or help | needs the id | needs the id and a slug |

Criterion 4 rules out keeping a title in the text fresh, so any title in the text is stale sooner or later. A stale title is worse than none for an agent: it is read as true. The markdown link also can't tell display text from a title, which stories 14 and 15 need told apart.

## Decision

A note stores a link as `[[<note id>]]`, or `[[<note id>|display text]]`. The text never holds the target's title.

The title is supplied wherever the text is read:

- The editor draws a link as its display text, or as the target's title as it is now. It shows a link as written only while the cursor is inside that link.
- `note.read` answers with `links`: each note the text links to by id, with its title now. A target that doesn't exist and one the reader can't see both read as `title: null`, so nothing tells them apart.

And a title is accepted wherever the text is written by something that has no list to pick from:

- `note.create` and `note.write` take `linkTitles`. With `resolve`, the default, a link written by title, `[[Title]]` or `[[Title|display text]]`, is stored by the id of the one note the writer can see with that title, ignoring the case of unaccented letters. The write is refused when no note has the title or several do, with the ids to choose from. With `keep` the text is stored as written and such a link links nothing.
- Only a link the write introduces is looked up. A write introduces a link when no link in the text it was based on, the note at `baseRevision` or nothing for a new note, has the same target as written. So a link the note already had is left exactly as it is, wherever it now stands in the note and however many times, and nobody is refused for a link someone else wrote. A stale write is judged against its own base, not against what others wrote since.
- A new target that reads as an id is looked up both ways in one query: a note with that id is the one meant, otherwise the one note with that title, and with neither the write is refused as any unknown title is.
- The web editor writes with `keep`. What a member types is what is stored, a save is never refused for a title, and a link is by id from the moment it is picked from the `[[` list.

Links in code, fenced or inline, are text and nothing else. An indented line is not taken for code, since a bullet nested three deep is indented as far as a code block is. The editor draws exactly the links the server's parser finds.

Which notes link to which is kept in a `links` table (`source_id`, `target_id`), written in the same batch as every change to a note's text, so it can't differ from the text. `links.rebuild` makes it again from the text. Backlinks, a linked note's title, and a title to link by are all read through one query in the core (`seenAmong` in `src/core/operations.ts`), which is where #15 narrows what a member can see.

## Consequences

- A rename touches one note. No link is ever stale, in any note, at any revision.
- The raw text of a note is not readable on its own: `[[k3j5h8d9f0a1]]` says nothing outside Common Ink. A note copied out as markdown carries ids. An export that writes titles in is possible later, since the id is all it needs.
- An agent that writes `[[Some idea]]` for a note that doesn't exist yet is refused and told why. That is deliberate: a link that silently links nothing is the failure this guards against. It can pass `linkTitles: "keep"`.
- A word of twelve lowercase letters and digits, such as `architecture`, reads as an id. Through `resolve` that is handled: `[[architecture]]` links the note with that id or that title, and is refused when there is neither, so it is never silently stored as a link to nothing. What remains is the web editor, which saves with `keep` and never refuses: `[[architecture]]` typed there by hand, with no such note, is drawn struck through as "Unavailable note". The editor does not leave it as plain text instead, because it cannot tell that from a link to a note the member can't see or that is gone, and those must not show an id as if it were prose in one case and a link in the other. A member who means the word can write it without the brackets.
- The same shape serves a reference to anything with an id: a person for `@` mentions (#19) and an upload (#22) can store an id and be drawn from it, with the same read-side help.
- Links to archived and trashed notes (#21) need no change to stored text. They need `seenAmong` and the editor's chip to say more than "unavailable" for a note that is there but put away.
