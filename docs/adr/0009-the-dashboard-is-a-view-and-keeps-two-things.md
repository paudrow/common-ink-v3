# 9. The dashboard is a view of existing operations, and keeps only pins and the last visit

Status: accepted by the owner of #23 on 2026-10-11, without the maintainer. Issue 1 says what the dashboard shows and that pins are stored outside the note. It leaves open what the app opens to, what a visit is, and who may pin. Overrule any of it here.

## Context

Everything the dashboard shows was already an operation by the time it was built: events, todos, notes, the daily note, history. Each of those already decides who may see what, and what an archived or trashed note is left out of. Two things were new and are the member's own: which notes they pinned, and how far they have read what others changed.

## Decision

**A view, not a stored object.** The dashboard has no operation of its own and no query of its own over notes. It is `event.list` over the member's day, `todo.list` with `dueTo` that day, the app's own listing of notes for those created or edited today, `daily.find`, `pin.list`, and `visit.read` followed by `history.list`. So access and state are decided where they always are, and a guest's dashboard is what they were granted with no rule written for it. Three small things were added to existing operations to make that possible: `daily.find`, which answers the daily note without making it, since opening the dashboard must not write; `history.list`'s `notAuthors`, since "by others" filtered in the browser would leave a page of the member's own changes showing nothing; and the two pieces of state below.

**Today is the member's day.** The browser works out the date where the member is and the instants it runs between, and hands the server days and instants. The server never works out today for someone in the app. An event is still ahead when it hasn't ended. An all-day event is today's when one of its dates is the member's date.

**It is what the app opens to, unless there are tabs to return to.** The page is at `/dashboard` and is the home page (`home` on the `page` view). The home page is shown at `/` when no note is addressed and the editor area has no note to return to (`returnsTo` on the `editor` view), where the editor with nothing in it used to be. A member with tabs open comes back to the tab that was in front, as before, since the stack already promised that switching workspaces and signing in again bring a member's tabs back. One with no tab open, or who closes the last, is on the dashboard, and it is always one click away in the sidebar. With the plugin off, `/` is the editor as before.

**Pins.** A row per person, workspace and note (`pins`), written by `pin.set` and read by `pin.list`. Pinning needs only that the member can see the note, so a viewer and a guest pin. It is not a change to the note and not in history. `pin.list` is a read and nothing else: it answers the pinned notes the member can see now that are live, through `SEEN`, and with `includeArchived` the archived ones too. Sight decides at the listing and nothing is deleted there, so a pin on a note that became private, or that a guest lost their grant on, is left out without a word and is there again when the note is. A read-only token lists pins and changes nothing. An archived note keeps its pin, says so on the pin in its bar, and is off the dashboard until unarchived. A trashed note's pin waits for the note to be restored. A removed note's pin goes with the note (`REMOVALS`), which is the only thing that deletes one besides unpinning. A member's agent may pin and unpin for them: it is theirs to undo, it shows nobody anything, and a read-only token is refused. A removed member's pins are left, as their settings are, and are listed again only for what they can see if they return.

**The last visit.** One time per person and workspace (`visits.read_until`): every change before it is one the member marked read. `visit.read` answers it with the server's `now`. `visit.mark` moves it to the `now` the summary on screen was made from, never back and never past the present.

| Rule considered | Why not |
|---|---|
| Move it when the dashboard is opened | A reload or a second tab would empty the summary before the member read it. |
| Move it when the member leaves the dashboard | Opening the first changed note is leaving, and the rest of the list would be gone on return. |
| Move it to the moment of the press | A change that arrived after the summary was drawn would be marked read unseen. |
| Mark as read, to the summary's own moment | Chosen. Two tabs show the same thing, a later tab can't move it back, and nothing unseen is skipped. |

Until a member first marks it, the summary covers the last 7 days, so a new member isn't shown a workspace's whole history. The summary is the changes by anyone but the member, their own agents included. It reads the latest hundred and no more, so a member back after a month costs one reading of a hundred rows. When there are more than a hundred, every count is shown as the least it can be ("17+"), the card says there are more and links to the History page filtered from the last visit, and the button reads "Mark all as read", since it covers what was not listed.

**When it reads.** A dashboard left open reads nothing while nothing changes. Each section reads once when the app's notes have arrived, at once when its own key changes (the member's date, a mark as read), and again when what it shows may have changed: todos when a note with an open todo changes, the daily note when a note comes into sight or leaves it, the summary when someone other than the member changed a note, pins when a note comes or goes. Those re-readings are held to one in thirty seconds a section, and are made at once when the member comes back to the window. The member's own typing reads nothing.

Only the member moves it. An agent reads it (`last_visit`) and is refused `visit.mark`, and so is a plugin that isn't Common Ink's own, since either could hide from the member what they haven't seen.

**It is not the unseen-change mark.** That mark is per note, per browser, kept in localStorage, and says the member hasn't looked at that note's history. The last visit is per workspace, kept by the server, and is about the summary. Neither moves the other.

## Consequences

- A new section of the dashboard is a new use of an existing operation. If it needs a listing that doesn't exist, that listing is an operation with `SEEN` and a row in `test/core/access-matrix/matrix.ts`, usable by an agent too.
- A pin on a note its member can no longer see is a row nobody reads until the note is removed or seen again. Nothing cleans those up sooner.
- `returnsTo` on the `editor` view is called by the shell while it draws, in the page, so only a plugin that runs in the page can answer it. That holds while every editor view is a built-in. It is not something to offer a plugin that runs isolated (#16).
- The summary's cost is `history.list`'s, which reads every change of each note on the page to say which still stand. That is why it is read at most once in thirty seconds.
- Checking a todo off, and opening an event, are done on the Todos and Calendar pages: the dashboard links to them.
