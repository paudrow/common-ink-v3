My goal in making this project is to make an AI first notetaking app that is AI first (IE has an MCP and CLI for agents). People should bring their own agents to work with it. For now, we won't have an agent for the user to use.

Here are some details:

- We should use google signin for now. Take from v2 the signin and contacts and calendar permissions.
- Notes should be in markdown, settings and config should be in json, we should avoid using frontmatter
- Settings should have a gui and adjust a json file like vscode, only non default options should be populated in the settings json, errors in the settings json should be flagged
- Called common ink, use branding from earlier versions, host at commonink.app
- PRs should have live previews using cloudflare workers, fine to use draftox
- use cloudflare D1 for databases and D2 for storing files
- use codemirror6 to give great vim text editing experience
- workspaces
  - A space should be made in a workspace. Workspace admins can invite users as admins, editors, or just viewers. People can also be added on a note specific level too
  - Admins can set things like folder structure, who sees what, etc
- we should draw a lot of inspiration from vscode,
  - it should have similar split pane and tab management
    - Ability to drag notes into the pane to split or up to tabs to add as a tab
    - notes should be opened in a tab with note in italics, the note can change, double click and it makes it so new notes open in a separate tab
    - right click on a tab should let us close others, close all, close left/right
  - it should have powerful extensions that are available to the user that work like vscode extensions
  - Extensions should have security blocks in place, like for Apple software or Deno. It should ask the user if it can do certain things and provide a reason. The permissions should be kept in settings. Extensions cannot modify settings
  - Extensions should have their options exposed in settings, we should have workspace settings that apply to all users and are set by admins and user settings that apply just for the user.
- everything but a small common core should be extensions, we should have built in extensions that are enabled and trusted by default. We should allow the user to make their own. Extensions include
  - tab / pane management
  - VIM mode
  - folder renderer
  - tags
  - kanband board
  - todo rendering
  - tables
  - latex in markdown
  - Github markdown
  - html embeds
  - social and link embeds, including yt video embeds
  - timer, stopwatch, etc
  - contacts page
  - calendar page
  - activity history status like github does for every day with contributions
  - note history and diff viewer
  - markdown bullet behavior like workflowy
  - codeblocks with copy, line wrap toggle, and syntax highlighting
  - backlink following
- vim mode
  - vim key bindings should work in general for the app. Specifically ctrl+o ctrl+i for going between pages, gd for jumping to linked notes or opening web pages
- notes should have fine grain sharing like google drive
  - share with other users for write and edit
  - share a public or signed in URL
- we should use cmd+shfit+p for commands and cmd+p for search
- we should have the notion of data sources that can be read only or read and write. Data sources are things that we can reference in notes and use in our app, for example Google Contacts and Google calendar
- We should support powerful todos framework where todos live in notes
- Modes
  - Dashboard
  - Search
  - Tasks
  - Calendar
  - Contacts
  - Assets
  - History
- Layout
  - Left sidebar
    - We should have a left sidebar with Dashboard, search, tasks, and calendar, below that should have a folder layout. By default notes go into unsorted. Folders support nesting. Clicking a parent folder shows you its children
  - Right side bar should be the diff
  - Other modes should be shown below in a more button that toggles a collapsable section.
- We should have a focused writing mode which hides the side panels
- Diff viewer
  - We should have a powerful git diff style git viewer that periodically saves the changes and allows the user to see what has been done. It should show who made the change and what was the change. It sholud be able to show for a single file or all the files or for a specific set of files
  - User should be able to filter history by changes made by contributors, including bots, date, files changed, etc similar to github PR filtering
  - Files should be able to have a label applied to a specific version and files should be able to be reverted to that version
  - A selection of the changes should be able to be applied
  - This diff should be used for undo behavior
- Todos
  - Tasks should be specified with `- [ ] `
  - the should have chips that are rendered for options like due date, repeating, how important, who is assigned, etc
  - Reoccuring should be simple by default with an advanced option we should support
    - every X days/weeks/months/years
    - every tuesday/thursday (for example)
    - Advanced
      - X days/weeks/months after last completed
      - X days/weeks/months after the due date
      - 3 days from the start of the month / end of the month
      - second tuesday of each month
  - Reoccuring todos on completion should move the completed note to their daily note and reopen the TODO in its original place. We should have a chip that says when a reoccuring todo was last done and have a clicable list to see the history and show the number of times it has been done
- Mentions
  - The user can use @ to mention a person
  - People in the contacts are a grayed out person icon
  - People in the workspace are our theme color person
  - When a person is mentioned in a private note, the user is asked if they want to share the note with them, this can be turned off in settings
  - @ pulls up an autocomplete window that filters as the user types
- Embeds
  - User can hit `/` in editor to popup embeds menu and search through continued typing
  - Widget embeds in notes like a kanban board should store their data in the markdown file and be rendered in the note
    - syntax should be like ::timer{<config>}
  - Widgets like the Kanban board should store their data in a note and have config. I'm thinking something like this for syntax when data is stored in the note, not just config
  - User should also be able to embed arbitrary html, like a ThreeJS scene into a note or custom visualizations. This should be secure.
- Note
  - Notes should have a path `/note/<slug>-<unique id>`. The slug should be derived from the note title or content, the unique id should be how we track notes, like discourse does
  - Notes should by default go into an unsorted folder, unless we're in a folder when creating it
  - Notes should be able to link to other notes with `[[<note name>]]` This should have an autocomplete and rename if the note changes, using the note id. `[[<note name>|<display text>]]` should show the display text.
- Folders should also have the option to be shared between users or made public

```
:::kanban{<config>}
## Column 1
- Entry 1
- Entry 2

## Column 2
- Entry 3
:::
```
