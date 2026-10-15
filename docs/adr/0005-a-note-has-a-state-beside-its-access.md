# 5. A note has a state beside its access, and a removed note is no note

Status: accepted by the owner of #21 on 2026-10-11, without the maintainer. Issue 1 left several of these open; overrule them here if they are wrong.

## Context

Until #21 every note was live, and every listing was written as if that would stay so. Archive and Trash make "is this note listed, and can it be changed" a question about each note, the way grants made "who sees it" one (ADR 2). If each operation answered for itself, one would list a trashed note's title or let a write through.

## Decision

**One state, a second dimension.** `notes.state` is `live`, `archived` or `trashed` (`src/core/lifecycle.ts`), with when and by whom, and for a trashed note what restoring returns it to. It is decided apart from access: access says who, state says whether it is listed and whether it can be changed. A removed note has no row and no tombstone.

**The same two ways to ask, each now made to say.** `SEEN(alias, param, covering)` takes the states a query covers (`live`, `kept` for live and archived, `trashed`, `any`), and `loadNote(ctx, id, need, trashed)` takes what the operation does with a note in Trash (`opens`, `refused`, `hidden`). Both are required arguments, so an operation added later does not compile until it has said. `test/core/access-matrix.test.ts` has an archived note and a trashed note among its items: every operation on a note states what it does with one in Trash, every listing states the states it covers, and no listing may say anything of a visible note in a state it does not cover.

**What each state means.**

| | live | archived | trashed |
|---|---|---|---|
| Listings (`note.list`, `todo.list`, `todo.filters`, `tag.list`, `search`, a folder's count) | listed | only with `includeArchived` | never |
| `trash.list` | no | no | yes |
| Read (`note.read`, `note.history`, `todo.history`, `history.diff`, a revert's preview) | yes | yes | yes, and `state` says so |
| Change (write, todo, move, label, revert, undo, redo, archive) | yes | yes | refused: `conflict`, "This note is in Trash". `history.revert`, which answers note by note, skips it with those words |
| A link to it from another note | title | title, state | title, state: the link says it is in Trash |
| `[[Title]]` in a write | resolves | resolves when no live note has the title | never |
| Backlinks from it | listed | listed | not listed |
| `history.list` across the workspace, `history.authors`, `history.revertAuthor` | covered | covered | left out (`history.list` by `noteIds` reads any state) |
| Sharing (`grant.*`, `note.setPrivate`) | yes | yes | yes |
| A share link on it | opens | opens | opens nothing until restored |

**The choices issue 1 left open.**

| Question | Choice | Why |
|---|---|---|
| Can an archived note be edited? | Yes. | Archive hides a note from listings and nothing else. Read-only would force unarchive, fix a typo, archive. |
| Who may trash and restore? | Whoever can edit the note. Restore needs edit on a folder only when the note goes somewhere it was not: its folder was deleted, so it returns to Unsorted. | Trash is reversible, so it follows edit. Trashing never moves a note, so asking for the folder on the way back protected nothing and left a guest given one note able to trash it and never bring it back. `CONTEXT.md` said "restoring requires edit on the folder it returns to", and now says when. |
| May an agent trash and restore? | Yes. | Both are reversible, and trashing is how an agent cleans up after "revert this agent's changes". |
| Can anyone remove a note before its 30 days? | An admin, or the member who made the note, signed in, one note at a time (`note.purge`). Never an agent. | Someone who pasted a secret needs it gone. It is the one change nothing takes back, so it is kept from agents (`NOT_FOR_AGENTS`) and there is no "empty Trash". |
| What does restore return? | The note as it was: its folder, and archived if it was archived. | Restore undoes the delete, not more. |
| A folder that holds only trashed notes: is it empty? | Yes. Deleting it moves them to Unsorted, and restoring one then answers `folderGone`. A folder with archived notes is not empty, and the refusal says so. | A trashed note is not in the folder to anyone listing it, so refusing would be unexplainable. An archived note is kept, so deleting its folder would lose where it lives. |
| What happens to a share link when its note is trashed? | It opens nothing. Restoring the note brings it back, same address. | Trash must stop serving at once. Restore returns the note as it was, and the Share dialog shows the link. The cost: restoring republishes, so the banner on a trashed note should be read. |
| A private note in Trash | Only its owner sees it there. It still counts as theirs for leaving the workspace, and they can stop it being private while it is trashed. | Access is unchanged by state. |
| A daily note in Trash | It is not the day's note. Opening the day, or filing a completion, makes a new one, and the trashed one is then an ordinary note if restored. Restored before that, it is still the day's. An archived daily note stays the day's and is filed on. | The member threw the note away, and completing a todo must not fail or resurrect it. |
| Does an author's revert touch trashed notes? | No. With `trashEmptied`, each note it left empty goes to Trash, checked as still empty in the statement that moves it. | The comment on #21. A note in Trash can't be changed, and one someone wrote in since must not be thrown away. |
| What is left of a removed note? | Nothing. A link to it reads exactly as a link to an id that never existed, for everyone. | "Links show that it is gone" needs no tombstone: a link with no title is gone. Keeping who could once see it would be keeping part of the note. |

**Removal.** `src/core/purge.ts` names every table that keeps anything by a note's id. Each statement carries the condition that the note is still in Trash and was trashed by the cutoff, so a note restored a moment earlier loses nothing. `purgeTrash(db, now)` runs from the Worker's hourly cron (`scheduled` in `src/worker/index.ts`) in batches, and a run that stops is carried on by the next. A batch is all or nothing, so when one fails its notes are removed one at a time: the note that can't be removed is left whole, logged by id, and skipped, and the rest go. `test/core/purge.test.ts` reads the schema for every column that can hold a note's id (it refers to `notes`, or its name says so) and fails for one that is neither in `REMOVALS` nor in `KEPT` with a reason. It also scans every column of every table for a removed note's id and a word of its text.

**Search.** `search` reads an FTS5 table, `note_search`, kept by the same statements as links and todos (`deriving` in `src/core/operations.ts`) and healed by the same `notes.indexed` mark, which goes to 3. Each row carries its workspace, and every match names the workspace first, so the index is walked for one workspace's notes. Healing reads 300 notes a request, so `search` and `tag.list` answer `indexing: true` until a workspace is read in, and the page says results may be missing some and asks again. Typed text never reaches FTS as syntax: `src/core/search.ts` reads words, quoted phrases and `#tag`, and builds the match from quoted strings alone. The match is joined to `notes` and filtered by `SEEN` in the same statement, before `LIMIT`. Results are ordered by whether the title matches and then by last change, both facts of the note itself: FTS5's `bm25` weighs a term by how many notes hold it, hidden ones included, so it is not used. The lines shown are cut in the Worker from the text of the notes already chosen, as text with offsets to mark.

## Consequences

- A new operation over notes says which states it covers or what it does with a trashed note, and has a row in the matrix that says it again.
- A new table keyed by a note's id needs a line in `REMOVALS`, and the purge test fails until it has one. Uploads (#22) follow the same states, and removing a note leaves the uploads it references.
- `note.list` with `updatedSince` reports a note whose state changed since, as well as one whose text did, among the states it covers. A note that was trashed since is in `trash.list`, which an agent that mirrors notes reads as well, as the web app does on each relist.
- How long a search takes depends on how many notes match, hidden ones included. Nothing in the answer does. `indexing`, which `search` and `tag.list` answer while notes are still being read in, is about the asker's own notes: a listing reads in the notes the asker can see and no other, so neither whether a hidden note is waiting nor how many are shows in how often they are told to ask again. A note is read in when someone who sees it first asks. A rebuild by someone who sees every folder covers every note, and one by an agent limited to folders covers its own. Removing a note also merges the index's pages (FTS5 `optimize`), since a deleted row's words otherwise stay in them until a later merge.
- `wrangler d1 export` refuses a database with a virtual table, so it can no longer back this one up. The backup is D1 Time Travel (`wrangler d1 time-travel restore`), which keeps 30 days. For a file export, drop `note_search` first on a copy: `links.rebuild` fills it again.
- Previews have no cron, so nothing leaves a Preview's Trash on its own.
