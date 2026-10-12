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
A note, a folder's list or a page open in the editor. Each has at most one tab.

**Page tab**:
A tab that holds a page, such as History. A page already open is turned to and not opened twice. It is a preview like any other: a note previewed from it takes its place, and Back returns to it.

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
The panel at the right that is about whatever is in front: the tab in front of the focused group. Each of its tabs says what kind of thing it is for: a note, a folder's list, or a page. It opens whatever is in front and stays open as the tab in front changes; where no tab is for that kind of thing it shows one quiet line.

**Focus**:
One tab filling the window: the tab in front of an editor group, a note, a folder's list or a page, with no sidebar, no inspector, neither bar, no other group and no tab row. Every group has a focus button after its last tab, and ⌘. does the same for the focused group. The button stays at the top right as the way out, and ⌘. leaves too. Leaving puts the window back as it was: the same groups at the same sizes, with the sidebar and the inspector as they were. A reload stays in focus on the same tab.
_Avoid_: Writing mode, fullscreen

**Command**:
A named action with an id that doesn't change, run from the command palette or by a keybinding. Plugins add commands.
_Avoid_: Action

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
An author that is not a person. A member connects it. It acts with that member's role and grants, and no further. Removing the member's access removes the agent's.
_Avoid_: Bot

**History**:
The ordered record of every change in a workspace. Undo, redo, revert, and applying a selection move through it. The diff of the open note and the workspace history are this same record.
_Avoid_: Log, timeline, versions

**Activity**:
A view of history showing how many changes a member authored on each day, in that member's timezone. An agent's changes belong to the agent.
_Avoid_: Contributions, streak

**Label**:
A name attached to one revision in history.

## Configuration

**Plugin**:
A unit of functionality that adds commands, views, data sources, or settings through the public plugin API. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. Built-in plugins are trusted and on by default. A third-party plugin must request each capability and give a reason. A plugin cannot change settings.
_Avoid_: Extension, add-on

**Embed**:
Content rendered inside a note, such as HTML. It cannot read other notes, settings, grants, or plugin permissions. Network access requires an approved plugin permission.

**Plugin permission**:
The capabilities a plugin has in a workspace. One set per plugin applies to every member. An admin sets them and can lock them. A non-admin's yes becomes a request, and the capability stays off until an admin approves. This is not settings.
_Avoid_: Setting

**Request**:
A non-admin's proposal to give a plugin a capability. An admin approves or denies it.

**Settings**:
JSON that configures one member's behavior in one workspace, such as theme, vim, keybindings, the daily-note folder, whether the share prompt appears, and plugin options that only change that member's layout. An admin does not set or lock these.
_Avoid_: Preferences, config

**Upload**:
A binary file in a workspace with one parent folder. The default folder is Unsorted. Grants apply as they do for notes. A note references an upload by its id. An upload can be archived the same way a note can. Deleting an upload uses Trash.
_Avoid_: Asset, attachment
