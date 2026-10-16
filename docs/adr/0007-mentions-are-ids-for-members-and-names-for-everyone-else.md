# 7. A mention is `@[[id|name]]` for a member and `@[[name]]` for anyone else

Status: accepted by the owner of #19 on 2026-10-11, without the maintainer. Overrule it here if it is wrong.

## Context

A member types `@` and picks a person: a member of the workspace, or one of their own contacts, who may have no account (issue 1, stories 76 to 79; issue 19). What the note then holds has to do several things at once.

1. A mention of a member follows that member through a rename, can be listed ("assigned to me", an assignee filter), and is drawn in the theme colour with their name now.
2. A mention of a contact holds the contact's name and nothing else: no email, and no id that anyone, the writer included, could look the contact up by. Every other reader sees the name in gray.
3. It reads plainly in the markdown, and an agent writes one through `ink` or MCP without a table of ids.
4. It is never taken for something else with an `@` in it: an email address, a social handle, a URL, `@` in code.
5. It survives a tool that knows nothing of it.
6. A reader who isn't told who is in the workspace, a guest, an agent limited to folders or whoever holds a share link, still reads a name.

| | `@[[id\|name]]` / `@[[name]]` | `@name` and a table beside the note | `::mention{id name}` | `@[name](id)` |
|---|---|---|---|---|
| A member follows a rename | yes, drawn from the id | only by rewriting notes | yes | yes |
| A contact is a name and nothing else | yes | yes | needs a ref per contact, as `::contact` has | yes |
| Where a name ends | at `]]` | unknowable: names have spaces | at `}` | at `]` |
| Collides with addresses and handles | no: nobody writes `@[[` | yes, every `@word` | no | with a markdown link after an `@` |
| Reads plainly | yes | yes | no | yes |
| Fits what is there | the link's shape, as ADR 1 foresaw | new | the embed's shape, drawn in a frame of the plugin's | new |

## Decision

A note writes a mention as `@[[target]]` or `@[[target|name]]`, read by `src/core/mentions.ts`.

- **A member** is `@[[<person id>|<name>]]`. The id is what is matched, indexed and drawn from. The name is the member's name when the mention was written. It is not display text: a reader who can list the members is shown the member's name as it is now, in the theme colour. The written name is for everyone else.
- **Anyone else** is `@[[<name>]]`: a name and nothing more. It is drawn in gray. This is all a note ever holds of a contact. The `@` list writes only the contact's name, and nothing ties the mention back to the contact, for the writer or for anyone.
- **Which it is, is decided by the reader's own list of members**, not by the note. A target that is an id of someone who is a member now is a member. Any other mention is a name: its written name, or its target when it has none. So a member who is removed turns gray with the name they were written with, and turns back if they rejoin, with no note changed. A contact who later joins the workspace stays a name: the note holds nothing to match them by but a name, and matching people by name would be a guess. Whoever wants the member mentions them again.
- **A reader who isn't a member** is told nothing by the server of who is one: `note.read`'s `mentions` and a todo's `assignees` answer `member: false` and the name as written for every mention, and the app, refused `member.list`, draws every mention in gray. A share link's page never asks. The person id in the text says nothing by itself and opens nothing.
- **It stands alone.** The `@` doesn't follow a letter, a digit, `_` or `@`, so no address is one. `@name` without brackets is text and stays text. A mention in code, fenced or inline, is text. `[[...]]` straight after an `@` that starts a mention is not a link to a note (`src/core/links.ts`); after any other `@`, as in `mail@[[id]]`, it still is. A mention in a markdown link's address is text. A name holds no format character (zero-width, or one that turns text right to left): they are dropped as a name is read and written, a name of nothing else is no mention, and a drawn name is isolated from the direction of its line.
- **Mentioning gives nothing.** No grant is made by a mention, of a member or of anyone, by any writer. The app offers, to the owner of a private note who mentions a member who can't see it, to share it with them (`mentions.offerToShare`, on by default). Saying yes is an ordinary `grant.set` and shows in the Share dialog. Only what the member types in their own editor asks: a mention an agent writes asks nothing and grants nothing.

**Writing one without a list.** `note.create` and `note.write` take `mentionNames`. With `resolve`, the default, a mention the write introduces whose target is a member's name, ignoring case, or a member's id, is stored as `@[[id|name]]`. A name several members have is refused, with the ids to choose from (`member.list` gives ids, names and roles, and emails to an admin alone). A name no member has is left as written: it is a mention of someone by name, which is a thing a note may say, so it is not refused the way a link to no note is. As with links, a write introduces a mention when no mention in the text it was based on has the same target as written. A writer who isn't a member is never told who is one, so their mentions are kept as written. The web editor writes with `keep`.

**On a todo** a mention is who the todo is assigned to (`Todo.assignees`), and is not among its words. `todo.set` takes `assign` and `unassign`, a member's id or a name, and resolves a name as a write does.

**The index.** `mentions (note_id, line, who, name)` holds who each line mentions: `who` is the person's id, or the name in lower case, and `name` is as written. It is made in the same statements as the todos index, mended the same way (`notes.indexed` below 4), removed with its note, and only ever read joined to `notes` through `SEEN`. `todo.list` narrows by `assignee` and `assignedToMe` through it, and `todo.filters` lists the assignees there are. It holds every mention, not only those on todos, so "mentions of me" (#23) needs no further table.

**Sharing with a member by naming them.** Only an admin is told a member's email, and `grant.set` took an email. It now also takes `memberId` in place of `email`. The grant is still kept by the email the workspace holds, and `grants.named` records that whoever made it never typed that email, so the grant doesn't tell it to them.

## Consequences

- The raw text carries an id, as a link does. Beside it is a name, which a link has not: a stale name here is still the name of who was meant, and is what a reader with no member list needs.
- A person's name stored in a note stays in the note's history after they leave or are renamed. That is what the writer wrote.
- A mention by name of someone who happens to share a member's name is stored as that member when an agent writes it with `resolve`. An agent that means a contact with a member's name passes `mentionNames: "keep"`.
- A name of twelve lowercase letters and digits reads as an id. It matches nobody and is drawn as written, in gray, which is what a name is drawn as.
- A third-party plugin is refused the member's data sources through `host.perform` (`contact.list` among them), so it can't read the contacts the `@` list reads. `member.list` still goes through, as #14 left it, for #16 to decide.
- Common Ink has no way for a person to change their name yet. When it has one, mentions follow it with no migration.
