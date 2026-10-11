# Common Ink

A hosted workspace where people and their agents read and edit markdown notes, with every change attributed.

## Content

**Workspace**:
The only container a person signs into. It holds notes, folders, and uploads. A person can belong to more than one: the one made for them when they first sign in, and each one they are invited to. The app shows one at a time. A note's address names no workspace, so the note decides which one is shown.
_Avoid_: Space, vault, project

**Folder**:
A named location in a workspace. A note or upload has exactly one parent folder. An editor can create and rename a folder they can edit. An admin can move or delete any folder. A viewer cannot change folders. A folder can be deleted only when it is empty.
_Avoid_: Directory, space

**Unsorted**:
The default folder. A note created with no other folder selected is placed here.

**Note**:
A markdown file in a workspace, identified by a stable id. Its title is the first `#` heading. The id does not change when the title or folder changes.
_Avoid_: Document, page

**Link**:
A reference from one note to another by the target note's id, written `[[id]]` or `[[id|display text]]`. The visible text follows the target's title unless the link sets its own display text. The note's text holds the id and never the title, so renaming a note changes no other note. It is shown as written only while the cursor is inside it, and is otherwise one thing: the cursor passes it in a step and a deletion takes all of it. A link to a note that doesn't exist, or that the reader can't see, reads as unavailable either way. A link written by title, `[[Title]]`, links nothing until the write that introduces it resolves it to an id. See `docs/adr/0001-links-stored-by-id.md`.
_Avoid_: Wikilink, reference

**Backlink**:
A note whose text links to the open note. The inspector's Backlinks tab lists the ones the member can see.

**Todo**:
A markdown checkbox line in a note, anywhere outside a code block: `- [ ]` open, `- [x]` done. Its due date, recurrence, importance, project, and assignees are written on that line and shown as chips. `docs/todos.md` has how each is written. An `@` person on the line is an assignee. A due date is a calendar date, and whether it is due today uses the viewing member's timezone. Checking the box marks it done. A todo has no id: it is its line, and a change made from a list finds it again by what the line says. Checking off a recurring todo leaves the open line and appends the checked line to the daily note of the member who checked it off. The todos view lists open todos in notes the member can see, leaving out archived and trashed notes, with a control to include completed ones.
_Avoid_: Task, item

**Importance**:
How urgent a todo is. Three raised levels, written `!`, `!!`, or `!!!` immediately after the checkbox, or normal when none is set.

**Due date**:
The day a todo is due, written `due:2026-10-14` on its line. It is a calendar date with no time and no time zone. Overdue is a due date before today, where today is the viewing member's.
_Avoid_: Deadline

**Project**:
A `+Name` on a todo that groups it with todos in other notes. It does not tag the note. A todo can be in several. A name starts with a letter and goes on in letters, digits, `_` and `-`. Matching ignores case.
_Avoid_: Folder, tag

**Daily note**:
A note for one calendar date, belonging to one member. Its heading is that date in that member's timezone. Which member it belongs to is stored outside the note. The folder comes from that member's settings, and the default is Daily. Changing that setting leaves daily notes already created where they are. An agent files a completion on the connecting member's daily note.

**Kanban board**:
A block embed whose body is markdown: each heading is a column and each list item under it is a card. Anything else in the body is kept and not shown.

**Kanban card**:
A list item inside a kanban block in a note. Moving it on the board moves its lines in the note, as a change by the member who moved it.
_Avoid_: Todo

**Data source**:
External structured data a member connects, such as their calendar events or contacts. Other members cannot see its records. Records are not notes. A read-write data source writes edits back to the external system. A read-only data source refuses edits.
_Avoid_: Integration, connector

**Event**:
A calendar entry from a member's data source. It may recur.

**Dashboard**:
A view for one member, not a stored object. It shows that member's events still ahead today, including all-day events; open todos they can see that are due today or earlier; their daily note for today and other notes they can see that were created or edited today; their pinned notes; and a summary of changes they can see since their last visit.
_Avoid_: Home

**Visit**:
The previous time a member opened a workspace.

**Pin**:
A note a member has chosen to show on their own dashboard. It is not written into the note.

**Contact**:
A person from a member's data source, with or without a Common Ink account. On a note they appear gray. The name is stored on the note, so anyone who can read the note sees it. Mentioning or assigning them does not give them access, and does not share the owner's contact list.
_Avoid_: Member, user

**Tag**:
An inline `#tag` in a note, with no space after the `#`, outside code. It tags the whole note, including when it appears on a todo line. It has something in it besides digits, so `#12` is not one. It is not a folder or a heading. Matching ignores case.
_Avoid_: Label, project

**Search**:
A search of the text of notes a member can see, including todo lines, tags, and projects. Archived and trashed notes are excluded unless included.

**Quick open**:
A list of notes and uploads a member can see, matched on title or filename. Archived and trashed items are excluded unless included.

## Editor

**Tab**:
A note open in the editor. A note has at most one tab.

**Preview tab**:
The tab a single click opens, shown in italics. The next note opened with a single click takes its place. Double-clicking the note or its tab, or editing the note, keeps the tab.

**Editor group**:
A column of the editor with its own tabs, one of them showing. Groups sit side by side, and one is focused. The inspector and the URL follow the focused group's showing note.
_Avoid_: Pane, split

**Command**:
A named action with an id that doesn't change, run from the command palette or by a keybinding. Plugins add commands.
_Avoid_: Action

**Keybinding**:
The chords that run a command. In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere, and `ctrl` is the Control key on both. A keybinding is tried before the editor sees the key. A command comes with its default chords, and a member changes them in settings, under the command's id: other chords, or none. A chord the member gives to one command is taken from a command that only had it by default, and is flagged while two commands have it. A member's chord has mod, ctrl, or alt in it unless its key is Escape or an F key.
_Avoid_: Shortcut, hotkey

**Command palette**:
The list of commands, narrowed by typing.

**Vim mode**:
A built-in plugin, off until the member turns it on in settings, that gives every note's editor vim's modes, motions, and operators. Its undo and redo are the app's.

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

**Archive**:
A state of a note or upload, stored outside the file, that keeps it and its links and leaves it out of folder listings, search, the dashboard, and the todos view. It keeps its folder and id. A link still opens it. Archive and unarchive are actions on the open note and require edit. It applies to every member.

**Trash**:
Where a deleted note or upload waits for 30 days from the delete. It remembers its folder, and restore puts it back there. A link opens it and shows that it is in Trash. After 30 days the note or upload and its history are removed, and references show that it is gone. Deleting a note does not delete an upload the note references. Restoring requires edit on the folder it returns to.

## History

**Change**:
One recorded edit, with its author, a diff, and the revision it was based on. A note's current text is derived from its changes.
_Avoid_: Commit, event, op

**Author**:
Who made a change: a member, a named agent, or a plugin.

**Agent**:
An author that is not a person. A member connects it. It acts with that member's role and grants, and no further. Removing the member's access removes the agent's. Disconnecting it stops it at once and keeps its changes in history. Each connection is its own author, so two agents with one name are told apart. An agent's changes can be reverted on their own, which keeps everyone else's.
_Avoid_: Bot

**History**:
The ordered record of every change in a workspace. Undo, redo, revert, and applying a selection move through it. Each is recorded as a new change that names the changes it took back out, so nothing is erased and a change either still stands or was taken back out. The diff of the open note and the workspace history are this same record.
_Avoid_: Log, timeline, versions

**Activity**:
A view of history showing how many changes a member authored on each day, in that member's timezone. An agent's changes belong to the agent.
_Avoid_: Contributions, streak

**Revert**:
Putting a note back to how it was at a revision, as a new change. Applying a selection takes only the chosen changes back out, or puts back ones that were taken out, and keeps the rest.
_Avoid_: Restore, rollback

**Undo**:
Taking back the author's own latest change to a note that still stands. Redo puts back what their latest undo took out, until they edit again. Another author's changes are kept.

**Unseen change**:
A change to a note by anyone but the member, their own agent included, made since the member last looked at that note's history.

**Label**:
A name attached to one revision in history. A revision has at most one, and a note uses a name once.

## Configuration

**Plugin**:
A unit of functionality that adds commands, views, embeds, completions, editor extensions, data sources, or settings through the public plugin API, and reaches the workspace only through the plugin host. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. A member can turn a plugin off for themselves in settings, which takes out everything it added. A third-party plugin must request each capability and give a reason. A plugin cannot change settings.
_Avoid_: Extension, add-on

**Built-in plugin**:
A plugin that comes with Common Ink, such as the sidebar, the folder tree, tabs and splits, and the command palette. It is trusted, and it uses the same plugin API a third-party plugin does. It is on by default unless it says it starts off, as Vim mode does.

**Plugin host**:
The part of the core that turns plugins on and off, hands each one its reach into the workspace, and keeps what each has contributed.

**Contribution**:
One thing a plugin adds: a command, a view, an embed, a completion, or an editor extension. It is there while its plugin is on.

**View**:
Something a plugin draws in a slot of the app: a column, a section of the sidebar, the editor area, an inspector tab, a page, the bottom bar, an overlay, or an icon in a rail.
_Avoid_: Panel

**Page**:
A view with its own address, shown in place of the editor, such as History or Agents.
_Avoid_: Mode, screen

**Embed**:
Content a plugin draws inside a note where the note says `::name{config}`, such as a timer or HTML. It is handed what the note says of it and nothing else: it cannot read other notes, settings, grants, or plugin permissions. Everything it knows is in the note, so it can rewrite its own config and body, which is a change by the member who was using it. A timer or stopwatch keeps when it started there, so it runs the same for everyone reading the note. Network access requires an approved plugin permission. With no plugin for the name, the note shows what is written. An inline embed is shown as written while the cursor is on it. A block embed stays drawn, and its markdown is shown under it only when the member asks to edit it.

**Block embed**:
An embed written on lines of its own: `:::name{config}`, then its body as markdown, then `:::`. A kanban board is one.

**Widget**:
A small live thing a plugin adds, to glance at or press: a timer, a board, a count. It lives in one of three places. In a note it is an embed, inline or block, and what it knows is in the note. In the bottom bar it shows something about the open note or the app. Started from the command palette, it has no place in any note, shows in the bottom bar, and keeps what it knows in this browser. A widget never flashes: it is drawn whole at its size when it first appears, and changed where it stands after.
_Avoid_: Gadget, applet

**Bottom bar**:
The line along the bottom of the app where plugins put widgets, such as the open note's running timers, a quick timer, and the word count. It is there in writing mode too, and is the same height whatever is in it.
_Avoid_: Status bar, footer

**Quick timer**:
A timer started from the command palette that belongs to no note. It shows in the bottom bar and is kept in the member's browser for that workspace: it runs on through a reload there, and nobody else sees it.

**Below the line**:
Where an embed keeps what it shows that is more than a word in the line: a video, a post, an HTML embed's frame. Room is kept for it under the line that writes it, whether or not the cursor is on that line, and what fills the room is drawn once and left alone while the rest of the note is written. The room's size is read from the note alone.

**Media embed**:
An embed that shows something from another site below its line: a YouTube video (`::youtube{address}`) or a social post (`::social{address}`). Nothing is loaded from the other site until the member asks for it. A link embed (`::link{address title}`) is drawn from what the note says alone.

**HTML embed**:
A block embed (`:::html{}`) whose body is HTML, run below the block when the member presses Run, in a frame with an origin of its own. It can't read the app, the member's session, or anything the browser or the server keeps, can't fetch or send anything, and can't send its frame anywhere. The one way out it has is a WebRTC connection, which browsers give no way to refuse.

**Run**:
What a member does to start what a frame holds: a video, a post, an HTML embed. Nothing in a frame runs because a note was opened, and an embed that has changed since it was run asks again.

**Embed menu**:
The list of embeds that opens at the cursor when a member types `/` at the start of a line or after a space. Typing filters it, and picking one writes that embed into the note.

**Completion**:
A list a plugin offers at the cursor while the member types after a trigger. The embed menu is one.

**Editor extension**:
Something a plugin adds to the editor of every note, such as keys or a status line. It applies to notes already open, and not to the settings JSON.
_Avoid_: Extension on its own, which reads as plugin

**Plugin permission**:
The capabilities a plugin has in a workspace. One set per plugin applies to every member. An admin sets them and can lock them. A non-admin's yes becomes a request, and the capability stays off until an admin approves. This is not settings.
_Avoid_: Setting

**Request**:
A non-admin's proposal to give a plugin a capability. An admin approves or denies it.

**Settings**:
JSON that configures one member's behavior in one workspace, such as theme, vim, keybindings, the daily-note folder, whether the share prompt appears, which plugins are on, and plugin options that only change that member's layout. It holds only what the member changed from a default, and follows them to any browser. A change made in one window is kept when another window changes a different key, and the later change wins on the same key. The member changes it as options or as the JSON itself. An admin does not set or lock these, a plugin cannot change them, and an agent can neither read nor change them.
_Avoid_: Preferences, config

**Setting**:
One key in a member's settings, with a type, a default, and a description. The core declares some, each plugin declares its options under its own id, each plugin has one that turns it on and off, and each command has one for its keybinding. A value the setting doesn't allow is flagged and its default used. A key no setting has is flagged and does nothing. Neither is taken out of the member's JSON.
_Avoid_: Option (except for a plugin's own), preference

**Settings schema**:
Every setting there is for a member in a workspace: the core's, those of each installed plugin whether it is on or off, and a keybinding for each command that is on. Settings are checked against it, and the options are drawn from it.

**Upload**:
A binary file in a workspace with one parent folder. The default folder is Unsorted. Grants apply as they do for notes. A note references an upload by its id. An upload can be archived the same way a note can. Deleting an upload uses Trash.
_Avoid_: Asset, attachment
