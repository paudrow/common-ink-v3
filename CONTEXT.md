# Common Ink

A hosted workspace where people and their agents read and edit markdown notes, with every change attributed.

## Content

**Workspace**:
The only container a person signs into. It holds notes, folders, and uploads. A person can belong to more than one.
_Avoid_: Space, vault, project

**Folder**:
A named location in a workspace. A note or upload has exactly one parent folder. An editor can create and rename a folder they can edit. An admin can move or delete any folder. A viewer cannot change folders. A folder can be deleted only when it is empty.
_Avoid_: Directory, space

**Unsorted**:
The default folder. A note created with no folder in front is placed here.

**Folder's list**:
The notes in one folder, shown in the editor area as cards: each a title, a line of details, and the note's first lines. A folder's list is of the folder's own notes, not those of the folders inside it.
_Avoid_: List column, feed

**All notes**:
The list of every note the member can see, whatever folder it is in. It is the first row of the folder tree.

**Card**:
One note in a folder's list. It expands in place to the note drawn to be read, first as an excerpt and then whole. A note is changed in its own tab, never in its card.
_Avoid_: Row

**Note**:
A markdown file in a workspace, identified by a stable id. Its title is the words of its first `#` heading, without their markdown. A note with no such heading is titled by its first line of words, cut to a title's length, and a line that is only a web address is passed over for one that says something. A note with no words has no title and is shown as "Untitled". The id does not change when the title or folder changes, and a note's address names it by id, so an address with an old title still opens it. A note a member makes in the app starts as `# `, the mark of its title, with the cursor after it. Until something is typed it is an untitled note with no words.
_Avoid_: Document, page

**Link**:
A reference from one note to another by the target note's id. The visible text follows the target's title unless the link sets its own display text.

**Todo**:
A markdown checkbox line in a note. Its due date, recurrence, importance, project, and assignees are written on that line and shown as chips. An `@` person on the line is an assignee. A due date is a calendar date, and whether it is due today uses the viewing member's timezone. Checking the box marks it done. Checking off a recurring todo leaves the open line and appends the checked line to the daily note of the member who checked it off. The todos view lists open todos in notes the member can see, leaving out archived and trashed notes, with a control to include completed ones.
_Avoid_: Task, item

**Importance**:
How urgent a todo is. Three raised levels, written `!`, `!!`, or `!!!` immediately after the checkbox, or normal when none is set.

**Project**:
A `+Name` on a todo that groups it with todos in other notes. It does not tag the note. Matching ignores case.
_Avoid_: Folder, tag

**Daily note**:
A note for one calendar date, belonging to one member. Its heading is that date in that member's timezone. Which member it belongs to is stored outside the note. The folder comes from that member's settings, and the default is Daily. Changing that setting leaves daily notes already created where they are. An agent files a completion on the connecting member's daily note.

**Kanban board**:
A block embed whose body is markdown: each heading is a column and each list item under it is a card. Anything else in the body is kept and not shown. A column's colour is written at the end of its heading, `## Doing {.blue}`. The cursor goes into a board from the lines around it, and its cards are moved through and moved with the keyboard.

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
An inline `#tag` in a note, with no space after the `#`. It tags the whole note, including when it appears on a todo line. It is not a folder or a heading. Matching ignores case.
_Avoid_: Label, project

**Search**:
A search of the text of notes a member can see, including todo lines, tags, and projects. Archived and trashed notes are excluded unless included.

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
The tab a single click opens, shown in italics. A group has at most one. The next thing opened with a single click takes its place, whatever either is of. One case keeps the member's place: a note opened from a previewed folder's list makes that list's tab a kept one, and the note is the preview, so a list stays while notes are looked through from it. Double-clicking a folder or a tab, a card's pencil, or editing the note, keeps the tab.

**Editor group**:
A part of the editor with its own tabs, one of them showing. Groups sit side by side or one above another, in any nesting of the two, and one is focused. The URL follows the focused group's showing tab, and the inspector its note. While a folder's list is in front the inspector stays on the note that was in front before it.
_Avoid_: Pane

**Split**:
Groups laid along one direction, left to right or top to bottom, each with a share of the room. A tab is split right or down from its menu or a command, and to any side by dragging it to that edge of a group; dragged onto the middle of a group it joins that group's tabs. The edge between two groups is dragged to change their shares.

**Window buttons**:
The buttons that act on the window and on no one note: the inspector and writing mode. They are at the top right corner of the editor area, at the end of the tab row there, whatever is open.

**Command**:
A named action with an id that doesn't change, run from the command palette or by a keybinding. Plugins add commands.
_Avoid_: Action

**Keybinding**:
The chords that run a command. In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere, and `ctrl` is the Control key on both. A keybinding is tried before the editor sees the key. A command comes with its default chords, and a member changes them in settings, under the command's id: other chords, or none. The Settings page lists every command's keybinding as a keyboard shortcut, and records a new one from its keys as they are pressed. A chord the member gives to one command is taken from a command that only had it by default, and is flagged while two commands have it. A keybinding may be one chord, with or without mod, ctrl, or alt in it, or a sequence of chords pressed one after another, such as `g g`. Keys that would type, which begin with no mod, ctrl, or alt and with neither Escape nor an F key, run a command only where nothing is being typed, unless the command says for itself when it runs. Keys a member gives a command that are the first keys of another's sequence, or go on from another's keys, are flagged too.
_Avoid_: Shortcut, hotkey

**Command palette**:
The list of commands, narrowed by typing.

**Vim mode**:
A built-in plugin, off until the member turns it on on the Plugins page, that gives every note's editor vim's modes, motions, and operators. Its undo and redo are the app's. Its mode bar is at the foot of the note's pane, one for each side of a split. A reading of a note, such as an expanded card, has no vim. By a setting, `j` and `k` move by the rows on screen as `gj` and `gk` do, which is off by default. Outside a note's text its keys move through the rest of the window: `j`, `k`, `gg`, `G`, `ctrl+d` and `ctrl+u` through the rows of any list, `enter` or `l` to open the selected row and `h` to collapse it or go to its parent, `/` to the search box and `escape` back to the list, `ctrl+w` then `h`, `j`, `k` or `l` to the region on that side, and `gt` and `gT` through the tabs. None of them is taken while the member is typing.

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
A person invited into a workspace, with the role admin, editor, or viewer. An admin can do what an editor can, and also manages members, plugins, and grants. A private note is hidden from admins too.

**Grant**:
Access to one note or one folder. A grant that names a non-member gives them view or edit on that note or folder only. Edit includes changing those notes, seeing their history, and creating notes in a granted folder. View includes reading those notes and their history. On a member, a grant only narrows what their role already allows. A grant on a folder covers its notes and nested folders. A grant on a note or child folder inside it wins for that note or subtree. A public link names nobody. A signed-in link is a public link that requires a Common Ink account. An editor can create a grant on a note or folder they can edit.
_Avoid_: Share, permission

**Private note**:
A note hidden from other members, including admins, by a narrowing grant. Sharing it with a mentioned member adds that member as an exception. Sharing it with a non-member who has an account creates a grant for that note only. The prompt that offers this can be turned off in the member's settings. A contact with no account is recorded and is not offered a grant.

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
The ordered record of every change in a workspace. It only goes forward: an undo, a redo, and a revert are each recorded as a new change that names the changes it reverted, so nothing is erased and a change either still stands or was reverted. History is shown as the notes that changed, each with the lines its changes added and removed, then a note's changes, then one change's diff. The diff of the open note and the workspace history are this same record.
_Avoid_: Log, timeline, versions

**Revert**:
A new change that takes the effect of earlier changes out of a note and keeps every other change. Reverting a note to a revision reverts every change after it. A revert is a change like any other, so reverting it has the changes it reverted stand again, and that is the only way to have them again.
_Avoid_: Restore, rollback, put back, reapply, take back out

**Undo**:
Reverting the author's own latest change to a note that still stands. Redo reverts their latest undo, until they edit again. Another author's changes are kept.

**Unseen change**:
A change to a note by anyone but the member, their own agent included, made since the member last looked at that note's history.

**Label**:
A name attached to one revision in history. A revision has at most one, and a note uses a name once.

## Configuration

**Plugin**:
A unit of functionality that adds commands, views, embeds, completions, editor extensions, data sources, or settings through the public plugin API, and reaches the workspace only through the plugin host. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. A member can turn a plugin off for themselves on the Plugins page, which takes out everything it added, and the choice is kept in their settings. A third-party plugin must request each capability and give a reason. A plugin cannot change settings.
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
A view with its own address, such as History or Agents, opened in a tab of the editor as a note is.
_Avoid_: Mode, screen

**Embed**:
Content a plugin draws inside a note where the note says `::name{config}`, such as a timer or HTML. It is handed what the note says of it and nothing else: it cannot read other notes, settings, grants, or plugin permissions. Everything it knows is in the note, so it can rewrite its own config and body, which is a change by the member who was using it. A timer or stopwatch keeps when it started there, so it runs the same for everyone reading the note. Network access requires an approved plugin permission. With no plugin for the name, the note shows what is written. An inline embed is shown as written while the cursor is on it. One whose drawing is doing something, as a running clock is, stays drawn then too, with its text after it, so the cursor never stops or resets it. A block embed's markdown is shown under it only when the member asks to edit it, from its options.

**Embed options**:
What a member adjusts about an embed without reading its config, from the options button at the embed's top corner: a timer's length, a board's column colours. Setting one rewrites the embed in the note, as the member's change. "Edit as markdown" is always among them.

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
Something from another site shown below the line that names it: a YouTube video, or a post on X or Bluesky. It is written as its web address alone on a line, with no syntax of its own, and the line stays the link it is. Room for it and a button are there as soon as the address is, and nothing is loaded from the other site until the member presses the button. An address inside a paragraph is only a link. `::youtube{address}`, `::social{address}` and `::link{address title}` are how notes used to write these: a note that has one still shows it, and nothing offers or writes them.

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
