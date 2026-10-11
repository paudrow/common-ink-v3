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
The default folder. A note created with no other folder selected is placed here.

**Note**:
A markdown file in a workspace, identified by a stable id. Its title is the first `#` heading. The id does not change when the title or folder changes.
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

**Kanban card**:
A list item inside a kanban block in a note.
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
The chords that run a command. A command comes with its default chords, and a member changes them in settings, under the command's id: other chords, or none. A chord the member gives to one command is taken from a command that only had it by default, and is flagged while two commands have it. A member's chord has mod or alt in it unless its key is Escape or an F key.
_Avoid_: Shortcut, hotkey

**Command palette**:
The list of commands, narrowed by typing.

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
A unit of functionality that adds commands, views, embeds, data sources, or settings through the public plugin API, and reaches the workspace only through the plugin host. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. A member can turn a plugin off for themselves in settings, which takes out everything it added. A third-party plugin must request each capability and give a reason. A plugin cannot change settings.
_Avoid_: Extension, add-on

**Built-in plugin**:
A plugin that comes with Common Ink, such as the sidebar, the folder tree, tabs and splits, and the command palette. It is trusted and on by default, and it uses the same plugin API a third-party plugin does.

**Plugin host**:
The part of the core that turns plugins on and off, hands each one its reach into the workspace, and keeps what each has contributed.

**Contribution**:
One thing a plugin adds: a command, a view, or an embed. It is there while its plugin is on.

**View**:
Something a plugin draws in a slot of the app: a column, a section of the sidebar, the editor area, an inspector tab, a page, an overlay, or an icon in a rail.
_Avoid_: Panel, widget

**Page**:
A view with its own address, shown in place of the editor, such as History or Agents.
_Avoid_: Mode, screen

**Embed**:
Content a plugin draws inside a note where the note says `::name{config}`, such as a stopwatch or HTML. It is handed its config and nothing else: it cannot read other notes, settings, grants, or plugin permissions. Network access requires an approved plugin permission. With no plugin for the name, the note shows what is written.

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
