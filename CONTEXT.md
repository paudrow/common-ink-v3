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
An author that is not a person. A member connects it. It acts with that member's role and grants, and no further. Removing the member's access removes the agent's. Disconnecting it stops it at once and keeps its changes in history. Each connection is its own author, so two agents with one name are told apart. What an agent may do (read only or not, the workspace it reaches, when it expires or that it never does) is set when it is connected and can be edited afterwards by the member who connected it, with the same token. An agent's changes can be reverted on their own, which keeps everyone else's.
_Avoid_: Bot

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
A change to a note by anyone but the member, their own agent included, made since the member last looked at that note's history.

**Label**:
A name attached to one revision in history. A revision has at most one, and a note uses a name once.

## Configuration

**Plugin**:
A unit of functionality that adds commands, views, embeds, editor extensions, data sources, or settings through the public plugin API, and reaches the workspace only through the plugin host. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. A member can turn a plugin off for themselves on the Plugins page, which takes out everything it added, and the choice is kept in their settings. A third-party plugin must request each capability and give a reason. A plugin cannot change settings.
_Avoid_: Extension, add-on

**Built-in plugin**:
A plugin that comes with Common Ink, such as the sidebar, the folder tree, tabs and splits, and the command palette. It is trusted, and it uses the same plugin API a third-party plugin does. It is on by default unless it says it starts off, as Vim mode does.

**Plugin host**:
The part of the core that turns plugins on and off, hands each one its reach into the workspace, and keeps what each has contributed.

**Contribution**:
One thing a plugin adds: a command, a view, an embed, or an editor extension. It is there while its plugin is on.

**View**:
Something a plugin draws in a slot of the app: a column, a section of the sidebar, the editor area, a folder's list of notes, an inspector tab, a page, the bottom bar, or an overlay.
_Avoid_: Panel, widget

**Bottom bar**:
The thin line along the foot of the window where plugins put small things to glance at, such as the word count of the note in front. An item sits at its left or its right end. It is there while any plugin has an item in it, is the same height whatever the items say, and is out of sight in focus.
_Avoid_: Status bar, footer

**Page**:
A view with its own address, such as History or Agents, opened in a tab of the editor as a note is.
_Avoid_: Mode, screen

**Embed**:
Content a plugin draws inside a note where the note says `::name{config}`, such as a stopwatch or HTML. It is handed its config and nothing else: it cannot read other notes, settings, grants, or plugin permissions. Network access requires an approved plugin permission. With no plugin for the name, the note shows what is written.

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
