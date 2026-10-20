# Common Ink v3 spec

This is the spec, kept in step with issue #1. The first rough draft is in the history of this file.

## Problem Statement

People who take notes increasingly work alongside AI agents, but note apps treat agents as an afterthought: there is no first-class way for an agent to read and edit notes, no record of what the agent changed, and no way to undo just the agent's work. Sharing is coarse, todos live in a separate app from the notes that produce them, calendars and contacts are disconnected from the notes that mention them, and editing is slow for keyboard-heavy users who want a real vim experience and VS Code-style tabs and splits.

## Solution

Common Ink is a hosted markdown note app at commonink.app where people bring their own agents. Every operation available in the UI is available to agents through a CLI and an MCP server, and every change, whether by a member, an agent, or a plugin, is recorded in history with its author so it can be inspected, filtered, reverted, or partly applied.

Notes are plain markdown with no frontmatter. Settings are JSON. A person signs in with Google into a workspace, where notes live in folders, members have roles, and grants narrow or extend access to single notes and folders. Todos are checkbox lines inside notes, with options shown as clickable chips and rich recurrence. A member's Google Calendar and Contacts are data sources that can be referenced in notes. Almost everything beyond a small core is a plugin, including the built-in features, and third-party plugins must ask for each capability. The editor is CodeMirror 6 with vim throughout the app, inside a VS Code-like shell with tabs, splits, a command palette, and quick open.

## User Stories

### Signing in and workspaces

1. As a person, I want to sign in with Google, so that I don't manage another password.
2. As a person signing in, I want to grant calendar and read-only contacts access during sign-in, so that those data sources are available without a separate setup. Editing contacts is agreed to separately, the first time I edit one.
3. As a person, I want to belong to more than one workspace, so that I can keep personal and shared work apart.
4. As a new person, I want a workspace created for me, so that I can start writing immediately.
5. As an admin, I want to invite people as admin, editor, or viewer, so that each person gets the right level of access.
6. As an admin, I want to change or remove a member's role, so that access follows people's responsibilities.
7. As an admin, I want to manage grants across the workspace, so that I can control who sees what.

### Notes

8. As a member, I want a new note to go into the folder I'm in, or into Unsorted when I'm not in one, so that I never have to choose a location before writing.
9. As a member, I want a note's title to be its first `#` heading, or its first line of words when it has none, so that the title is visible in the raw markdown.
10. As a member, I want each note to have a URL of the form `/note/<slug>-<id>`, so that links are readable and survive renames.
11. As a member, I want the slug to follow the title only, so that typing further down the body doesn't change the URL. A note with no words has the slug `untitled`.
12. As a member, I want an old URL with an outdated slug to still open the note by its id, so that shared links never break.
13. As a member, I want to write `[[` and pick a note from an autocomplete, so that linking is fast. The link is written `[[id]]` or `[[id|display text]]`.
14. As a member, I want links to follow the target note when it is renamed, so that links never go stale.
15. As a member, I want `[[id|display text]]` to show my display text, so that I can phrase links naturally. A `[[Title]]` typed in the editor stays as written and links nothing; picking from the `[[` menu writes the id.
16. As a member, I want the inspector's Backlinks panel to list notes linking to the open note, so that I can follow how ideas connect.
17. As a vim user, I want `gd` on a link to open the linked note, or open a web page for a URL, so that I can navigate without the mouse.
18. As a member, I want to archive the open note in one action, so that notes I no longer need disappear from ordinary views without being lost.
19. As a member, I want links to an archived note to still open it, so that old references keep working.
20. As a member, I want to unarchive a note, so that I can bring it back into ordinary views.
21. As a member, I want deleting a note to move it to Trash for 30 days, so that I can recover from mistakes. A note I made that never had words is discarded without going to Trash, and an admin or the note's maker can remove a trashed note for good before its 30 days.
22. As a member, I want to restore a note from Trash to its original folder, or to Unsorted when that folder is gone, so that recovery puts it back where it was.
23. As a member, I want a link to a note that is gone to read "Unavailable note", the same as one I can't see, so that I understand why it doesn't open without being told a note once existed.
24. As a member, I want to move a note to another folder I can edit, so that I can reorganize.

### Folders

25. As an editor, I want to create, rename, and move folders I can edit, so that I can organize my notes.
26. As a member, I want folders to nest, and clicking a parent folder to show its children, so that I can browse a hierarchy.
27. As an admin, I want to move or delete any folder, so that I can maintain the workspace's structure.
28. As an admin, I want deleting a folder to require that it is empty of everything I can see, so that nothing is lost by accident. Notes and uploads I can't see, and items in its Trash, move to Unsorted.

### Access and sharing

29. As an editor, I want to share a note or folder with a specific person who is not a member, giving view or edit, so that I can collaborate on one thing without inviting them into the workspace.
30. As a non-member with an edit grant on a folder, I want to edit its notes, see their history, and create notes there, so that I can collaborate fully within that folder.
31. As a non-member with a grant, I want to see nothing else in the workspace, so that the workspace owner's other notes stay private.
32. As a member, I want a grant on a folder to cover its nested notes and folders, so that I share a subtree in one action.
33. As a member, I want a more specific grant on a note or child folder to win over the folder's grant, so that I can make exceptions. For members a grant only narrows: it never raises a member above their role, and nothing narrows an admin.
34. As the member who made a note, I want to make it private, so that other members, including admins, cannot see it.
35. As a member, I want to share a note through a public share link, so that anyone can read it without an account.
36. As a member, I want to share a note through a signed-in share link, so that only people with a Common Ink account can open it.
37. As a member who mentions a member in a private note, I want to be asked whether to share the note with them, so that mentioned people can see what I wrote about them.
38. As a member, I want to turn off that share prompt in my settings, so that I'm not interrupted if I don't want it.
39. As a member, I want folders to support the same grants and share links as notes, so that I can share whole areas.

### Mentions and contacts

40. As a member, I want `@` to open an autocomplete that filters as I type, so that I can mention people quickly. Clicking a mention opens that person's page: what I may see of them, their todos, and the notes that mention them.
41. As a member, I want current workspace members to appear in the theme color and everyone else in gray, so that I can tell who has an account in this workspace.
42. As a member, I want to mention a contact who has no Common Ink account, such as my plumber, so that my notes record who said what.
43. As a member reading someone else's note, I want to see a mentioned contact's name in gray, so that I understand the note without seeing their contact list. Guests and share-link readers see every mention in gray.
44. As a member, I want mentioning a contact never to give them access, so that recording a name is not sharing.

### Todos

45. As a member, I want to write `- [ ]` to create a todo anywhere in a note, so that todos live next to the context that produced them.
46. As a member, I want the todo's options shown as chips that I can click to change, so that I don't need to remember syntax.
47. As a member, I want to set a due date through a chip, so that I know when something is due.
48. As a member, I want to set a priority of High, Medium, Low, or None, so that urgent work stands out. In a note the chip shows the marks as written (`!!`); the Todos page says the words.
49. As a member, I want to assign a todo to a member, a grant holder, or a contact, so that responsibility is recorded.
50. ~~As a member, I want to put a todo in a project with `+Name`.~~ Removed: there are no projects. Todos group by their note's tags and folder (`docs/todos.md`).
51. As a member, I want `#tag` on a todo line to tag the note, so that todos group by tag and folder.
52. As a member, I want simple recurrence such as every N days, weeks, months, or years, or on specific weekdays, so that common repeats are easy to set.
53. As a member, I want advanced recurrence such as N days after last completed, a weekday or day of every Nth week or month, a day counted from the start or end of the month, the second Tuesday of each month, or a date each year, so that complicated schedules are possible. A plain `every:3d` counts from the due date and skips what was missed, so a late todo is never left overdue.
54. As a member, I want checking off a recurring todo to keep the open line in place with its next due date and add the checked line, with a link back to its note, to my daily note, so that my history of completions is kept without clutter. When my daily note's readers couldn't see the todo's note, only the link is filed.
55. As a member, I want a chip showing when a recurring todo was last done and how many times, with a clickable history, so that I can see my consistency.
56. As a member, I want a Todos view that lists open todos in notes I can see, so that I can work through everything in one place.
57. As a member, I want to filter the Todos view with a query, by the note's tags and folder, by assignee, by due date, and by priority (`tag:`, `folder:`, `assignee:@me`, `due:`, `priority:`), so that I can focus.
58. As a member, I want `is:done` in the Todos query to include completed todos, so that I can review finished work.
59. As a member, I want due dates and today's daily note to be judged in my timezone, including for my agents and for completions filed by the server, so that "today" matches my day.

### Daily notes

60. As a member, I want my own daily note for each date, so that my completions and today's notes have a home.
61. As a member, I want to pick the folder my daily notes go into, from the folders I can edit, defaulting to Daily, so that they fit my organization.
62. As a member, I want changing that folder to leave old daily notes where they are, so that nothing moves unexpectedly.
63. As a member, I want my daily note's heading to be the date in my timezone, written `# 2026-10-19`, so that it sorts and matches `due:` dates.

### Dashboard

64. As a member, I want a dashboard showing my events still ahead today, including all-day events, so that I know what's coming.
65. As a member, I want the dashboard to show open todos I can see that are due today or earlier, so that nothing slips.
66. As a member, I want the dashboard to show my daily note and other notes created or edited today, so that I can pick up where I left off.
67. As a member, I want to pin notes to my dashboard, so that the notes I use most are one click away.
68. As a member, I want my pins to be mine alone and not written into the note, so that pinning doesn't change anyone else's view.
69. As a member, I want a summary of changes I can see since my last visit, which I mark as read, so that I can catch up on what others and agents did.
69a. As a member, I want to pick, order, and size my dashboard's panels, so that it shows what I use.

### Data sources

70. As a member, I want to connect my Google Calendar and Google Contacts, so that my events and contacts are available in the app.
71. As a member, I want my data sources to be visible only to me, so that connecting my calendar doesn't expose it to the workspace.
72. As a member, I want to edit an event in a read-write calendar and have the change written back to Google, so that I can manage my schedule here.
73. As a member, I want a read-only data source to refuse edits, so that I can't change something I meant only to view.
74. As a member, I want to reference an event or contact from a note without copying it, so that the note stays current.
75. As a member, I want a Calendar view and a Contacts view, so that I can browse my data sources.

### History

76. As a member, I want every change recorded with who made it, so that I can trust what I see.
77. As a member, I want my typing to be recorded as one change when I pause or leave the note, so that history isn't flooded by keystrokes.
78. As a member, I want the inspector's History tab to show the diff for the open note, so that I can see what changed.
79. As a member, I want a History view across the workspace that I can narrow to people or agents, one author, a date range, or notes changed, with `author:` and `updated:` in its search bar, so that I can investigate like I would on a pull request.
80. As a member, I want to view history for one note, a set of notes, or all notes, so that I can scope my investigation.
81. As a member, I want to label a revision of a note, so that I can mark important versions.
82. As a member, I want to revert a note to any revision, labeled or not, so that I can return to a known good state.
83. As a member, I want to pick changes in History and revert them together, settling each conflict, so that I can keep some edits and drop others.
84. As a member, I want undo and redo to move through my own changes in history, never another author's, so that undo takes back exactly what I did. An agent's work is taken back with Revert its changes (story 88).
85. ~~As a member, I want an Activity view showing how many changes I authored each day.~~ Moved to the Journal plugin's activity grid (#89).

### Agents, CLI, and MCP

86. As a member, I want to connect my own agent by pasting a prompt into it, or connect a hosted chat app such as claude.ai or ChatGPT by signing in through OAuth, so that it can read and edit my notes.
86a. As a member, I want to limit an agent to read-only, one workspace, some folders, or until a date, so that it gets no more than it needs.
87. As a member, I want my agent to act with my access and no more, so that it can never reach notes I can't.
88. As a member, I want my agent's changes attributed to the agent, so that I can filter and revert them separately from mine.
89. As a member, I want removing my access to remove my agent's access, so that nothing is left behind.
90. As an agent, I want an MCP server offering the same operations as the UI, and an `ink` CLI over it, so that I can do anything a person can, except what can't be taken back from history or hands out access: settings, membership and invites, sharing and privacy, permanent deletion, connecting sources, and editing contacts.
90a. As an agent, I want to replace ranges of lines in a note, so that edits to other lines aren't overwritten.
91. As an agent, I want notes to be plain markdown with options written as readable tokens, so that I can edit them without a special format.

### Plugins and embeds

92. As a member, I want built-in features such as vim, tabs, folders, tags, todos, tables, LaTeX, GitHub-flavored markdown, code blocks, embeds, kanban, timers, calendar, contacts, history, backlinks, and Workflowy-style bullets to be plugins, so that they can be turned off.
93. As a member, I want to write my own plugin, so that I can extend the app.
94. As an admin, I want to choose which plugins are installed in the workspace, and to turn off a built-in plugin for the whole workspace, so that I control what runs.
95. As an admin, I want a third-party plugin to list each capability with a reason, so that I can decide what to allow.
96. As an admin, I want to set and lock each plugin's permissions for the workspace, so that members can't widen them.
97. As a non-admin, I want saying yes to a plugin's request to send it to an admin, so that I can ask for capabilities without granting them.
98. As a member, I want plugins never to change my settings, other than the options a plugin remembers for itself (such as a calendar's hidden calendars), so that a plugin can't change my setup behind my back.
99. As a member, I want to press `/` and search an embed menu as I type, so that I can insert widgets quickly.
100. As a member, I want inline widgets such as a timer or stopwatch written as `::name{config}`, so that they are visible and editable in the markdown.
101. As a member, I want block widgets such as a kanban board to store their data in the note between `:::name{config}` and `:::`, so that the data is plain markdown.
102. As a member, I want kanban columns to be headings and cards to be list items, so that the board reads naturally as markdown.
103. As a member, I want a social post (X or Bluesky) or a YouTube video to show when its bare URL is alone on a line, so that notes can include rich media. A link is a plain markdown link.
104. As a member, I want to embed arbitrary HTML, such as a Three.js scene, safely isolated from the rest of the workspace, so that I can build visualizations without risk.
105. As a member, I want code blocks with copy, a line-wrap toggle, and syntax highlighting, so that code in notes is usable.

### Settings

106. As a member, I want a settings GUI that edits a JSON file, like VS Code, so that I can use whichever I prefer.
107. As a member, I want only the settings I've changed written to the JSON, so that the file stays short.
108. As a member, I want errors in my settings JSON to be flagged, so that I can fix mistakes.
109. As a member, I want plugin options to appear in settings, so that I configure everything in one place.
110. As a member, I want my theme, vim, and keybindings to be mine and not set by an admin, so that I control my own experience.

### Editor and shell

111. As a vim user, I want vim keybindings in the editor through CodeMirror 6, so that editing is fast.
112. As a member, I want back and forward to go through every place I've been (notes with their cursor, folder lists, and pages) with `⌘[` and `⌘]` on a Mac, `Alt+←` and `Alt+→` elsewhere, and vim's `ctrl+o` and `ctrl+i`, so that navigation feels like vim.
113. As a member, I want a note opened by a single click to open in a preview tab shown in italics, which the next note replaces, so that browsing doesn't pile up tabs.
114. As a member, I want double-clicking a tab, or editing its note, to keep it open in its own tab, so that I can keep notes I'm working on. Double-clicking a folder row, search result, or backlink opens it kept.
115. As a member, I want to drag a note to an editor's edge to split it, onto its middle or onto the tab bar to add it as a tab, so that I can arrange my workspace.
116. As a member, I want right-clicking a tab to offer keep open, split right, split down, close others, close all, close to the left, and close to the right, so that I can tidy tabs quickly.
117. As a member, I want `cmd+shift+p` to open the command palette, so that I can run any command from the keyboard.
118. As a member, I want `cmd+p` to open quick open over notes, uploads, and calendar events by title or filename, listing open tabs and then recent places when nothing is typed, so that I can jump anywhere.
119. As a member, I want a Search view over the text of notes I can see, including todos and tags, with one query language written like GitHub's search (`is:`, `has:`, `tag:`, `editor:`, `updated:`, `sort:`, `-`, `OR`) and an Advanced builder, so that I can find anything I wrote.
120. As a member, I want archived and trashed items left out of quick open and search unless I include them, so that results stay relevant.
121. As a member, I want a sidebar with the workspace switcher, Dashboard, Search, Today, Todos, and Calendar, then More, then the folder tree with All notes first, and Tags, so that the main modes are one click away.
122. As a member, I want a More toggle that shows Contacts, Uploads, History, Trash, and Plugins, and opens by itself when I arrive at one of them, so that the sidebar stays short. Members, Sharing, Agents, and Settings are in the workspace menu.
123. As a member, I want opening a folder to show its notes as cards in the editor area, as a folder tab, each showing the start of the note, when it was last edited, and everyone who has edited it, people and agents, with a search bar and an Advanced builder, so that I can scan a folder before opening anything.
124. As a member, I want an inspector on the right with History, Backlinks, and Info panels about whatever tab is in front, where Info for a note shows the folder with a Move picker, who it's shared with, tags, the URL, Archive, and Trash, so that everything about what I'm looking at is in one place.
125. As a member, I want to resize the sidebar and the inspector by dragging their edges, and fold the sidebar into a bar of icons by dragging it closed or with `⌘\`, so that I can give the note more room.
126. As a member, I want the folded sidebar's Folders icon to open the folder picker over the page, and the inspector bar's icons to open their panel over the page or pinned beside it, without moving the note, so that I can reach folders, history, backlinks, and info without reflowing the editor.
127. As a member, I want the inspector bar's History icon to show a dot when there are changes I haven't seen, such as an agent's edit, so that I notice changes without the panel open.
127a. As a member, I want Focus (`⌘.` or a group's focus button) to fill the window with one tab, with no sidebar, inspector, bars, or tab row, so that I can write with the whole window.

### Uploads

128. As a member, I want to upload images and files of up to 25 GB, sent in parts that resume where they stopped, into the note's folder when I paste or drop one into a note, or into a folder I pick, defaulting to Unsorted, so that notes can reference them.
129. As a member, I want an Uploads view listing every upload I can see, so that I can manage files.
130. As a member, I want uploads to follow the same grants, archive, and Trash rules as notes, so that files behave predictably.
131. As a member, I want deleting a note to leave the uploads it references, so that other notes using them aren't broken.

### Development

132. As the maintainer, I want every PR to be tried on a local preview (`npm run dev`) with a "Try in this PR" note written into it, so that I can review changes running. CI's Cloudflare Previews still deploy, but nobody needs to review them.
133. As the maintainer, I want the app to use the Common Ink branding from earlier versions, so that the product feels continuous.

### Added since the first draft

134. As a member, I want a Blame mode that marks each line with who last changed it, members and agents in different colours, so that I can see what my agent wrote (#72).
135. As an agent or member, I want to ask questions in a `:::form{}` block and read the answers in that same note, with anonymous tallies as an option (#102).
136. As a member, I want a Night shift plugin, a red-on-black theme with no blue light, toggled with `mod+shift+x` or following the night from a place I set once, at a strength I choose (#100, #92).
137. As a member, I want a browser extension that clips a page, a selection, an image, an element, or a link into a note in a folder I pick, without making a duplicate when a save is retried (#106).
138. As an editor, I want to drag a folder onto another to nest it, or off every row to the top (#77).
139. As a person, I want to sign out everywhere, and as an admin, to sign a member out everywhere (#83).
140. As a member, I want to set text size, note font, line height, and reading width, and have an empty untitled note delete itself (#97).
141. As a member, I want a Today page that opens today's daily note, with commands for yesterday and tomorrow.
142. As a member, I want a bottom bar with the word count and running timers, and a quick timer that belongs to no note.
143. As a member on a phone, I want the app as a stack of screens, with plugins that need a keyboard turned off (#114, not merged yet).

## Implementation Decisions

### Platform

- Hosted on Cloudflare Workers at commonink.app. D1 holds relational data and history. R2 holds uploads. Every PR deploys a Cloudflare Preview, but PRs are reviewed on a local preview with a "Try in this PR" note. Uploads go up to 25 GB, sent in 80 MiB parts that resume, with no workspace quota (ADRs 8 and 13).
- Sign-in is Google OAuth, requesting the `calendar.events` and `calendarlist.readonly` scopes and the read-only contacts scope, only where the deployment keeps data sources. Write access to contacts is asked for the first time a member edits one.
- Branding follows earlier versions of Common Ink.

### The workspace operations core

- One module owns every operation on a workspace: creating, editing, moving, archiving, trashing, and restoring notes, folders, and uploads; managing members and grants; checking off todos; labeling, reverting, and applying selections of history; installing plugins and deciding requests; and reading anything.
- Every operation takes an actor and an operation. An actor is a member, a guest (a non-member with a grant), an agent acting for a member or a guest, a signed-in share-link visitor, or a public share-link visitor.
- The web UI and the MCP server are thin clients of this module, so agents use the operations people use. The `ink` CLI is a convenience over the MCP tools, run from a checkout; it isn't published. Agents are refused the operations listed in story 90, each with a written reason that a test checks.
- Agents connect with a token from a pasted prompt, or as hosted chat apps through OAuth with dynamic registration and PKCE; either way the connection is an agent (ADR 12). An agent can be limited to read-only, one workspace, some folders, and an expiry. Agents cannot read or change settings, membership, sharing, or privacy.
- Access is resolved inside the core and nowhere else. The effective access to a note, folder, or upload comes from the actor's role, narrowed by grants for members and granted directly for guests. The most specific grant wins. A grant never raises a member above their role, nothing narrows an admin, and only an admin narrows a member. An agent's access is its member's access, evaluated at the time of each operation.

### History

- History is the source of truth. Each change records its author, a diff, and the base revision. A note's current text is derived from its changes, and a current-text cache is kept for reads.
- The editor's local undo covers only uncommitted typing. Typing is committed as one change on a one-second pause or when the note loses focus. History shows saves less than 10 minutes apart as one row, picked and reverted as a whole.
- A write based on an old revision is merged, never silently overwritten.
- History only goes forward. Revert, reverting a selection of changes, undo, and redo are operations that add new changes; history is never rewritten. Undo and redo take back only the asker's own changes. Labels are kept beside history and record no change. Removing an item for good removes its history: a trashed item after 30 days or when purged, and a note its maker leaves without words.
- Archive state, Trash state, pins, daily-note ownership, and grants are stored outside the markdown.

### Notes, links, and folders

- A note has a stable id. Its title is the first `#` heading, or its first line of words when it has none (a line that is only a web address is skipped), or Untitled. The slug comes from the title only, and is `untitled` when there is none.
- A link is written `[[id]]` or `[[id|display text]]`. The note holds the target's id and never its title, so a rename changes no other note (ADR 1). Its visible text follows the target's title unless it sets display text with `|`.
- A mention is `@[[id|name]]` for a member and `@[[name]]` for anyone else (ADR 7).
- Every note and upload has exactly one parent folder. Unsorted is a real folder.
- A folder can be deleted only when it holds nothing its deleter can see. What they can't see, and its trashed items, move to Unsorted. A note restored after its folder is gone goes to Unsorted.

### Todos

- A todo is a markdown checkbox line. Its options are tokens on that line, and the editor renders each token as a chip; the priority chip shows its marks. Changing a chip rewrites the token.
- Tokens: a mention for an assignee, `due:` followed by a date, `!`, `!!`, or `!!!` immediately after the checkbox for Low, Medium, or High priority, `every:` and a rule for Repeat (`every:2w`, `every:3d-after-done`, `every:mon,thu`, `every:2nd-tue`, `every:last-day`, `every:mar-1`, optionally ending `-times-N` or `-until-DATE`), and `done:2026-10-10x12` for the latest completion and count. The full grammar is in `docs/todos.md` and ADR 4. There are no projects: a `+Name` is plain words.
- A `#tag` anywhere on the line tags the note, not the todo. Tags match ignoring case.
- Checking a non-recurring todo writes it as checked. Checking a recurring todo keeps the open line, advances its due date, and appends the checked line, without `every:` and `done:` and with a link back to its note, to the daily note of the member who checked it, or of the agent's member. Where the daily note's readers couldn't see the todo's note, only the link is filed. A guest, or a member who can't write in their daily folder, files nothing.
- The recurrence engine computes the next due date for all simple and advanced rules and is a pure function, tested directly.
- Assignees can be members, non-members with a grant on the note, or contacts. A contact's name is stored on the note.

### Daily notes

- Each member has one daily note per date in their timezone, created on first need, and private to them by default. The server, agents, and completions with no day given use the member's own timezone too. Its heading is the ISO date, `# 2026-10-19`. Its folder is picked in the member's settings from the folders they can edit, defaulting to Daily.

### Data sources

- A data source belongs to the member who connected it and is visible only to them. Records are not notes.
- Read-write sources write edits back to the external system, attributed to the member. Read-only sources refuse edits.
- Notes reference records without copying them, as `::event{ref label}` and `::contact{ref label}`; the label is only a fallback for readers who can't see the record.

### Plugins

- Built-in features are plugins on the same public API as third-party ones. The core stays small: the operations core, history, access, the editor host, and the plugin host.
- A plugin declares the capabilities it needs, each with a reason. An admin installs it and sets its permissions for the workspace, optionally locking them. A non-admin's approval becomes a request. Built-in plugins are trusted and on by default; an admin can turn one off for the whole workspace. Demo plugins (Weather, Sample calendar, Coin, Dice) are on in development and Previews and off in production.
- Plugins can contribute commands, views, embeds, and setting options. Data sources are part of the core. A plugin may change only the options it remembers for itself, never other settings.
- Third-party plugin code runs sandboxed in frames and reaches the workspace only through operations allowed by its permissions, unless an admin grants full trust to that exact code and the member turns it on after a warning (ADRs 10 and 11).
- A member can turn any plugin on or off for themselves, and can edit a draft copy of a sandboxed plugin's source. Vim mode, Line numbers, and Night shift are off by default.

### Embeds

- Inline widgets use `::name{config}`. Block widgets use `:::name{config}`, then their data as markdown, then `:::`. A social post or video is its bare URL alone on a line. A third-party plugin's embed is named `::x-name{config}`, draws below its line, and can't be a block; no plugin takes over a built-in embed's name.
- Arbitrary HTML embeds run in a sandboxed frame on a separate origin. They cannot read other notes, settings, grants, or plugin permissions. Network access requires an approved plugin permission.

### Settings

- Settings are JSON for one member in one workspace, validated against a schema assembled from the core and installed plugins. Only non-default values are written. Invalid values are flagged in both the GUI and the JSON editor.
- Admins do not set or lock settings. Plugin permissions are a separate record managed by admins.
- Settings open over the window and are never a tab. A plugin may change only its own remembered settings.

### Shell

- The layout is a sidebar, the editor area, and the inspector. Opening a folder shows its notes as cards in a folder tab in the editor area; there is no note list column. Dragging an edge resizes a side, and dragging it past its least width folds it. A folded sidebar leaves the sidebar bar, an icon for each thing it lists, whose Folders icon opens the folder picker over the page. The inspector bar is always at the right, one icon per panel (History, Backlinks, Info). A panel opens over the page or is pinned beside it, and is about whatever tab is in front. Focus (`⌘.` or a group's focus button) fills the window with one tab: no sidebar, inspector, bars, or tab row. This started from a prototype (see Further Notes) and was revised in review.
- The sidebar lists Dashboard, Search, Today, Todos, and Calendar, in that order.
- The shell provides VS Code-like tabs, preview tabs, splits, drag-to-split, tab context menus, a command palette, and quick open. Vim keybindings apply across the app as well as in the editor.

## Testing Decisions

- Good tests exercise external behavior through the highest seam and assert on what an actor can observe: note text, history entries and their authors, what an actor can see, and the results of operations. They don't assert on storage layout, internal modules, or rendering internals.
- **Seam one, the workspace operations core.** Nearly every rule is tested here by calling operations as a specific actor and checking the results: access resolution across roles, grants, and private notes; agents acting within their member's access; archive and Trash, including the 30-day removal; todo completion and recurrence filing to the right daily note; links following renames; history attribution, revert, labels, applying selections, and undo; plugin permissions and requests; settings validation; search and quick-open scope; and data-source refusals for read-only sources. The CLI and MCP server are covered by a small set of tests confirming they reach the same operations.
- **Seam two, the editor and shell in a browser,** run in CI against a local build. This covers only behavior that exists in the UI: chips rewriting their tokens, the layout regions, the sidebar bar and folder picker, the inspector bar, Focus, preview tabs, splits and drag, tab context menus, the command palette, quick open, vim keys including `ctrl+o`, `ctrl+i`, and `gd`, the `@` and `/` menus, and the HTML embed's isolation.
- Pure functions with large input spaces, such as recurrence and slug generation, can be tested directly as well.
- Core tests and the web plugins' unit tests are in `test/core/`, browser tests in `test/browser/`, recurrence runs across time zones in `test/zones/`, and the clipper's tests in `extension/test/`.

## Out of Scope

- A built-in agent. People bring their own.
- Offline mode and sync.
- Sign-in providers other than Google.
- Data sources other than Google Calendar and Google Contacts.
- A plugin marketplace.
- A native mobile app. A phone layout for the web app is in progress (#114).

## Further Notes

- Vocabulary follows `CONTEXT.md`. Terms from the earlier draft are replaced: Space by Workspace, extension by Plugin, Tasks by Todos, and Assets by Uploads. Terms renamed since: writing mode by Focus, recurrence by Repeat, importance by Priority, non-member with a grant by Guest, public link by Share link, note list column by Folder's list, right sidebar by Inspector, and Who wrote this by Blame mode. Workspace settings that override a member's settings are replaced by plugin permissions managed by admins.
- The two details left for implementation are decided: links in ADR 1, and repeats in ADR 4 and `docs/todos.md`.
- The layout was chosen from a prototype comparing four layouts and four writing modes. The prototype, with screenshots, is on the [`prototype/layout`](https://github.com/paudrow/common-ink-v3/tree/prototype/layout) branch, and the decision is recorded on #3, #4, and #5. The prototype code is throwaway.
- Decisions are recorded as ADRs in `docs/adr/`.
- Per the working agreements in `AGENTS.md`, implementation proceeds in larger feature-centered PRs with a stop for feedback after each step.


