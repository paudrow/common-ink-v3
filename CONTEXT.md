# Common Ink

A hosted workspace where people and their agents read and edit markdown notes, with every change attributed.

## Content

**Workspace**:
The only container a person signs into. It holds notes, folders, and uploads. A person can belong to more than one: the one made for them when they first sign in, and each one they are invited to. The app shows one at a time. A note's address names no workspace, so the note decides which one is shown.
_Avoid_: Space, vault, project

**Folder**:
A named location in a workspace. A note or upload has exactly one parent folder. An editor can create, rename and move a folder they can edit, into one they can edit or to the top of the workspace, and never into itself or a folder inside it; what is in it goes with it. A guest, or an agent limited to folders, moves only the folders inside one they were given, and into one they were given. An admin can move or delete any folder. A viewer cannot change folders. A folder can be deleted only when it is empty: no notes, uploads or folders in it. No two folders in one parent have names that differ only in case.
_Avoid_: Directory, space

**Folder path**:
A folder's name after the names of the folders it is in, separated by `/`: `Projects/Skills`. It starts at the top of what the one asking can see. An agent finds a folder by its path, ignoring case and then accents.
_Avoid_: Breadcrumb, folder address

**Unsorted**:
The default folder. A note created with no folder in front is placed here.

**Folder's list**:
The notes in one folder, shown in the editor area as cards: each a title, the first part of the note drawn to be read, and a line of details. A folder's list is of the folder's own notes, not those of the folders inside it.
_Avoid_: List column, feed

**Search bar**:
What heads every folder's list, and the Search page, which is the same list of every note: a field that takes a query, with the folder it searches shown in it and Advanced beside it. Which notes, whether they have todos and their order are said in the query (`is:archived`, `has:todo`, `sort:`), on a folder's list as on the Search page, and the bar and Advanced are its only controls. With nothing typed the list is the folder's notes. With a query typed it is what the server's search finds among them, each card with the lines that matched. The Todos page is headed by the same field and Advanced, for todos.
_Avoid_: Filter box

**Query**:
What a search or a list of todos is asked for, as text: words, phrases, filters, and `-`, `NOT`, `OR` and parentheses between them, written as GitHub's search writes them. One language, read by one parser, for notes, for todos and for uploads. `docs/search.md` has all of it.
_Avoid_: Search string, search expression

**Filter**:
A `key:value` in a query that narrows by something other than words: `folder:`, `tag:`, `updated:`, `editor:`, `is:`, `has:`, `due:`, and of uploads `type:`, `uploader:`, `used:`, `size:`, `uploaded:`, `name:`. `has:attachment` is a note that shows an upload: the word is GitHub's, and the thing is an upload. `no:word` is `-has:word`, and `#name` is `tag:name`. `in:` and `sort:` are written the same way and narrow nothing: they say where words are looked for and in what order the answer comes.
_Avoid_: Qualifier, operator (for a filter)

**Builder**:
The panel Advanced opens under a search bar: the bar's query as a row for each condition, to be changed by picking. Each change is written into the bar, and what is typed in the bar is read back into the rows. A query rows can't show stays as typed. It opens on a first row to fill in. Its fields are the filters, with `is:` offered as two: State (open, archived, in Trash, and done, abandoned and backlog for a todo) and Visibility (shared or private). Its **?** opens the help over the page, every form of the language under the same headings with an example to try.
_Avoid_: Filter panel, advanced search form

**Open, Archived, All**:
Which notes a folder's list or its search is of, by where each is in its life: the live ones, the archived ones alone, or both. Never one in Trash. A list says it in its query: open unless it says `is:archived`, or `is:open OR is:archived` for both. An archived note is out of a folder's list and the Todos page until asked for, and found by a search that asks.
_Avoid_: Show archived, include archived (for a list of notes)

**All notes**:
The list of every note the member can see, whatever folder it is in. It is the first row of the folder tree.

**Card**:
One note in a folder's list, drawn one way everywhere a list is: the first part of the note drawn to be read, fading out where it is cut, with no title row above it (the note's own heading is its title), then Edit, Show whole note for a note longer than the cut, and a line of details (the folder where the list spans folders, when it was edited, everyone who edited it). Show whole note grows the card in place. In its top right corner are Archive, which is one click and says "Archived" with Undo (Unarchive, with an icon of its own, on an archived note), and a menu that holds everything else that can be done with the note, each item with an icon. A note is changed in its own tab, never in its card: Edit is the way in.
_Avoid_: Row

**Note**:
A markdown file in a workspace, identified by a stable id. Its title is the words of its first `#` heading, without their markdown. A note with no such heading is titled by its first line of words, cut to a title's length, and a line that is only a web address is passed over for one that says something. A note with no words has no title and is shown as "Untitled". The id does not change when the title or folder changes, and a note's address names it by id, so an address with an old title still opens it. A note a member makes in the app starts empty, with the cursor in it, and its first line of words is its title until it has a `#` heading. A note the member made that has never had anything in it but spaces or a lone `#` is discarded when they leave it, which is when no tab holds it: removed outright, with its history, and not put in Trash. A note that ever had words, or that an agent made, is never discarded.
_Avoid_: Document, page

**Link**:
A reference from one note to another by the target note's id, written `[[id]]` or `[[id|display text]]`. The visible text follows the target's title unless the link sets its own display text. The note's text holds the id and never the title, so renaming a note changes no other note. It is shown as written only while the cursor is inside it, where an arrow key or a motion of vim's takes it as into any text. While it is drawn it is one thing to a deletion and to a selection: a deletion that reaches into it takes all of it. A click on a drawn link opens its note, and ⌘-click opens it in a tab behind. A link to a note that doesn't exist, or that the reader can't see, reads as unavailable either way. A link written by title, `[[Title]]`, links nothing until the write that introduces it resolves it to an id. See `docs/adr/0001-links-stored-by-id.md`.
_Avoid_: Wikilink, reference

**Mention**:
A reference to a person in a note's text, written `@[[id|name]]` for a member of the workspace and `@[[name]]` for anyone else, such as one of the member's contacts. A member's is shown as their name is now, in the theme color, to readers who can list the members; anyone else's is the name as written, in gray, and that is how every mention reads to a guest or on a share link's page. A mention gives nobody access and tells nobody. Like a link it is one thing to the cursor. A mention written by name, `@[[Name]]`, is stored by the member's id when the write that introduces it finds one member with that name. See `docs/adr/0007-mentions-are-ids-for-members-and-names-for-everyone-else.md`.
_Avoid_: Tag, ping

**Assignee**:
A person mentioned on a todo's line. A todo can have several. The todos view narrows by assignee with `assignee:` in its query, `assignee:@me` for the viewing member, and an assignee's chip there changes who it is assigned to.

**Person page**:
What a click on a mention opens, at `/person/<who>`: a member's id or a name, as the mention names them. Each reader is shown only what they may be told: the member card (name, role, and the email where the member list shows it) to whoever can list the members; their own contacts that are this person, matched by name or by the member's email, with everything the contact holds, to that member and their agents alone; the open todos assigned to them and each line that mentions them, newest note first, from the notes the reader can see. Someone who is neither a member nor one of the reader's contacts is the name and nothing more. It searches the notes that mention them with `mentions:` and has one action, "New note about <name>", which makes an ordinary note that mentions them. There is no separate note per person and nothing is typed on the page itself.
_Avoid_: Contact page (a member's card is one too), profile

**Backlink**:
A note whose text links to the note in front. The inspector's Backlinks panel lists the ones the member can see.

**Todo**:
A markdown checkbox line in a note, anywhere outside a code block. Its box is its state: `- [ ]` open, `- [x]` done, `- [-]` abandoned (it won't be done), `- [>]` in the backlog (put off for some day, still in its note). Its due date, repeat, priority, and assignees are written on that line and shown as chips. It has the tags written on its line and the tags of its note. `docs/todos.md` has how each is written. An `@` person on the line is an assignee. A due date is a calendar date, and whether it is due today uses the viewing member's timezone. Checking an open todo's box marks it done, and a click on any other's opens it again. A todo has no id: it is its line, and a change made from a list finds it again by what the line says. Checking off a repeating todo leaves the open line with its next due date and files the checked line on the daily note of the member who checked it off, however the box was checked. Taking the completion back takes the filed line back off the daily note. Abandoning a repeating todo, or putting it in the backlog, files nothing and moves nothing: it waits until it is open again. The todos view lists open todos in notes the member can see, leaving out archived and trashed notes, until its query says otherwise: `is:backlog` lists the backlog.
_Avoid_: Task, item

**Priority**:
How urgent a todo is: High, Medium or Low, written `!!!`, `!!` or `!` immediately after the checkbox, or None when none is written. The app says the words; the note keeps the marks. Operations, tools and the `ink` CLI still call the field `importance`, a number from 0 (None) to 3 (High). A query says `priority:high`; `importance:` reads the same.
_Avoid_: Importance, normal

**Due date**:
The day a todo is due, written `due:2026-10-14` on its line. It is a calendar date with no time and no time zone. Overdue is a due date before today, where today is the viewing member's.
_Avoid_: Deadline

**Date**:
A day written in a note's text on its own, `2026-10-21`, or a day and a time, `2026-10-21 15:00`. It is a calendar day and a clock's time where the member is, with no time zone, the same words wherever it is read. `@` writes one from what is typed (`@today`, `@next friday`, `@tomorrow 3pm`) or from a picked day. The editor draws it as it reads, Wed, Oct 21, and a click on it opens that day's daily note. A date that is part of something longer, such as a due date's `due:2026-10-21`, and a date in a heading are left as written.
_Avoid_: Date chip (the chip is how a date is drawn), timestamp

**Repeat**:
How a todo comes due again, written `every:` and a rule on its line: every N days, weeks, months or years after the due date (`every:2w`); N after it was last done (`every:3d-after-done`); days of the week, every week or every Nth (`every:mon,thu`, `every:2w-mon,thu`); days of the month from its start or end (`every:3rd-day`, `every:1st-day,15th-day`, `every:last-day`); the nth weekdays of the month (`every:2nd-tue`, `every:last-fri`); a date or a weekday of a month every year (`every:mar-1`, `every:1st-mon-mar`). A rule may end, on a day or after so many more times (`-until-2026-12-31`, `-times-5`), and its last time checks the todo off for good. A member can **skip** one occurrence: the due date moves to the next with nothing checked off. `docs/todos.md` has each rule and its next due date. A todo with one is a repeating todo. In code the rule is `every` and its module `recurrence.ts`, which a person never reads.
_Avoid_: Recurrence, recur, schedule

**Completion**:
One time a repeating todo was checked off, on a day, by a member or an agent. The todo's line carries the latest day and the count, written `done:2026-10-10x12`, and the record has each one.

**Daily note**:
A note for one calendar date, belonging to one member. Its heading is that date in that member's timezone, written as a due date is: `# 2026-10-11`. Their timezone is the one of the browser they last used Common Ink in, unless their settings name another, and the server uses it for them and their agents. Which member and day it belongs to is stored outside the note, so it stays their daily note when moved or retitled. It is made when first needed, private to its member unless their settings say otherwise, in the folder their settings pick from the folders they can edit, and the default is Daily, at the top of the workspace. Changing that setting leaves daily notes already created where they are. An agent files a completion on the connecting member's daily note. A guest has none. Yesterday's and tomorrow's daily notes are opened by commands, and Previous day and Next day go from a daily note to the day before or after it. Opening today's or tomorrow's makes it when it isn't there. Opening any other day's only finds it, and when there is none the member is told so and nothing is made.

**Kanban board**:
A block embed whose body is markdown: each heading is a column and each list item under it is a card. Anything else in the body is kept and not shown. A column's colour is written at the end of its heading, `## Doing {.blue}`. The cursor goes into a board's markdown from the lines around it, and the markdown is shown above the board while the cursor is in it. Cards are dragged on the board, and a press on one puts the cursor on its line.

**Kanban card**:
A list item inside a kanban block in a note. Moving it on the board moves its lines in the note, as a change by the member who moved it.
_Avoid_: Todo

**Data source**:
External structured data a person connects, such as their calendar events or contacts. It is that person's and in no workspace: no other member sees that it exists or any of its records, whatever their role, and their own agents read it as them. Records are not notes and are not kept in Common Ink: each is read where it lives when it is shown. A read-write data source writes edits back to the external system. A read-only data source refuses edits. It is connected, not connected, or needs reconnecting, which is when it was connected and the external system stopped answering for the person. See `docs/adr/0006-data-sources-are-one-persons.md`.
_Avoid_: Integration, connector

**Connect**:
What a person does to let Common Ink into a data source: agreeing to it at the external system, in their own browser. They can take it back by disconnecting, and agree again at any time. Signing in with Google asks for the calendar and contacts at the same time, the contacts for reading; changing them is agreed to apart, when the member first asks to edit one.
_Avoid_: Link, sync, authorize

**Record**:
One thing in a data source: an event or a contact.

**Event**:
A calendar entry from a member's data source. It may repeat, and each occurrence is then an event of its own. It is either between two instants, shown in the viewing member's timezone, or all-day: on calendar dates, with no time and no zone, the same dates wherever it is read. An event can be changed when its data source is read-write and its calendar lets the member change it.

**Calendar**:
One of the calendars in a calendar data source, such as a member's work calendar in their Google account. Every event is in one. A member may add events to a calendar, and change its own, when its data source is read-write and the calendar lets them; a calendar they can only read, such as a holidays calendar, refuses both. Which calendars the Calendar page shows is the member's, kept on the server with their settings in the workspace. The page shows them by Day, 3 days, Week, Month or Agenda, from the first day of the week the member chose.

**Default calendar**:
The calendar a member's new events go in when none is named, by them or their agent. It is a remembered setting (`calendar.default`). With none usable, the Calendar uses the one last added to in that browser, and an agent's event goes in the first calendar the member can add to and hasn't hidden. With no calendar connected, the Calendar page asks the member to connect one before anything else.

**Record reference**:
What a note writes to point at an event or a contact without copying it: an embed, `::event{ref label}` or `::contact{ref label}`. The ref says nothing of the record and leads to it only for the member who made the reference, who is shown the record as it is now. The label is plain text in the note that every reader sees, in gray. Anyone else sees the label and nothing more.
The notes about a record are the notes that hold the member's own reference to it and that they can see, each said to be Private, Shared or Workspace by who sees it.
A member writes a reference to an event as they link a note: `[[` and `@` offer their events, nearest first, and picking one writes its reference.
_Avoid_: Link (that is to a note), mention (that is `@`)

**Dashboard**:
A view for one member, not a stored object, and what the app opens to when no note is addressed and no tab is open to return to. It shows that member's events still ahead today, including all-day events; open todos they can see that are due today or earlier; their daily note for today and other notes they can see that were created or edited today; their pinned notes; and a summary of changes they can see since their last visit. Today is the member's day: the date where they are, from its midnight to the next. Opening it changes nothing: it makes no daily note. A guest has one too, of what they were granted. Which panels it shows, in what order and how big, is the member's own, kept with their settings: see Panel. See `docs/adr/0009-the-dashboard-is-a-view-and-keeps-two-things.md`.
_Avoid_: Home

**Panel**:
One part of a member's dashboard, such as today's events or pinned notes, picked from the few there are. A member chooses which their dashboard shows, in what order, and at what size: small, wide, tall or large. That arrangement is theirs, the same in every browser, and changed by no agent.
_Avoid_: Widget (that is in a note), card, section

**Last visit**:
How far a member has read the changes in a workspace: the moment up to which they marked the dashboard's summary read. It is theirs, kept for them in that workspace, and the same in every browser. It moves only when they press Mark as read, to the moment the summary they were shown was made, so opening the dashboard, reloading it, or having it open twice moves nothing, and a change made since is still there next time. An agent can read it and can't move it. It is not an unseen change, which is about one note in one browser.
_Avoid_: Visit on its own, last seen

**Summary of changes**:
The changes made since a member's last visit by anyone but the member, their own agents included, in notes the member can see now, summed up by note and by author. Until a member first marks it read it covers the last 7 days. It counts the latest hundred changes, and says so when there are more.

**Pin**:
A note a member has chosen to show on their own dashboard. It is theirs alone, kept for them in that workspace and the same in every browser, and is not written into the note: pinning is not a change. A pinned note that is archived or in Trash is left off the dashboard and returns with the note. A pin on a note the member can no longer see is left off too, says nothing of the note, and returns if the note does. A member's agent can pin for them.

**Contact**:
A person from a member's data source, with or without a Common Ink account. On a note they appear gray. The name is stored on the note, so anyone who can read the note sees it. Mentioning or assigning them does not give them access, and does not share the owner's contact list. Each email, phone, address and website a contact has carries a **label**: one of Google's own for that kind of line (Home email, Work email, Mobile, Work phone, Home address, Blog, and the rest), one the member wrote, or none. It is shown in plain words beside the line, and written back with it. The member edits a contact from its person page, every field as a contacts app does, and the change is written back where the contact is kept: Google's contacts through the People API, once the member has agreed to changes as well as reading ("Connect again to edit contacts"). A person who isn't one of the member's contacts can be added to them from their page, and a name `@` finds nobody for can be created as one from the list. Only the member changes or adds a contact: not another member, whatever their role, and not an agent.
_Avoid_: Member, user

**Tag**:
An inline `#tag` in a note, with no space after the `#`, outside code. It tags the whole note, including when it appears on a todo line, and every todo in a note counts as tagged with the note's tags. Todos are grouped by tag and by folder, and by nothing else: a `+Name` on a todo is words. It has something in it besides digits, so `#12` is not one. It is not a folder or a heading. Matching ignores case.
_Avoid_: Label, project

**Search**:
A search of the text of notes a member can see, including todo lines, and tags. Every word typed must be in the note, each matching the start of a word, ignoring case and accents. Words in double quotes match as a phrase, and `#name` narrows to notes with that tag. Notes whose title matches come first, then the latest changed. Archived notes are excluded unless included, and trashed notes always.

**Quick open**:
A list of notes, uploads and calendar events a member can see, matched on title, filename, or an event's title and day. Archived and trashed items are excluded unless included. With nothing typed it lists the open tabs, each with its pane, then the places visited lately.

## Editor

**Tab**:
A note, a folder's list or a page open in the editor. Each has at most one tab.

**Page tab**:
A tab that holds a page. It is one tab wherever under the page's address it is, and it keeps the address it is at. A page already open is turned to and not opened twice. It is a preview like any other: a note previewed from it takes its place, and Back returns to it.

**Folder tab**:
A tab that holds a folder's list. It lives at `/folder/<id>`, and All notes at `/folder/all`.

**Preview tab**:
The tab a single click opens, shown in italics. Also called a temporary tab, and a kept tab a permanent one. The window has at most one, and it is where the next thing opened with a single click goes, whatever either is of and whichever editor group is focused: so no group is closed by opening something in another. With none, it opens in the focused group. A note opened from a previewed folder's list takes the list's place too, and Back returns to the list. A preview never becomes a kept tab by itself: turning to it, changing tabs or groups, splitting it off from its menu and reloading leave it a preview. Only the member keeps it: double-clicking a folder or a tab, Keep open on the tab's menu, ⌘-click, Open in a split, dragging it or dropping something in, or editing the note.

**Editor group**:
A part of the editor with its own tabs, one of them showing. Groups sit side by side or one above another, in any nesting of the two, and one is focused. The URL and the inspector follow the focused group's showing tab. A mode's link or a folder's row dragged from the sidebar onto a group lands as a dragged tab does: the middle adds a kept tab, an edge splits.
_Avoid_: Pane

**Split**:
Groups laid along one direction, left to right or top to bottom, each with a share of the room. A tab is split right or down from its menu or a command, and to any side by dragging it to that edge of a group; dragged onto the middle of a group it joins that group's tabs. The edge between two groups is dragged to change their shares.

**Edge**:
The line where the sidebar or the inspector meets the editor area, with a short grip half way down it. Dragged, it resizes its side. Dragged in well past the side's least width, the side folds: the sidebar to its bar, and the inspector's pinned panel away, leaving its bar. The folded edge dragged out, or pressed, opens it again, as wide as it was, and it follows the pointer only once the pointer is out that far; the inspector's panel opened this way is pinned. There are no buttons for the sidebar, and the commands Toggle sidebar (⌘\) and Toggle inspector do the same.

**Sidebar bar**:
What a closed sidebar leaves: a narrow bar of icons, one for each thing the open sidebar lists, in the same order. A mode's icon goes to the mode and Folders opens the folder picker.

**Inspector bar**:
The narrow bar of icons at the right of the window, one for each of the inspector's panels. It is always there, the same whatever is in front: no icon comes or goes with what is open, and it never closes by itself. An icon shows its panel, and the same icon again closes it.

**Folder picker**:
The sidebar's folder tree shown over the page beside the sidebar bar, from the bar's Folders icon, while the sidebar stays closed. Nothing under it moves. It goes when a folder is opened from it, on Escape, and on a press outside it.

**Inspector**:
The inspector bar and the panel it shows, which is about whatever is in front: the tab in front of the focused group. The panels are History, Backlinks and Info. A panel opens over the page and goes when the member presses elsewhere or presses Escape; pinned, by the one control in its header, it is beside the page and stays. Which panel, whether it shows and whether it is pinned are as the member last had them. A panel with nothing for what is in front says "Nothing to show for this view". The History panel is History itself, narrowed to what is in front and with what is selected under the list: a note's changes by time, a folder's or a page's notes by time or by note.
_Avoid_: Right sidebar, inspector tab

**About**:
What the inspector's panels are told is in front: a note, a folder's list, or the notes a page says it is showing. A page says so itself, as the History page does with the notes whose changes are ticked; a page that says nothing is nothing to be about.

**Focus**:
One tab filling the window: the tab in front of an editor group, a note, a folder's list or a page, with no sidebar, no inspector, neither bar, no other group and no tab row. A note in focus has no bar above its text either: a quiet line at its foot shows only what is live, its vim mode, a running timer and whether it is saved. Every group has a focus button after its last tab, and ⌘. does the same for the focused group. The button stays at the top right as the way out, and ⌘. leaves too. Leaving puts the window back as it was: the same groups at the same sizes, with the sidebar and the inspector as they were. A reload stays in focus on the same tab.
_Avoid_: Writing mode, fullscreen

**Command**:
A named action with an id that doesn't change, run from the command palette or by a keybinding. Plugins add commands.
_Avoid_: Action

**Keybinding**:
The chords that run a command. In a chord, `mod` is ⌘ on a Mac and Ctrl elsewhere, and `ctrl` is the Control key on both. A keybinding is tried before the editor sees the key. A command comes with its default chords, and a member changes them in settings, under the command's id: other chords, or none. The Settings page lists every command's keybinding as a keyboard shortcut, and records a new one from its keys as they are pressed. A chord the member gives to one command is taken from a command that only had it by default, and is flagged while two commands have it. A keybinding may be one chord, with or without mod, ctrl, or alt in it, or a sequence of chords pressed one after another, such as `g g`. Keys that would type, which begin with no mod, ctrl, or alt and with neither Escape nor an F key, run a command only where nothing is being typed, unless the command says for itself when it runs. Keys a member gives a command that are the first keys of another's sequence, or go on from another's keys, are flagged too.
_Avoid_: Shortcut, hotkey

**Place**:
A note (with where its cursor was), a folder's list, or a page at its own path, as the member was at it. Settings is not one.
_Avoid_: page (for a place that is a note)

**Back and forward**:
Going through the places the member has been to, and the jumps within a note, in the order they were made: Go back and Go forward, and vim's ctrl+o and ctrl+i. Not the History of a note's changes, and not the browser's Back.
_Avoid_: history (that is a note's changes), jump list (for the whole)

**Command palette**:
The list of commands, narrowed by typing.

**Keyboard shortcuts sheet**:
Every command that has keys now, under Navigation, Notes, Editor and then a plugin's own heading such as Vim, opened over the page by **?** wherever nothing is being typed, or from the command palette. It shows the member's keys where they changed them.
_Avoid_: Cheat sheet, help menu (for the sheet)

**Help overlay**:
Help shown over the page in a dialog with a title and a close button, the one look for help in the app: the query syntax and the keyboard shortcuts sheet are drawn in it.

**Vim mode**:
A built-in plugin, off until the member turns it on on the Plugins page, that gives every note's editor vim's modes, motions, and operators. Its undo and redo are the app's. Its mode bar is at the foot of the note's pane, one for each side of a split, across or down, and the mode in it begins where the note's text does, wherever the column is. `zz`, `zt` and `zb` put the cursor's line in the middle, at the top or at the foot of the pane, and `z.`, `z<CR>` and `z-` do the same with the cursor on the line's first letter; there is room under a note's last line for `zz` to bring a line near the end to the middle. In focus the pane is the window, so the bar is at the window's foot, and the keys that go from one region to another stay in the one tab that is seen. A reading of a note, such as a card, has no vim. By a setting, `j` and `k` move by the rows on screen as `gj` and `gk` do, which is off by default. In visual line mode they move by whole lines still, since it selects whole lines. Outside a note's text its keys move through the rest of the window: `j`, `k`, `gg`, `G`, `ctrl+d` and `ctrl+u` through the rows of any list, `enter` or `l` to open the selected row, `za` to expand or collapse it (on a card, to show the whole note or cut it back), and `h` to collapse it or go to its parent, `/` to the search box and `escape` back to the list, `ctrl+w` then `h`, `j`, `k` or `l` to the region on that side, and `gt` and `gT` through the tabs. None of them is taken while the member is typing.

**Selected row**:
The row of a list that vim's keys are on. It has focus, is marked, and is kept in view.

**Region**:
A part of the window that `ctrl+w` moves between: the sidebar, each editor group, the inspector.

**Drawn** and **as written**:
The two ways a note's editor shows markdown. Drawn is what the markdown means: bold words, a table, a formula, a checkbox. As written is its source, with every mark. A construct is shown as written only while the cursor is on that construct itself, inside it or at its edge: a bold word, a link, inline code, a formula, a task's box, a list mark, each alone, so the rest of its line stays drawn. A heading's mark and a code block's fence go by their line. Nothing else moves when one changes from drawn to written. A table is always drawn, and its cells are typed in where they are; its own lines are shown as written above it while the cursor is in them, reached with the keys.
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
A person in a workspace, with the role admin, editor, or viewer. A viewer reads. An editor also changes notes and folders. An admin can do what an editor can, and also manages members, plugins, and grants. A private note is hidden from admins too. Any member can see who the members are, and can leave. A workspace always has an admin, so its only admin can't leave, be removed, or be given another role. A member who is removed or leaves reaches nothing in the workspace from then on, and neither do their agents: the grants that named them go with them. What they wrote stays, under their name, until they delete their account: then it is a former member's.

**Session**:
One browser signed in as a person, after Google says who they are. It lasts 30 days, or until they sign out there. **Signing out everywhere** ends every session the person has at once, in every browser and every workspace, the one they did it from too. A person does it from Settings, under Account, and an admin does it to a member from Members, who stays a member and can sign in again. An admin can do it to a person once a day, so no one workspace's admin keeps them signed out of the others. Agents have tokens, not sessions, so it disconnects them separately: unless the person unticks it, it disconnects all of their own agents, or, done by an admin, the member's agents that reach that workspace. An admin can disconnect a member's agents only this way. An agent can't sign anyone out.
_Avoid_: Login, device

**Account deletion**:
A person deleting their own account, from Settings, under Account, after typing their email. It can't be undone, and an agent can't do it. It is refused while they are the only admin of a workspace that has other members: they make someone else admin on Members, or delete the workspace, first. A workspace they are the only member of is deleted with the account, and they are told which before they confirm. Everything that was theirs alone goes: their private notes and uploads with their files, their settings, pins and last visits, their invites and the grants that named them, their plugin drafts, requests and turned-on full trust, their data sources, which are ended at Google too, their clipper, and every way their agents and OAuth apps had in. Every session of theirs stops at once. In a workspace they shared, what they wrote stays, under a **former member**, and the grants and share links they made stay, so nobody loses what they were given. A mention of them in someone else's note stays as written and reads as a name. Backups keep it for up to 30 days more. Signing in again later is a new person, with a workspace of their own.
_Avoid_: Closing an account, deactivating

**Former member**:
Who stands in, in a workspace's history, for a person who deleted their account: "A former member", and their agents "A former member's agent". Each deleted account has a former member of its own, so two people's work stays apart, and nothing about it says who they were. Nobody can sign in as one.
_Avoid_: Deleted user, ghost

**Workspace deletion**:
An admin deleting a workspace, from Settings, after typing its name. It can't be undone, and an agent can't do it. At once nobody reaches it: its members, invites, grants and share links go, and so do agents limited to it. Its notes, history, folders, uploads and their files, and plugins are then erased, as much as fits at once and the rest within the hour. Backups keep it for up to 30 days more. Its members' other workspaces and accounts are left as they were, and a member left in no workspace gets one of their own the next time they come, as on first sign-in.
_Avoid_: Archiving a workspace, closing a workspace

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

**Breadcrumbs**:
The line above an open note's text: the workspace, each folder down to the note's own, and the note, as VS Code's. A crumb that is a folder opens a list of that folder's subfolders and notes, searchable and moved through by the keyboard, with Go to folder at its top. It lists only what the member can already see. A note shared with a guest, which is in no folder, is under Shared with me. In focus they are hidden.

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

**Connection by OAuth**:
An agent that an app connected by sending the member to sign in, instead of a member pasting a token into it. It is how a hosted chat app such as claude.ai connects, since it can't send a pasted token. The member chooses on the consent page what it may do, as on the Agents page, and it is an agent in everything after that: its changes, its limits, editing it and disconnecting it. It has no token of its own to show. The app holds an access token for an hour and a refresh token for 30 days, neither past the agent's own end. The Agents page lists it under the app's name, marked as connected by OAuth. Connecting the same app again replaces the earlier connection. See `docs/adr/0012-oauth-connections-are-agents.md`.
_Avoid_: Integration, OAuth grant, authorization

**App**:
A program that registered itself with Common Ink to connect by OAuth, with a name and the addresses it may be sent back to. Anyone can register one, so its name is its own and shown as unchecked, and one that never connects anyone is forgotten. An app is not an agent: each member it connects for is a connection by OAuth of their own.
_Avoid_: Client, integration

**Folder limit**:
The folders an agent is limited to in the one workspace it reaches: it reaches those folders, the folders inside them and the notes in those, with what its member may do there and no more. Everything outside is to it as if it weren't there. With no folder limit an agent reaches all notes its member can. The limit is read from where notes and folders are at the time, and one whose folders are all deleted leaves the agent nothing.
_Avoid_: Scope, sandbox

**History**:
The ordered record of every change in a workspace. It only goes forward: an undo, a redo, and a revert are each recorded as a new change that names the changes it reverted, so nothing is erased and a change either still stands or was reverted. History is shown as a list of changes under the day each was made, by time or by note, beside what the selected ones did. A day's tick selects the whole day. The history of the open note, of a folder, and of the workspace are this same record.
_Avoid_: Log, timeline, versions

**Revert**:
A new change that takes the effect of earlier changes out of a note and keeps every other change. Reverting a note to a revision reverts every change after it. A revert is a change like any other, so reverting it has the changes it reverted stand again, and that is the only way to have them again.
_Avoid_: Restore, rollback, put back, reapply, take back out

**Selection**:
The changes picked in History, of one note or of many, to read together and to revert together. Nothing is picked but by the member, and each place History is shown keeps its own selection while the app is open. Where a selection has a **conflict** is marked on its diff before any revert is asked for. Reverting a selection makes one revert in each note it has changes of. A selected change that was already reverted is left as it is, and one selected together with the revert that reverted it stays reverted while that revert goes: the note is as if neither had been made.

**Run**:
A note's selected changes that follow one another, read as one diff: from the note before the first of them to the note after the last. A change left out between two selected ones ends a run, and the next run says how many were skipped.

**Sitting**:
One author's edits to one note that follow one another less than ten minutes apart. History lists a sitting as one row, which is selected and reverted as a whole.

**Revert preview**:
What a revert would do, worked out and not recorded: the changes it would revert and the note's lines it would remove and add. Every revert in the app is shown as one first, an author's changes note by note. Anyone who can read the note's history can ask for one.

**Overlap**:
A later change that still stands and edited a line a revert changes. A preview names each one. A line added or removed whole next to such a line is not an overlap.

**Conflict**:
A place in a note where an overlap edited lines a revert changes. The person reverting settles each one: keep the later edit, on a line otherwise returned to how it was, or left whole as it is when the later edit was to the same words or removed the line; go back, so the line is as it was before the reverted change and the later edit to it is dropped; or type the lines by hand. What the same later change did to other lines is no conflict and stays. The revert is one change whichever way its conflicts are settled, and what was chosen is part of it: reverting that revert takes it out too.

**Undo**:
Reverting the author's own latest change to a note that still stands. Redo reverts their latest undo, until they edit again. Another author's changes are kept.

**Unseen change**:
A change to a note by anyone but the member, their own agent included, made since the member last looked at that note's history. It is kept in the browser the member looked in, and has nothing to do with their last visit: marking the dashboard's summary read doesn't show them a note's history, and looking at a note's history doesn't take it out of the summary.

**Blame mode**:
Once called Who wrote this, which the command palette still finds it by, as it does "who changed what". It comes from the Blame plugin, which a member can turn off. A note's lines marked by who last changed each, in a column left of the text as a blame view has. Lines next to each other that one change last wrote are a run, and the column names, on each run's first line, who wrote it and when, with the change's label or what its revert did; the member's (one family of colours), the agent's (another, with whose agent it is), or the member's own ("You", grey). A strip at the column's edge is stronger the newer the change. A line is changed by an edit inside it and by being written; lines put in or taken out around it leave it as it was, and a line a revert, undo or redo brings back is still its writer's, while a line it writes anew (a conflict settled by hand) is the reverter's; the revert itself shows in History. Pressing a run opens that change in History, and two commands move to the next or previous run and open its change. The member turns it on for one note at a time, with Toggle blame mode or the Blame switch in the note's History panel, and the note keeps it on for them in that browser. Agents ask the same of `note_blame`, named as git names it.
_Avoid_: Annotate, Who wrote this

**Label**:
A name attached to one revision in history. A revision has at most one, and a note uses a name once.

## Configuration

**Plugin**:
A unit of functionality that adds commands, views, embeds, completions, editor extensions, data sources, or settings through the public plugin API, and reaches the workspace only through the plugin host. A member may author a plugin. An admin chooses which plugins are installed in a workspace, and a plugin is available only after that. A member can turn a plugin off for themselves on the Plugins page, which takes out everything it added, and the choice is kept in their settings. A plugin cannot change settings.
_Avoid_: Extension, add-on

**Built-in plugin**:
A plugin that comes with Common Ink, such as the sidebar, the folder tree, tabs and splits, and the command palette. One that needs the editor or the app's own layout is compiled into the app and runs inside it with everything the member has: "Built-in, full access". One that needs nothing of the page is a sandboxed plugin, declared in the manifest a third-party plugin is: "Built-in, sandboxed", as Word count, Quick timer, Backlinks, Weather, Coin and Dice are. It is on by default unless it says it starts off, as Vim mode does.

**Sandboxed plugin**:
A plugin that runs shut off from the app in frames of its own and does only what its capabilities allow, checked by the app and again by the server. Every third-party plugin is one unless it asks for full trust, and so are the built-in plugins that need nothing of the page. Both go through the same broker, port and address on the server.

**Plugin host**:
The part of the core that turns plugins on and off, hands each one its reach into the workspace, and keeps what each has contributed.

**Contribution**:
One thing a plugin adds: a command, a view, an embed, a completion, or an editor extension. It is there while its plugin is on.

**View**:
Something a plugin draws in a slot of the app: a column, a section of the sidebar, the editor area, a folder's list of notes, an inspector panel, a page, the bottom bar, or an overlay.
_Avoid_: Panel

**Bottom bar**:
The thin line along the foot of the window where plugins put small things to glance at, such as the word count of the note in front, the open note's running timers and stopwatches, and a quick timer. An item sits at its left or its right end. It is there while any plugin has an item in it, and is the same height whatever the items say. In focus it is out of sight, and what in it is live, such as a running timer or an upload being sent, is at the foot of the note instead, beside vim's mode and whether the note is saved: a count such as the words is not live.
_Avoid_: Status bar, footer

**Page**:
A view with its own address, such as History or Agents, opened in a tab of the editor as a note is.
_Avoid_: Mode, screen

**Embed**:
Content a plugin draws inside a note where the note says `::name{config}`, such as a timer or HTML. It is handed what the note says of it and nothing else: it cannot read other notes, settings, grants, or plugin permissions. Everything it knows is in the note, so it can rewrite its own config and body, which is a change by the member who was using it. A timer or stopwatch keeps when it started there, so it runs the same for everyone reading the note. Network access requires an approved plugin permission. With no plugin for the name, the note shows what is written. An embed is drawn in a card and stays drawn, the element it was, so the cursor never stops or resets it. While the cursor is on it, it is shown as written too, above its drawing: an inline embed's text in rows above its line, a block embed's markdown lines above its card.

**Embed options**:
What a member adjusts about an embed without reading its config, from the one options button in the embed's card, which opens them beneath the card: a timer's length, a board's column colours. Setting one rewrites the embed in the note, as the member's change. An embed with nothing to adjust has no button. Most are declared: data saying each option's name, type and default (in a third-party plugin's manifest, or a built-in's declaration), which the app reads from the config as `name=value` words, draws, checks and writes back, as the HTML embed's height is.

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
The line that holds a media embed's address. While the cursor is elsewhere it takes no room and the media is where it was, a paragraph's gap below the words above. With the cursor on it, the address shows above the media, small, in the code face and the accent's colour, and the media gets an edge of that colour. A step of the arrow keys, or vim's `j` and `k`, from the line next to it stops on it.

**HTML embed**:
A block embed (`:::html{}`) whose body is HTML, run below the block in a frame with an origin of its own, by itself the first time its room is on screen, or when the member presses Run if they have asked to be asked first. While the cursor is in the block, what was run stays; the HTML as written runs once the cursor leaves. HTML that was running when its page stopped answering asks before it runs again. Until it is drawn its room shows a placeholder its size. It can't read the app, the member's session, or anything the browser or the server keeps, can't send its frame anywhere, and can't fetch or send anything unless an admin has allowed HTML embeds the network, and then only to the sites listed. The one other way out it has is a WebRTC connection, which browsers give no way to refuse.

**Run HTML embeds**:
A member's setting (`html.run`): `automatically` or `ask first`, which shows a Run button in place of each HTML embed until it is pressed. It defaults to `ask first` until the server serves HTML embeds from a site of their own (`EMBED_ORIGIN`), as the server says in `/api/me`, and to `automatically` where it does; the member's own choice stands either way. A value that is neither reads as `ask first`, and a change reaches notes already open: what ran by itself stops and asks, what was asking runs. Like every setting it is the member's alone: no plugin, agent or embed can read or change it. A page opened from a share link always asks first. An embed whose HTML has changed runs again, or asks again.

**Insert menu**:
The list that opens at the cursor when a member types `/` at the start of a line or after a space: blocks of markdown, such as a heading, a list, a table or a code block, and then every embed, each said in words with a small picture of what it makes, never its syntax. Typing filters it, and picking one writes it into the note. `::` opens the same list's embeds alone, so an embed's name typed as a note writes it is completed too.

**Completion**:
A list a plugin offers at the cursor while the member types after a trigger. The insert menu is one.

**Editor extension**:
Something a plugin adds to the editor of every note, such as keys or a status line. It applies to notes already open, and not to the settings JSON.
_Avoid_: Extension on its own, which reads as plugin

**Third-party plugin**:
A plugin a member wrote and an admin installed in a workspace: a manifest and code, kept in the workspace. It is available once installed, and off for each member until they turn it on. Its code runs in frames shut off from the app and reaches the workspace only through the operations its permissions allow, unless it asks for full trust. It adds commands, views in the inspector, the bottom bar and on pages, embeds drawn below their line, and options. It is known everywhere by the id the workspace gave it when it was installed.

**Full trust**:
What a third-party plugin's manifest asks for to run inside the app's page instead of sandboxed, with everything its member can see and do. It runs for a member only while an admin's grant of exactly that code stands and that member turned it on for themself after a warning. Any change to its code, or to how it asks for full trust, ends the grant and everyone's turning on for good, and a draft never has it.
_Avoid_: Trusted plugin (a built-in is not "trusted", it comes with the app), unsandboxed

**Manifest**:
What a sandboxed plugin says of itself, as JSON: its name, the capabilities it asks for with a reason each, and the commands, views, embeds and options it adds. A third-party plugin's is kept in the workspace, and a sandboxed built-in's is in the app (`src/core/ownPlugins.ts`). The app lists all of it without running the plugin's code.

**Draft**:
A member's own copy of a sandboxed plugin's source, an installed one's or a built-in's, kept beside their settings. Only its author can read or change it, admins included, and it is gone when they leave the workspace. It can run in the original's place for its author alone, sandboxed, with what the original is allowed and never more. An admin publishes one of a third-party plugin by installing it, which every approval has to follow again. One of a built-in is never published over it.

**Capability**:
One named thing a plugin can be permitted, which opens a fixed list of operations: read notes, write notes, read todos, read members' names, use the network for listed sites. Full trust is one too, and opens no operation: it is where the code runs. An operation no capability lists is refused to every plugin.

**Plugin record**:
What a workspace keeps of its plugins: which are installed, what each is permitted, and the requests waiting. Every member reads it and only an admin changes it. It is not settings.

**Night shift**:
A built-in plugin, off until a member turns it on, that draws the whole app in red light on black instead of the light or dark theme, which it sits on top of: turning it off brings back whichever the member had. Its colors have no blue, and green only as far as its strength lets in, from deep red to warm amber. It is turned on and off by hand with the command Toggle night shift and its key. It can also tint pictures, videos and embeds red, off unless the member asks for it.
_Avoid_: Dark mode, red mode

**Typewriter mode**:
A built-in plugin, off until a member turns it on, that keeps the line holding the cursor at one height in the note's pane, the middle unless the member keeps it elsewhere, and scrolls the text up or down under it as they type and move. Nothing moves sideways, and a click or the mouse wheel moves nothing. There is room above the first line and under the last so any line can be at that height. It is turned on and off with the command Toggle typewriter mode and its key. The command Typewriter: keep the line at this height keeps it where the line is now, and with vim, zt, zz and zb keep it at the top, the middle or the foot, unless the member says they shouldn't. It can dim every paragraph, heading and bullet but those the cursor or the selection is in. Turning it off leaves the line where it is on screen.
_Avoid_: Focus (that is the whole window given to one note), centered mode

**Plugin permission**:
An admin's decision on one capability of one plugin, for every member of the workspace: allowed or off, and locked or not. A locked permission takes no requests and stays as it is until an admin unlocks it. An approval is of the plugin as it was: new code voids every approval, and a capability declared another way voids its own. HTML embeds have one permission in the same record, the network, with the sites an admin lists. This is not settings.
_Avoid_: Setting

**Request**:
A non-admin's yes to a capability. It allows nothing: the capability stays off until an admin approves, and a denial clears it.

**Settings**:
JSON that configures one member's behavior in one workspace, such as theme, vim, keybindings, the daily-note folder, whether the share prompt appears, which plugins are on, and plugin options that only change that member's layout. It holds only what the member changed from a default, and follows them to any browser. A change made in one window is kept when another window changes a different key, and the later change wins on the same key. The member changes it in Settings, as options or as the JSON itself. Settings opens over whatever the window shows, at an address under `/settings`, and Escape closes it: it is never a tab, so the tabs, splits and focus under it stay as they were. An admin does not set or lock these, a plugin cannot change them except a remembered setting of its own, and an agent can neither read nor change them.
_Avoid_: Preferences, config

**Text size**:
How big the text of the whole app is for a member, as a percentage: menus, Settings, lists, pages and panels. A note's text follows it unless the member sets Editor text size, which is then the note's whatever the Text size. Both are settings.

**Note font**:
The font a note's text and headings are in, a member's setting: iA Writer Mono by default, IBM Plex Mono, Source Serif or the system's sans, each from the app's own files, or Custom, a CSS font-family list such as a font on the member's device. Code stays in a monospaced font. Line height and Reading width, the most a note's column is across, are settings beside it.

**Setting**:
One key in a member's settings, with a type, a default, and a description. The core declares some, each plugin declares its options under its own id, each plugin has one that turns it on and off, and each command has one for its keybinding. A value the setting doesn't allow is flagged and its default used. A key no setting has is flagged and does nothing. Neither is taken out of the member's JSON.
A remembered setting is a plugin option kept from what the member does in the plugin's own views, such as the Todos page's Sort (`todos.sort`): the plugin that declares it may change it for the member, and nothing else may.
_Avoid_: Option (except for a plugin's own), preference

**Settings schema**:
Every setting there is for a member in a workspace: the core's, those of each installed plugin whether it is on or off, and a keybinding for each command that is on. Settings are checked against it, and the options are drawn from it.

**Upload**:
A file in a workspace with one parent folder. The default folder is Unsorted. It is seen as a note is: by its folder, by a grant on it, and private to the member who uploaded it when they make it so. It has no link of its own, and is reached by a link only through the folder it is in. A note refers to an upload by its id, in an embed: `::image{id 640x480}`, `::video{id 640x360}`, `::audio{id}`, or `::file{id}`. The size after the id is the picture's or video's own, written by the app so its room is kept before it loads; a **size word** after it, `small`, `medium` or `large`, draws it a third, a half or three quarters of the note's column wide, and none draws it the column's whole width, never wider than its own size. A member sets it with the size handle on its right edge, not by typing. The file's name is kept for showing and is in no note and no address. A reader who can't see the upload is shown a placeholder that says nothing of it. An upload is archived and trashed as a note is, and a note that refers to one in Trash says so. Deleting a note leaves the uploads it refers to. A file can be at most 25 GB, and there is no limit to a workspace's uploads together: Settings shows the members how much they take. See `docs/adr/0008-uploads-are-items-and-their-bytes-go-through-the-resolver.md` and `docs/adr/0013-big-files-go-in-parts-to-single-use-addresses.md`.
_Avoid_: Asset, attachment

**Part**:
One piece of a file sent in parts: 80 MiB, the last one what is left, so a 25 GB file is 320. A file over 8 MB from the app, and any file from `ink upload`, is sent in parts, several at once. Until every part is there and the file is **finished** it is an upload no one sees, its sender included, and a note that already shows its line says how far it has got. Parts go to a **part address**, which needs no session or token, names one upload, takes each part once and lapses in an hour; **resuming** answers which parts are stored and a fresh address for the rest, so nothing sent is sent again. One nothing is sent to for a day is thrown away.
_Avoid_: Chunk, slice

**Uploader**:
The member or agent who uploaded a file, shown with it to whoever can see it. `uploader:` finds uploads by them, among the uploads the asker can see.

**File class**:
What a person calls an upload: image, video, audio, PDF, text or other (`fileClass`). It is decided from the type the server gave the bytes and, for text, the name's ending. `type:` in a query is it. Its kind (image, video, audio or file) is what says how a note draws it.
_Avoid_: File type (that is what the bytes are served as)

**Opening a file**:
What pressing an upload's chip, or Open on the Uploads page, does, by its file class (`openUpload`): a picture, a video, a recording or a PDF is shown in a file preview over the app, which offers Download, and a PDF in a tab of the browser, in its own viewer, from the site kept for files where the server has one (`FILE_ORIGIN`); text is read in the app at `/file/<id>`, drawn and not changed (markdown as a note is, a CSV or TSV as a table, anything else as code); anything else is downloaded. Text read in the app can be copied into a new note. An uploaded file is not changed in place.
_Avoid_: viewer

**File preview**:
As much of an upload as can be seen without opening it, drawn the same wherever it is (`drawPreview`): a picture, a player for a video or a recording, the first pages of a PDF drawn by pdf.js inside the app, the first rows of a CSV or TSV, the first lines of markdown or other text, and a large icon of its type for anything else. A file on a line of its own in a note is a **file card** below that line, its name, size and Download over its preview; among words it is a chip. The Uploads page's panel leads with the selected file's preview. Pressing a preview shows it larger over the app.
_Avoid_: Thumbnail (that is the small picture in a list), viewer

**Uses**:
How many notes the asker can see show an upload. A note they can't see is never counted, so a count says nothing of it. `used:` in a query is whether there are any.

**Placing an upload**:
What putting an existing upload in a note does to the upload, before its embed is written there (`upload.place`). An upload private to its owner, not yet in any note anyone else sees, goes to the note's folder and stops being private, so whoever reads the note sees it. In a private note it stays its owner's. Only the member does this, in the app: an agent is refused the change that lets others see a private upload, as it is `upload.setPrivate`. Any other upload is left where it is: who sees an upload is decided by its folder, grants and privacy, never by the notes that show it. "Insert an upload" in the `/` menu is how a member places one: a popover at the cursor finds it among the uploads they can see.

**Reach**:
How far an upload is seen, as the Uploads page says it to the member: "Only you" while it is private to them (as a file uploaded from that page is, until it is placed), "In N notes" by its uses, or "Not in a note". It never counts or names what the member can't see.
_Avoid_: Visibility (that is a note's `is:` words), audience

**Export**:
A copy of a workspace to keep: every live and archived note and upload the one asking can see, and nothing else, as Markdown files and the files themselves in directories named by folder path. A note is its title with `.md`, "Untitled" when it has none, and its text as stored, so its links and embeds still name ids; the **export index**, `common-ink-export.json` at the top, says which id is at which path, with each one's title, state and times, and marks `missing` an upload in the first part whose bytes weren't there; a later part lists any of its own in `common-ink-missing.json`. Names that would be the same in one directory, ignoring case, are told apart by ` (2)` and on, in the order they were made. What they can see in a folder they can't, such as a guest's granted note, is under `Shared with me/`. Anyone who can read in the workspace may export it, a guest and an agent too, an agent limited to folders only inside them, since it holds only what each could open one by one. Nothing in Trash is in it. It comes in parts, not a file's parts but each a zip of its own of at most 1 GiB and 300 uploads, the first with the notes and the index, and an upload larger than that alone in one; asked again, a part holds the same uploads. Most workspaces are one part. A member exports from Settings, an agent with `ink export`.
_Avoid_: Backup, download, archive (that is a state)
