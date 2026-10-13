# Common Ink

A hosted workspace where people and their agents read and edit markdown notes, with every change attributed.

## Content

**Workspace**:
The only container a person signs into. It holds notes, folders, and uploads. A person can belong to more than one: the one made for them when they first sign in, and each one they are invited to. The app shows one at a time. A note's address names no workspace, so the note decides which one is shown.
_Avoid_: Space, vault, project

**Folder**:
A named location in a workspace. A note or upload has exactly one parent folder. An editor can create and rename a folder they can edit. An admin can move or delete any folder. A viewer cannot change folders. A folder can be deleted only when it is empty: no notes, uploads or folders in it.
_Avoid_: Directory, space

**Unsorted**:
The default folder. A note created with no folder in front is placed here.

**Folder's list**:
The notes in one folder, shown in the editor area as cards: each a title, a line of details, and the note's first lines. A folder's list is of the folder's own notes, not those of the folders inside it.
_Avoid_: List column, feed

**Search bar**:
What heads every folder's list, and the Search page, which is the same list of every note: a field with the folder it searches shown in it, the choice of Open, Archived or All, and the order. With nothing typed the list is the folder's notes. With something typed it is what the server's search finds among them, each card with the lines that matched.
_Avoid_: Filter box

**Open, Archived, All**:
Which notes a list or a search is of, by where each is in its life: the live ones, the archived ones alone, or both. Never one in Trash.
_Avoid_: Show archived, include archived (for a list of notes)

**All notes**:
The list of every note the member can see, whatever folder it is in. It is the first row of the folder tree.

**Card**:
One note in a folder's list. It expands in place to the note drawn to be read, first as an excerpt and then whole. A note is changed in its own tab, never in its card.
_Avoid_: Row

**Note**:
A markdown file in a workspace, identified by a stable id. Its title is the words of its first `#` heading, without their markdown. A note with no such heading is titled by its first line of words, cut to a title's length, and a line that is only a web address is passed over for one that says something. A note with no words has no title and is shown as "Untitled". The id does not change when the title or folder changes, and a note's address names it by id, so an address with an old title still opens it. A note a member makes in the app starts as `# `, the mark of its title, with the cursor after it. Until something is typed it is an untitled note with no words.
_Avoid_: Document, page

**Link**:
A reference from one note to another by the target note's id, written `[[id]]` or `[[id|display text]]`. The visible text follows the target's title unless the link sets its own display text. The note's text holds the id and never the title, so renaming a note changes no other note. It is shown as written only while the cursor is inside it, where an arrow key or a motion of vim's takes it as into any text. While it is drawn it is one thing to a deletion and to a selection: a deletion that reaches into it takes all of it. A click on a drawn link opens its note, and ⌘-click opens it in a tab behind. A link to a note that doesn't exist, or that the reader can't see, reads as unavailable either way. A link written by title, `[[Title]]`, links nothing until the write that introduces it resolves it to an id. See `docs/adr/0001-links-stored-by-id.md`.
_Avoid_: Wikilink, reference

**Mention**:
A reference to a person in a note's text, written `@[[id|name]]` for a member of the workspace and `@[[name]]` for anyone else, such as one of the member's contacts. A member's is shown as their name is now, in the theme color, to readers who can list the members; anyone else's is the name as written, in gray, and that is how every mention reads to a guest or on a share link's page. A mention gives nobody access and tells nobody. Like a link it is one thing to the cursor. A mention written by name, `@[[Name]]`, is stored by the member's id when the write that introduces it finds one member with that name. See `docs/adr/0007-mentions-are-ids-for-members-and-names-for-everyone-else.md`.
_Avoid_: Tag, ping

**Assignee**:
A person mentioned on a todo's line. A todo can have several. The todos view narrows by assignee and to the todos assigned to the viewing member.

**Backlink**:
A note whose text links to the open note. The inspector's Backlinks tab lists the ones the member can see.

**Todo**:
A markdown checkbox line in a note, anywhere outside a code block: `- [ ]` open, `- [x]` done. Its due date, recurrence, importance, project, and assignees are written on that line and shown as chips. `docs/todos.md` has how each is written. An `@` person on the line is an assignee. A due date is a calendar date, and whether it is due today uses the viewing member's timezone. Checking the box marks it done. A todo has no id: it is its line, and a change made from a list finds it again by what the line says. Checking off a recurring todo leaves the open line with its next due date and files the checked line on the daily note of the member who checked it off, however the box was checked. Taking the completion back takes the filed line back off the daily note. The todos view lists open todos in notes the member can see, leaving out archived and trashed notes, with a control to include completed ones.
_Avoid_: Task, item

**Importance**:
How urgent a todo is. Three raised levels, written `!`, `!!`, or `!!!` immediately after the checkbox, or normal when none is set.

**Due date**:
The day a todo is due, written `due:2026-10-14` on its line. It is a calendar date with no time and no time zone. Overdue is a due date before today, where today is the viewing member's.
_Avoid_: Deadline

**Recurrence**:
How a todo comes due again, written `every:` and a rule on its line: every N days, weeks, months or years after the due date (`every:2w`); N after it was last done (`every:3d-after-done`); days of the week (`every:mon,thu`); a day of the month from its start or end (`every:3rd-day`, `every:last-day`); the nth weekday of the month (`every:2nd-tue`, `every:last-fri`). `docs/todos.md` has each rule and its next due date.
_Avoid_: Repeat, schedule

**Completion**:
One time a recurring todo was checked off, on a day, by a member or an agent. The todo's line carries the latest day and the count, written `done:2026-10-10x12`, and the record has each one.

**Project**:
A `+Name` on a todo that groups it with todos in other notes. It does not tag the note. A todo can be in several. A name starts with a letter and goes on in letters, digits, `_` and `-`. Matching ignores case.
_Avoid_: Folder, tag

**Daily note**:
A note for one calendar date, belonging to one member. Its heading is that date in that member's timezone, written as a due date is: `# 2026-10-11`. Which member and day it belongs to is stored outside the note, so it stays their daily note when moved or retitled. It is made when first needed, private to its member unless their settings say otherwise, in the folder at the top of the workspace that their settings name, and the default is Daily. Changing that setting leaves daily notes already created where they are. An agent files a completion on the connecting member's daily note. A guest has none.

**Kanban board**:
A block embed whose body is markdown: each heading is a column and each list item under it is a card. Anything else in the body is kept and not shown. A column's colour is written at the end of its heading, `## Doing {.blue}`. The cursor goes into a board's markdown from the lines around it, and the markdown is shown above the board while the cursor is in it. Cards are dragged on the board, and a press on one puts the cursor on its line.

**Kanban card**:
A list item inside a kanban block in a note. Moving it on the board moves its lines in the note, as a change by the member who moved it.
_Avoid_: Todo

**Data source**:
External structured data a person connects, such as their calendar events or contacts. It is that person's and in no workspace: no other member sees that it exists or any of its records, whatever their role, and their own agents read it as them. Records are not notes and are not kept in Common Ink: each is read where it lives when it is shown. A read-write data source writes edits back to the external system. A read-only data source refuses edits. It is connected, not connected, or needs reconnecting, which is when it was connected and the external system stopped answering for the person. See `docs/adr/0006-data-sources-are-one-persons.md`.
_Avoid_: Integration, connector

**Connect**:
What a person does to let Common Ink into a data source: agreeing to it at the external system, in their own browser. They can take it back by disconnecting, and agree again at any time. Signing in with Google asks for the calendar and contacts at the same time.
_Avoid_: Link, sync, authorize

**Record**:
One thing in a data source: an event or a contact.

**Event**:
A calendar entry from a member's data source. It may recur, and each occurrence is then an event of its own. It is either between two instants, shown in the viewing member's timezone, or all-day: on calendar dates, with no time and no zone, the same dates wherever it is read. An event can be changed when its data source is read-write and its calendar lets the member change it.

**Record reference**:
What a note writes to point at an event or a contact without copying it: an embed, `::event{ref label}` or `::contact{ref label}`. The ref says nothing of the record and leads to it only for the member who made the reference, who is shown the record as it is now. The label is plain text in the note that every reader sees, in gray. Anyone else sees the label and nothing more.
_Avoid_: Link (that is to a note), mention (that is `@`)

**Dashboard**:
A view for one member, not a stored object, and what the app opens to when no note is addressed and no tab is open to return to. It shows that member's events still ahead today, including all-day events; open todos they can see that are due today or earlier; their daily note for today and other notes they can see that were created or edited today; their pinned notes; and a summary of changes they can see since their last visit. Today is the member's day: the date where they are, from its midnight to the next. Opening it changes nothing: it makes no daily note. A guest has one too, of what they were granted. See `docs/adr/0009-the-dashboard-is-a-view-and-keeps-two-things.md`.
_Avoid_: Home

**Last visit**:
How far a member has read the changes in a workspace: the moment up to which they marked the dashboard's summary read. It is theirs, kept for them in that workspace, and the same in every browser. It moves only when they press Mark as read, to the moment the summary they were shown was made, so opening the dashboard, reloading it, or having it open twice moves nothing, and a change made since is still there next time. An agent can read it and can't move it. It is not an unseen change, which is about one note in one browser.
_Avoid_: Visit on its own, last seen

**Summary of changes**:
The changes made since a member's last visit by anyone but the member, their own agents included, in notes the member can see now, summed up by note and by author. Until a member first marks it read it covers the last 7 days. It counts the latest hundred changes, and says so when there are more.

**Pin**:
A note a member has chosen to show on their own dashboard. It is theirs alone, kept for them in that workspace and the same in every browser, and is not written into the note: pinning is not a change. A pinned note that is archived or in Trash is left off the dashboard and returns with the note. A pin on a note the member can no longer see is left off too, says nothing of the note, and returns if the note does. A member's agent can pin for them.

**Contact**:
A person from a member's data source, with or without a Common Ink account. On a note they appear gray. The name is stored on the note, so anyone who can read the note sees it. Mentioning or assigning them does not give them access, and does not share the owner's contact list. Contacts are read-only.
_Avoid_: Member, user

**Tag**:
An inline `#tag` in a note, with no space after the `#`, outside code. It tags the whole note, including when it appears on a todo line. It has something in it besides digits, so `#12` is not one. It is not a folder or a heading. Matching ignores case.
_Avoid_: Label, project

**Search**:
A search of the text of notes a member can see, including todo lines, tags, and projects. Every word typed must be in the note, each matching the start of a word, ignoring case and accents. Words in double quotes match as a phrase, `#name` narrows to notes with that tag, and `+name` to notes with a todo in that project. Notes whose title matches come first, then the latest changed. Archived notes are excluded unless included, and trashed notes always.

**Quick open**:
A list of notes and uploads a member can see, matched on title or filename. Archived and trashed items are excluded unless included.

## Editor

**Tab**:
A note, a folder's list or a page open in the editor. Each has at most one tab.

**Page tab**:
A tab that holds a page. It is one tab wherever under the page's address it is, and it keeps the address it is at. A page already open is turned to and not opened twice. It is a preview like any other: a note previewed from it takes its place, and Back returns to it.

**Folder tab**:
A tab that holds a folder's list. It lives at `/folder/<id>`, and All notes at `/folder/all`.

**Preview tab**:
The tab a single click opens, shown in italics. Also called a temporary tab, and a kept tab a permanent one. The window has at most one, in whichever editor group is focused when something is opened: the next thing opened with a single click takes its place, whatever either is of, and a preview in another group closes there. A note opened from a previewed folder's list takes the list's place too, and Back returns to the list. A preview never becomes a kept tab by itself: turning to it, changing tabs or groups, splitting it off from its menu and reloading leave it a preview. Only the member keeps it: double-clicking a folder or a tab, Keep open on the tab's menu, a card's pencil, ⌘-click, Open in a split, dragging it or dropping something in, or editing the note.

**Editor group**:
A part of the editor with its own tabs, one of them showing. Groups sit side by side or one above another, in any nesting of the two, and one is focused. The URL and the inspector follow the focused group's showing tab. The inspector shows the tab the member last picked wherever what is in front has it, and otherwise one it does have, with the pick left as it was. A mode's link or a folder's row dragged from the sidebar onto a group lands as a dragged tab does: the middle adds a kept tab, an edge splits.
_Avoid_: Pane

**Split**:
Groups laid along one direction, left to right or top to bottom, each with a share of the room. A tab is split right or down from its menu or a command, and to any side by dragging it to that edge of a group; dragged onto the middle of a group it joins that group's tabs. The edge between two groups is dragged to change their shares.

**Window buttons**:
The buttons that act on the window and on no one note, whatever is open: the sidebar's and the inspector's, together before the first tab of the top left editor group, where the sidebar meets the editor area.

**Sidebar bar**, **Inspector bar**:
What a closed sidebar or a closed inspector leaves: a narrow bar of icons. The sidebar bar has an icon for each thing the open sidebar lists, in the same order; a mode's icon goes to the mode and Folders opens the sidebar. The inspector bar has an icon for each tab the inspector has for what is in front, and an icon opens the inspector on its tab.

**Inspector**:
The panel at the right that is about whatever is in front: the tab in front of the focused group. Each of its tabs says what kind of thing it is for: a note, a folder's list, or a page. It opens whatever is in front and stays open as the tab in front changes; where no tab is for that kind of thing it shows one quiet line. A note has History, Backlinks and Info; a folder's list has History, the folder's notes that changed as History mode lists them, and Info.

**Focus**:
One tab filling the window: the tab in front of an editor group, a note, a folder's list or a page, with no sidebar, no inspector, neither bar, no other group and no tab row. Every group has a focus button after its last tab, and ⌘. does the same for the focused group. The button stays at the top right as the way out, and ⌘. leaves too. Leaving puts the window back as it was: the same groups at the same sizes, with the sidebar and the inspector as they were. A reload stays in focus on the same tab.
_Avoid_: Writing mode, fullscreen

**Command**:
A named action with an id that doesn't change, run from the command palette or by a keybinding. Plugins add commands.
_Avoid_: Action

**Keybinding**:
The chords that run a command. In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere, and `ctrl` is the Control key on both. A keybinding is tried before the editor sees the key. A command comes with its default chords, and a member changes them in settings, under the command's id: other chords, or none. The Settings page lists every command's keybinding as a keyboard shortcut, and records a new one from its keys as they are pressed. A chord the member gives to one command is taken from a command that only had it by default, and is flagged while two commands have it. A keybinding may be one chord, with or without mod, ctrl, or alt in it, or a sequence of chords pressed one after another, such as `g g`. Keys that would type, which begin with no mod, ctrl, or alt and with neither Escape nor an F key, run a command only where nothing is being typed, unless the command says for itself when it runs. Keys a member gives a command that are the first keys of another's sequence, or go on from another's keys, are flagged too.
_Avoid_: Shortcut, hotkey

**Command palette**:
The list of commands, narrowed by typing.

**Vim mode**:
A built-in plugin, off until the member turns it on on the Plugins page, that gives every note's editor vim's modes, motions, and operators. Its undo and redo are the app's. Its mode bar is at the foot of the note's pane, one for each side of a split, across or down. In focus the pane is the window, so the bar is at the window's foot, and the keys that go from one region to another stay in the one tab that is seen. A reading of a note, such as an expanded card, has no vim. By a setting, `j` and `k` move by the rows on screen as `gj` and `gk` do, which is off by default. Outside a note's text its keys move through the rest of the window: `j`, `k`, `gg`, `G`, `ctrl+d` and `ctrl+u` through the rows of any list, `enter` or `l` to open the selected row, `za` to expand or collapse it, and `h` to collapse it or go to its parent, `/` to the search box and `escape` back to the list, `ctrl+w` then `h`, `j`, `k` or `l` to the region on that side, and `gt` and `gT` through the tabs. None of them is taken while the member is typing.

**Selected row**:
The row of a list that vim's keys are on. It has focus, is marked, and is kept in view.

**Region**:
A part of the window that `ctrl+w` moves between: the sidebar, each editor group, the inspector.

**Drawn** and **as written**:
The two ways a note's editor shows markdown. Drawn is what the markdown means: bold words, a table, a formula, a checkbox. As written is its source, with every mark. A line is shown as written while the cursor is on it, and nothing moves when it changes from one to the other. A table is always drawn, and its cells are typed in where they are.
_Avoid_: Preview, rendered view, source mode

**Chip**:
A token in a note drawn as something that can be clicked, which changes the note only by rewriting that token: a task's checkbox, a formula, a todo's options.

**Outline bullets**:
A built-in plugin that makes a list an outline: a bullet is indented, outdented, and moved among its siblings with what is under it.

**Fold**:
A bullet shown without what is under it. A fold is how one editor in one browser shows the note. It is never in the note's text, and other members don't see it.
_Avoid_: Collapse

**Jumplist**:
The notes a member has been to since Vim mode started in this browser, in order, and which one they are at. `ctrl+o` and `ctrl+i` step back and forward along it, across tabs and editor groups. Going to a note after stepping back drops what was ahead.
_Avoid_: History, which is the record of changes

## Access

**Member**:
A person in a workspace, with the role admin, editor, or viewer. A viewer reads. An editor also changes notes and folders. An admin can do what an editor can, and also manages members, plugins, and grants. A private note is hidden from admins too. Any member can see who the members are, and can leave. A workspace always has an admin, so its only admin can't leave, be removed, or be given another role. A member who is removed or leaves reaches nothing in the workspace from then on, and neither do their agents: the grants that named them go with them. What they wrote stays, under their name.

**Invite**:
An admin's offer of a role in a workspace to an email. Whoever signs in with that email is a member from then on, and from the next time they open Common Ink if they were signed in already. Until then the admin can revoke it. A workspace has one invite for an email, and inviting it again changes the role offered. The email is matched as the person's sign-in gives it, ignoring case and nothing else. The admin is given a link to send, since Common Ink sends no email. The link lets in only the invited email, so it is safe wherever it ends up. An invite does not let anyone sign in who otherwise couldn't.
_Avoid_: Invitation, request

**Grant**:
Access to one note or one folder, given to whoever signs in with an email: view or edit. Edit includes changing those notes, seeing their history, and creating notes in a granted folder. View includes reading those notes and their history. A grant that names someone who isn't a member makes them a guest. On a member, a grant only narrows what their role already allows, which is an admin's to do, and nothing narrows an admin. A grant on a folder covers its notes and nested folders. A grant on a note or child folder inside it wins for that note or subtree, whether it gives more or less. A grant made for an email nobody has signed in with waits for them, and takes effect when they do only if whoever made it can still share the item. A member who can edit a note or folder can share it. A guest can't. An agent can't. An admin sees and can take back every grant in the workspace, other than those on someone's private note.
_Avoid_: Share, permission

**Guest**:
A person who is not a member of a workspace and is named by a grant in it. They see the notes and folders granted to them and nothing else of the workspace: not its other notes or folders, its members, or how many of anything there are. A note they can't see is to them the same as no note. A guest has settings of their own there, and their agents reach what they do. A removed member is not left a guest: their grants go with them. A guest who is invited and becomes a member has the role they were offered, and the grants that made them a guest go, other than one on a private note.
_Avoid_: Non-member, external user, collaborator

**Share link**:
An address that opens a note or a folder for whoever has it, to read and nothing more. A public one opens for anyone. A signed-in one opens for anyone signed in to Common Ink, which a person can be only if this Common Ink lets them sign in at all. It names nobody and makes nobody a guest. A note or folder has at most one. Changing which kind it is keeps its address, and taking it away stops the address at once. The page it opens shows the note's text and nothing else: no author, history, backlinks, or workspace, and nothing in the note is run or loaded from elsewhere.
_Avoid_: Link on its own, which is a link between notes; public link for both kinds

**Private note**:
A note hidden from every other member, admins too. Only the member who made a note can make it private, and they are its owner. The owner lets a member in by a grant on the note itself, for no more than that member's role allows, and can give it a share link. Nothing above it reaches it: not a folder's grant and not a folder's share link. Only the owner shares it or stops it being private, whatever their role. As a note becomes private, every grant and share link someone else put on it is taken away, and the owner is told how many. An owner can't leave the workspace while they have private notes. When an admin removes an owner, their private notes stop being private, since nobody else could reach them, and each records whose it was and when. Privacy is a note's, not a folder's. Sharing it with a mentioned member adds that member as an exception. Sharing it with a non-member who has an account creates a grant for that note only. The prompt that offers this can be turned off in the member's settings. A contact with no account is recorded and is not offered a grant.

**State**:
Where a note or upload is in its life: live, archived, or trashed. It is decided apart from access, and is the same for every member. A note removed from Trash has no state: it is gone.
_Avoid_: Status, deleted flag

**Archive**:
A state of a note or upload, stored outside the file, that keeps it and its links and leaves it out of folder listings, search, the dashboard, and the todos view unless archived notes are included. It keeps its folder and id. A link still opens it, and it is edited as any note. Archive and unarchive are actions on the open note and require edit. It applies to every member.

**Trash**:
Where a deleted note or upload waits for 30 days from the delete. It remembers its folder, and restore puts it back there. A link opens it and shows that it is in Trash. It can be read and not changed, it is in no listing but Trash, and a share link on it opens nothing. Restore returns it as it was, archived if it was, and to Unsorted when its folder was deleted meanwhile. Moving a note to Trash and restoring it need edit on the note, and an agent can do both. Restoring also needs edit on Unsorted when the note's folder was deleted and it returns there. After 30 days the note or upload and its history are removed, and references show that it is gone. Deleting a note does not delete an upload the note references.

**Gone**:
A note that was removed from Trash, after 30 days or sooner by an admin or the member who made it. Nothing of it is kept, so a link to it reads the same as a link to a note that never existed or that the reader can't see. Only a member, signed in, removes a note before its 30 days. An agent can't.
_Avoid_: Deleted, purged

## History

**Change**:
One recorded edit, with its author, a diff, and the revision it was based on. A note's current text is derived from its changes.
_Avoid_: Commit, event, op

**Author**:
Who made a change: a member, a named agent, or a third-party plugin acting for a member.

**Agent**:
An author that is not a person. A member connects it. It acts with that member's role and grants, and no further. Removing the member's access removes the agent's. Disconnecting it stops it at once and keeps its changes in history. Each connection is its own author, so two agents with one name are told apart. What an agent may do (read only or not, the workspace it reaches, the folders it is limited to there, when it expires or that it never does) is set when it is connected and can be edited afterwards by the member who connected it, with the same token. An agent's changes can be reverted on their own, which keeps everyone else's.
_Avoid_: Bot

**Folder limit**:
The folders an agent is limited to in the one workspace it reaches: it reaches those folders, the folders inside them and the notes in those, with what its member may do there and no more. Everything outside is to it as if it weren't there. With no folder limit an agent reaches all notes its member can. The limit is read from where notes and folders are at the time, and one whose folders are all deleted leaves the agent nothing.
_Avoid_: Scope, sandbox

**History**:
The ordered record of every change in a workspace. It only goes forward: an undo, a redo, and a revert are each recorded as a new change that names the changes it reverted, so nothing is erased and a change either still stands or was reverted. History is shown as a list of changes, by time or by note, beside what the selected ones did. The history of the open note, of a folder, and of the workspace are this same record.
_Avoid_: Log, timeline, versions

**Revert**:
A new change that takes the effect of earlier changes out of a note and keeps every other change. Reverting a note to a revision reverts every change after it. A revert is a change like any other, so reverting it has the changes it reverted stand again, and that is the only way to have them again.
_Avoid_: Restore, rollback, put back, reapply, take back out

**Selection**:
The changes picked in History, of one note or of many, to read together and to revert together. Reverting a selection makes one revert in each note it has changes of. A selected change that was already reverted is left as it is, and one selected together with the revert that reverted it stays reverted while that revert goes: the note is as if neither had been made.

**Run**:
A note's selected changes that follow one another, read as one diff: from the note before the first of them to the note after the last. A change left out between two selected ones ends a run, and the next run says how many were skipped.

**Sitting**:
One author's edits to one note that follow one another less than ten minutes apart. History lists a sitting as one row, which is selected and reverted as a whole.

**Revert preview**:
What a revert would do, worked out and not recorded: the changes it would revert and the note's lines it would remove and add. Every revert in the app is shown as one first, an author's changes note by note. Anyone who can read the note's history can ask for one.

**Overlap**:
A later change that still stands and edited a line a revert changes. A preview names each one. A line added or removed whole next to such a line is not an overlap.

**Conflict**:
A place in a note where an overlap edited lines a revert changes. The person reverting settles each one: keep the later edit, on a line otherwise returned to how it was; go back, so the line is as it was before the reverted change and the later edit to it is dropped; or type the lines by hand. What the same later change did to other lines is no conflict and stays. The revert is one change whichever way its conflicts are settled, and what was chosen is part of it: reverting that revert takes it out too.

**Undo**:
Reverting the author's own latest change to a note that still stands. Redo reverts their latest undo, until they edit again. Another author's changes are kept.

**Unseen change**:
A change to a note by anyone but the member, their own agent included, made since the member last looked at that note's history. It is kept in the browser the member looked in, and has nothing to do with their last visit: marking the dashboard's summary read doesn't show them a note's history, and looking at a note's history doesn't take it out of the summary.

**Label**:
A name attached to one revision in history. A revision has at most one, and a note uses a name once.

## Configuration

**Plugin**:
A unit of functionality that adds commands, views, embeds, completions, editor extensions, data sources, or settings through the public plugin API, and reaches the workspace only through the plugin host. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. A member can turn a plugin off for themselves on the Plugins page, which takes out everything it added, and the choice is kept in their settings. A plugin cannot change settings.
_Avoid_: Extension, add-on

**Built-in plugin**:
A plugin that comes with Common Ink, such as the sidebar, the folder tree, tabs and splits, and the command palette. It is trusted, and it uses the same plugin API a third-party plugin does. It is on by default unless it says it starts off, as Vim mode does.

**Plugin host**:
The part of the core that turns plugins on and off, hands each one its reach into the workspace, and keeps what each has contributed.

**Contribution**:
One thing a plugin adds: a command, a view, an embed, a completion, or an editor extension. It is there while its plugin is on.

**View**:
Something a plugin draws in a slot of the app: a column, a section of the sidebar, the editor area, a folder's list of notes, an inspector tab, a page, the bottom bar, or an overlay.
_Avoid_: Panel

**Bottom bar**:
The thin line along the foot of the window where plugins put small things to glance at, such as the word count of the note in front, the open note's running timers and stopwatches, and a quick timer. An item sits at its left or its right end. It is there while any plugin has an item in it, is the same height whatever the items say, and is out of sight in focus.
_Avoid_: Status bar, footer

**Page**:
A view with its own address, such as History or Agents, opened in a tab of the editor as a note is.
_Avoid_: Mode, screen

**Embed**:
Content a plugin draws inside a note where the note says `::name{config}`, such as a timer or HTML. It is handed what the note says of it and nothing else: it cannot read other notes, settings, grants, or plugin permissions. Everything it knows is in the note, so it can rewrite its own config and body, which is a change by the member who was using it. A timer or stopwatch keeps when it started there, so it runs the same for everyone reading the note. Network access requires an approved plugin permission. With no plugin for the name, the note shows what is written. An embed is drawn in a card and stays drawn, the element it was, so the cursor never stops or resets it. While the cursor is on it, it is shown as written too, above its drawing: an inline embed's text in rows above its line, a block embed's markdown lines above its card.

**Embed options**:
What a member adjusts about an embed without reading its config, from the one options button in the embed's card, which opens them beneath the card: a timer's length, a board's column colours. Setting one rewrites the embed in the note, as the member's change. An embed with nothing to adjust has no button.

**Block embed**:
An embed written on lines of its own: `:::name{config}`, then its body as markdown, then `:::`. A kanban board is one.

**Widget**:
A small live thing a plugin adds, to glance at or press: a timer, a board, a count. It lives in one of three places. In a note it is an embed, inline or block, and what it knows is in the note. In the bottom bar it shows something about the open note or the app. Started from the command palette, it has no place in any note, shows in the bottom bar, and keeps what it knows in this browser. A widget never flashes: it is drawn whole at its size when it first appears, and changed where it stands after.
_Avoid_: Gadget, applet

**Quick timer**:
A timer started from the command palette that belongs to no note. It shows in the bottom bar and is kept in the member's browser for that workspace: it runs on through a reload there, and nobody else sees it.

**Below the line**:
Where an embed keeps what it shows that is more than a word in the line: a video, a post, an HTML embed's frame. Room is kept for it under the line that writes it, whether or not the cursor is on that line, and what fills the room is drawn once and left alone while the rest of the note is written. The room's size is read from the note alone.

**Media embed**:
Something from another site shown below the line that names it: a YouTube video, or a post on X or Bluesky. It is written as its web address alone on a line, with no syntax of its own. A video is its picture and its title with a play button, and its player loads when play is pressed. A post is shown at once, in the app's theme. An address inside a paragraph is only a link.

**Address line**:
The line that holds a media embed's address. It is a caption's size and out of sight until the pointer is on it or on the media, or the cursor is on it, and it keeps its room either way.

**HTML embed**:
A block embed (`:::html{}`) whose body is HTML, run below the block when the member presses Run, in a frame with an origin of its own. It can't read the app, the member's session, or anything the browser or the server keeps, can't send its frame anywhere, and can't fetch or send anything unless an admin has allowed HTML embeds the network, and then only to the sites listed. The one other way out it has is a WebRTC connection, which browsers give no way to refuse.

**Run**:
What a member does to start an HTML embed. Its HTML runs nothing because a note was opened, and one that has changed since it was run asks again.

**Embed menu**:
The list of embeds that opens at the cursor when a member types `/` at the start of a line or after a space. Typing filters it, and picking one writes that embed into the note.

**Completion**:
A list a plugin offers at the cursor while the member types after a trigger. The embed menu is one.

**Editor extension**:
Something a plugin adds to the editor of every note, such as keys or a status line. It applies to notes already open, and not to the settings JSON.
_Avoid_: Extension on its own, which reads as plugin

**Third-party plugin**:
A plugin a member wrote and an admin installed in a workspace: a manifest and code, kept in the workspace. It is available once installed, and off for each member until they turn it on. Its code runs in frames shut off from the app, never in the app's page, and reaches the workspace only through the operations its permissions allow. It adds commands, views in the inspector and on pages, embeds drawn below their line, and options. It is known everywhere by the id the workspace gave it when it was installed.

**Manifest**:
What a third-party plugin says of itself, as JSON: its name, the capabilities it asks for with a reason each, and the commands, views, embeds and options it adds. The app lists all of it without running the plugin's code.

**Draft**:
A member's own copy of an installed plugin's source, kept beside their settings. Only its author can read or change it, admins included, and it is gone when they leave the workspace. It can run in the original's place for its author alone, sandboxed, with what the original is allowed and never more. An admin publishes one by installing it, which every approval has to follow again.

**Capability**:
One named thing a plugin can be permitted, which opens a fixed list of operations: read notes, write notes, read todos, read members' names, use the network for listed sites. An operation no capability lists is refused to every plugin.

**Plugin record**:
What a workspace keeps of its plugins: which are installed, what each is permitted, and the requests waiting. Every member reads it and only an admin changes it. It is not settings.

**Plugin permission**:
An admin's decision on one capability of one plugin, for every member of the workspace: allowed or off, and locked or not. A locked permission takes no requests and stays as it is until an admin unlocks it. An approval is of the plugin as it was: new code voids every approval, and a capability declared another way voids its own. HTML embeds have one permission in the same record, the network, with the sites an admin lists. This is not settings.
_Avoid_: Setting

**Request**:
A non-admin's yes to a capability. It allows nothing: the capability stays off until an admin approves, and a denial clears it.

**Settings**:
JSON that configures one member's behavior in one workspace, such as theme, vim, keybindings, the daily-note folder, whether the share prompt appears, which plugins are on, and plugin options that only change that member's layout. It holds only what the member changed from a default, and follows them to any browser. A change made in one window is kept when another window changes a different key, and the later change wins on the same key. The member changes it as options or as the JSON itself. An admin does not set or lock these, a plugin cannot change them, and an agent can neither read nor change them.
_Avoid_: Preferences, config

**Setting**:
One key in a member's settings, with a type, a default, and a description. The core declares some, each plugin declares its options under its own id, each plugin has one that turns it on and off, and each command has one for its keybinding. A value the setting doesn't allow is flagged and its default used. A key no setting has is flagged and does nothing. Neither is taken out of the member's JSON.
_Avoid_: Option (except for a plugin's own), preference

**Settings schema**:
Every setting there is for a member in a workspace: the core's, those of each installed plugin whether it is on or off, and a keybinding for each command that is on. Settings are checked against it, and the options are drawn from it.

**Upload**:
A file in a workspace with one parent folder. The default folder is Unsorted. It is seen as a note is: by its folder, by a grant on it, and private to the member who uploaded it when they make it so. It has no link of its own, and is reached by a link only through the folder it is in. A note refers to an upload by its id, in an embed: `::image{id 640x480}`, `::video{id 640x360}`, `::audio{id}`, or `::file{id}`. The file's name is kept for showing and is in no note and no address. A reader who can't see the upload is shown a placeholder that says nothing of it. An upload is archived and trashed as a note is, and a note that refers to one in Trash says so. Deleting a note leaves the uploads it refers to. A file can be at most 50 MB, and a workspace's uploads 1 GB together. See `docs/adr/0008-uploads-are-items-and-their-bytes-go-through-the-resolver.md`.
_Avoid_: Asset, attachment
