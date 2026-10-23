# 19. Everything a note opens is a `[[…]]` link

Status: decided by the maintainer on 2026-10-23 (issue #206). It replaces ADR 7, which made a mention `@[[id|name]]`, and the `::event{ref label}` embed for an event.

## Context

A note pointed at things in four ways. A note was `[[id]]`, a folder `[[folder:id]]` and a day `[[2026-10-23]]` (#189), a person `@[[id|name]]` or `@[[name]]` (ADR 7), and an event `::event{ref label}`, an embed. Each read differently, was opened differently, and was a separate case for every reader of the text: the editor, the index, search, agents. A person's mention also carried a name that was not display text, so a member could not be called something else in one note, and an event's label was a second copy of its title.

## Decision

Anything a member can open, and `gd` to, is a link: `[[target]]`, or `[[target|words]]` to show the words in place of what the target is called. `src/core/links.ts` reads every one.

| Thing | Written as |
| --- | --- |
| Note | `[[id]]` |
| Day | `[[2026-10-23]]`, `[[2026-10-23 14:30]]` |
| Folder | `[[folder:id]]` |
| Event | `[[event:ref]]`, the reference `record.refer` made |
| Person | `[[person:id]]` for a member, `[[person:Name]]` for anyone else |

- **A kind is a prefix.** `folder:`, `event:` and `person:` name what follows. A folder and an event are named by an id alone; a person by an id or a name. A target with one of the prefixes is never a note's title, so a write never looks it up as one.
- **`|` retitles, the same way for every kind.** Without it a link shows what it is to as it is called now: the note's title, the folder's name, the day as "Fri, Oct 23", the event's title, the person's name. With it, it shows the words. Hovering still says what it is.
- **A mention is a link to a person** (`src/core/mentions.ts`). Typing `@` and picking someone writes one: a member by id, a contact by name. A member's name is not in the text: it is shown as it is now, and a mention follows a rename with no note changed. On a todo's line a mention is who it is assigned to.
- **A link by name is stored by id** when the write that introduces it finds exactly one member with that name, as ADR 7 had it: `[[person:Ada Lovelace]]` is stored as `[[person:<id>]]`, keeping any words after the `|`. A name several members have is refused with the ids to choose from. A name no member has is a mention of someone by name. A writer who isn't told who the members are keeps what they wrote.
- **Who is shown.** A reader who can list the members sees a member's name in the theme colour, and an id that is no member's now as "A former member". Anyone else, a guest, a share link's reader, an agent limited to folders, a plugin, is told nothing of who is in the workspace: an id is "Someone" to them, and a name is the name. The words after a `|` are shown to everyone, since they are the note's.
- **An event shows its title to the member whose calendar holds it** and "Event" to everyone else, who is told nothing of it (ADR 6). The note holds no copy of its title.
- **Embeds stay embeds.** An upload, a plugin's block, a contact's `::contact{ref name}` and an email's `::email{ref subject}` are `::name{…}`. They are not opened with `gd`.

The index of mentions (`mentions (note_id, line, who, name)`) is kept as ADR 7 made it: `who` is the person's id, or the name in lower case; `name` is now the name a mention by name is by, and empty for an id.

## The conversion

Notes written before this hold `@[[id|name]]`, `@[[name]]` and `::event{ref label}`. They are converted once, on the server (`note.convertLinks`, `src/core/oldLinks.ts`), and not as each note is opened, as #189 converted bare dates: the index, search, assignment and every agent read the text, so a note nobody opens would otherwise read wrong to all of them until someone did.

- A note that holds one of the old forms is marked when this ships (migration 0067). The app asks the server to convert once a member who may change notes signs in, and the server converts each marked note that member may change, a batch at a time, as an ordinary change of theirs labelled "Links converted" in the note's history. It can be undone like any change. A note the member may not change waits for someone who may.
- `@[[id|name]]` becomes `[[person:id]]` where the name is the member's name now, and `[[person:id|name]]` where it isn't: a name someone chose, as an agent could, or the only name left of someone who is no longer a member, is still what shows. The issue asked for the member's name when the mention was written; nothing keeps a person's past names, and Common Ink has no way to change a name, so their name now is that name. `@[[id]]` becomes `[[person:id]]` and `@[[name]]` becomes `[[person:name]]`.
- `::event{ref label}` becomes `[[event:ref]]`. The label was the event's title when it was referenced.
- Code, fenced or inline, and a link's address are left as written, and what is written inside another, as a mention in an event's label, is the other's. Running it again changes nothing.
- A write whose text holds an old form again, a revert to before the conversion, or a tab or an agent from before this shipped, marks the note, and it is converted again the next time a member comes in. So reverting the conversion shows the old text in history, and does not keep it.
- Each converted note is changed now by that member, so it is listed as changed today, and is among their changes since anyone's last visit.

## Consequences

- A guest, a share link's reader and an agent limited to folders read a member's mention as "Someone", where ADR 7 gave them the name written beside the id. The name is no longer in the note to give.
- A member's name is no longer in a note's text, its history or its snippet. A title or snippet drops a mention by id, as it drops a link to a note by id.
- Another member reading a note with someone's event in it sees "Event", where the embed showed the title as it was when referenced.
- `@[[…]]` written by hand after this is converted as a mention the next time a member comes in, and `::event{ref …}` as a link to an event.
- Search reads a note's text. It finds a person mentioned by name and not one mentioned by id, whose name the text no longer holds; `mentions:` finds them. It no longer finds an event by the title its label held.
- On a member's mention, words after the `|` are shown in the member's colour, so a todo can read "@Bob" while it is assigned to Eve. Hovering says who it is.
- Matching people by name stays a guess that is made only on a write, as ADR 7 said.
