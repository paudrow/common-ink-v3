# Writing notes

A note is a markdown file in your workspace. This page covers titles and folders, links, mentions, tags, the / menu, files, Trash, tabs, Vim mode, and settings.

## Titles and folders

A note's title is the text of its first `#` heading. A note with no heading takes its title from its first line of words, skipping a line that is only a web address. A note with no words shows as "Untitled".

To make a note, press **New note** in the sidebar, or run **New note** from the command palette (`mod+shift+p`, where `mod` is ⌘ on a Mac and Ctrl elsewhere). If you close a new note without typing anything, the app discards it.

Every note is in one folder. A new note with no folder in front goes to **Unsorted**. **All notes**, the first row of the folder tree, lists every note you can see. An editor can create, rename, and move folders. An admin can delete a folder once it is empty.

Folders are described in Settings, under **Folders**, which the command **Manage folders** opens: every folder as a tree, Unsorted first as in the sidebar and the rest in name order, each folder inside another indented under it, with how many notes are in it and the folders inside it, and a description that says what goes in it. **Manage folders** in a folder's right-click menu in the sidebar opens it at that folder's row. Whoever can edit a folder writes the description there by clicking it, and renames, moves and makes folders there as Settings' Tags does tags: double-click a name, press F2 or click its pencil to rename it; drag a folder by its name onto another, or use **Move to…** in its right-click menu, to move it; and **New folder**, or **New folder inside** in a folder's menu, makes one. Agents read the description to choose where to file a note. Rest on a folder in the sidebar, or on one in the breadcrumbs above a note, to see its card: how many notes are in it and what it is for.

## Links between notes

Type `[[` to list your notes by title, then pick one. The app stores the link by the note's id, as `[[k3j5h8d9f0a1]]`, and shows the note's current title. Renaming or moving the target changes nothing in the notes that link to it.

To give a link its own text, type `|` after the title and then the text. The link is stored as `[[id|display text]]`.

Click a link to open its note, or `mod`-click to open it in a tab behind. A link to a note that doesn't exist, or that you can't see, reads as unavailable. The inspector's **Backlinks** panel lists the notes that link to the one in front.

## Mentions

Type `@` to list people, days, notes, uploads and events: alone, it shows a few of each, and typing narrows them. The people are the workspace's members and your own contacts. A member's mention is stored by their id, as `[[person:k3j5h8d9f0a1]]`, and shows their current name in the theme colour. Anyone else's is stored by name, as `[[person:Sam Okafor]]`, and shows in gray. To show words of your own instead of the name, type `|` and the words, as a link does. A guest, or anyone opening the note from a share link, sees a member's mention as "Someone".

A mention gives nobody access to the note and notifies nobody. Click a mention to open the person's page. A mention on a todo's line assigns the todo. See [Todos](/docs/todos).

## Tags

Write `#tag` anywhere outside code, with no space after the `#`. A tag tags the whole note, wherever it is written. A todo has only the tags on its line and the ones over it, as [Todos](/docs/todos) says. It needs something besides digits, so `#12` is not a tag, and matching ignores case. A `/` puts one tag inside another: `#project/alpha` is inside `#project`, and `#project` counts and finds the notes of the tags inside it too. The sidebar lists your tags with their counts of notes, and each tag has a page of its notes, which you search as you search a folder. Click a tag in the sidebar or in a note's card to open its page, or ⌘-click (Ctrl-click) one in a note or on a todo. Rest on a tag anywhere to see its card: how many notes have it and what it is for.

Tags are managed in Settings, under **Tags**, which the command **Manage tags** opens: every tag as a tree, each tag inside another indented under it, with its description and how many notes have it. **Manage tags** in a tag's right-click menu, in the sidebar or on the page of every tag, opens it at that tag's row, and **Rename tag** there starts renaming it. An admin or an editor works on it as on a file tree:

- Click a description, or press Enter on a row, to write it. Enter or clicking away keeps it, Shift+Enter starts a new line, and Escape puts it back. Agents read it to choose their tags.
- Double-click a tag's name, press F2, or click the pencil beside it to rename it. Renaming a tag renames the tags inside it too.
- Drag a tag by its name onto another to move it inside that one, or onto the strip under the table to move it to the top. **Move to…** in its right-click menu does the same from the keyboard. Moving a tag renames it, as `#alpha` becomes `#project/alpha`.
- **New tag**, or **New tag inside** in a tag's menu, makes a tag before any note has it, so you and your agents can use it.
- **Delete tag** in the right-click menu, or Delete or Backspace on the row, deletes a tag no note has, nor a tag inside it, such as one made ahead, with the tags inside it. Undo in the notice after brings it back with its description. A tag a note has has no Delete: it goes when no note has it, or rename it into another.

Before a rename changes any note you see how many will, and renaming to a tag you already have merges the two, keeping that tag's description. Notes you can't edit keep the old name. Each note's history shows the rename as your change, and Undo in the notice after puts every note back. Anyone who can see a note with the tag can read its description. A description stays with the tag's name, so the tag stays listed, with no notes, after no note has it.

## The / menu

Type `/` at the start of a line or after a space to open the insert menu. Each item says what it makes, with a small picture of it beside the list. Keep typing to narrow it, and pick an item to put it in the note.

| Item | What it makes |
| --- | --- |
| Heading 1, 2, 3 | A large, medium or small title |
| Bulleted list, Numbered list, Task list | A list, with a dot, a number or a box to check before each item |
| Table | Rows and columns, typed into cell by cell |
| Code block | Code in a fixed-width font, drawn in its language's colours |
| Quote, Divider | Words set apart as a quotation, or a line across the note |
| Timer | A countdown that runs the same for everyone reading the note |
| Stopwatch | A stopwatch whose time is kept in the note |
| Kanban board | Columns of cards to drag from one to another |
| Form | Questions that members answer, with the answers kept in the note |
| HTML | A block of HTML that runs in a frame shut off from the app |
| Drawing | Shapes, arrows and words drawn by hand in Excalidraw |
| Upload an image, Upload a video, Upload a recording | A picture, a video or a recording you pick from your computer, shown in the note |
| Upload a file | Any file you pick from your computer. A picture, a video or a recording shows in the note, and anything else as a card |
| Insert an upload | A file already uploaded to the workspace |

To reference an event or a contact, type `@` and its name. See [Calendar and contacts](/docs/calendar-contacts).

Typing `::` opens the same menu with the embeds alone, from the timer down, so `::kan` and Enter makes a kanban board.

An embed with settings has an options button in its card, for a timer's length or a board's column colours. Dragging a card on a kanban board moves its lines in the note.

An HTML embed can't read the app, your session, or other notes, and it reaches only the sites an admin lists. The setting `html.run` decides when one runs. With `automatically` it runs as soon as it is on screen. With `ask first` it shows a **Run** button. A page opened from a share link always asks first.

Some markdown is drawn in place without the menu:

- A table is drawn as a table. Type in its cells, and right-click a cell to add or delete rows and columns.
- LaTeX between `$` signs, such as `$e^{i\pi} + 1 = 0$`, is drawn as math. `$$` on lines of its own makes a display formula.
- A fenced code block is drawn in its language's colours, with Copy and a wrap toggle.
- A YouTube address, or the address of a post on X or Bluesky, alone on a line shows the video or post below it.

## Lists

A list works as an outline. With the cursor on a bullet, a numbered item or a todo, each of these keys takes what is under it along, and the items a selection takes in go together:

- `Option+↑` and `Option+↓` move it up or down among the items beside it.
- `Option+→` or `Tab` puts it under the item above it, one level in. The first item of a list stays where it is: it has nothing to go under.
- `Option+←` or `Shift+Tab` brings it back out a level. An item that is under nothing stays where it is.
- `Cmd+Shift+.` folds an item with something under it, and unfolds it.

A numbered list is numbered 1, 2, 3 again after each move, from the number it starts at. A list written with the same number on every item, such as `1.` on each, keeps that number, and an item that joins it takes it too. Off a Mac, use `Alt` for `Option`, and add `Shift` to `Alt+←` and `Alt+→`, which go back and forward. Anywhere else in a note, `Option+←` and `Option+→` move the cursor by words as usual. Change any of these keys in Settings, under Keyboard shortcuts.

## Files

Paste or drop a file into a note to upload it. A picture, a video, or a recording shows in the note. Any other file on a line of its own shows as a card with its name, size, and **Download**, and among words as a chip. A file can be up to 25 GB.

A drawing is drawn in Excalidraw, over the whole window: press **Edit drawing** on it, draw, and press **Save**. The note shows it as a picture, sized with the handle on its right edge as a picture is. Each save keeps the drawing as a new file, so undo in the note brings back the drawing before. The file is an `.excalidraw` file that Excalidraw opens, and an agent can read it and draw one too.

A file you upload is yours alone until you put it in a note, which moves it into the note's folder. Then whoever can see that folder sees the file. In a private note it stays yours. The **Uploads** page lists every file you can see.

## Archive and Trash

**Archive** keeps a note and its links, and leaves it out of folder lists, search, the dashboard, and the Todos page until a query asks for `is:archived`. **Unarchive** brings it back.

**Move to Trash** keeps a note in Trash for 30 days, where you can read it but not change it. **Restore** puts it back in its folder, or in Unsorted if that folder is gone. After 30 days the note and its history are removed. The member who made the note, or an admin, can **Delete forever** sooner.

## Tabs and splits

A single click opens a note in a preview tab, shown in italics, which the next single click replaces. To keep a tab, double-click it, edit the note, or choose **Keep open** from the tab's menu.

To split the editor, choose **Split right** or **Split down** from a tab's menu, or drag a tab to the edge of a group. `mod+.` fills the window with the tab in front, and pressing it again puts everything back.

Anything you can open drags the same way: a tab, a note's card, a folder in the sidebar, a tag, a page's link such as Todos, a crumb above a note, a note in the inspector's **Backlinks** panel, and any link to a note, folder, tag or page inside a page, such as a note on the Dashboard. Each tag opens in a tab of its own, so two tags can sit side by side. Drop it on the edge of a group to split it, on the middle to add a tab, or on the tab bar to put the tab where you let go. **Today** drops the day's note. **New note** makes a note where you drop it, in the folder you're looking at, as clicking it does.

## Vim mode

Vim mode is off until you turn it on, on the **Plugins** page or with `"vim.enabled": true` in your settings. It gives every note's editor vim's modes, motions, and operators, and `gd` follows the link under the cursor, or opens the mention, reference or file under it as a click does.

Outside a note's text, wherever you are not typing, vim's keys move through the app:

| Keys | What they do |
| --- | --- |
| `ctrl+o`, `ctrl+i` | Go back and forward through the places you have been, across tabs |
| `j`, `k`, `gg`, `G`, `ctrl+d`, `ctrl+u` | Move through the rows of a list |
| `enter` or `l` | Open the selected row |
| `h` | Collapse the selected row, or go to its parent |
| `za` | Expand or collapse the selected row |
| `dd` | Abandon the selected todo on the Todos page, or open an abandoned one again |
| `/`, then `escape` | Go to the search box, and back to the list |
| `ctrl+w`, then `h`, `j`, `k`, or `l` | Go to the sidebar, editor group, or inspector on that side |
| `gt`, `gT` | Go to the next or previous tab |

## Settings

Open **Settings** from the workspace menu at the top of the sidebar, or run **Go to settings (UI)** from the command palette. Settings are JSON. **Go to settings (JSON)**, or **Open settings (JSON)** in Settings, opens the JSON in a tab, where you edit it as you edit a note, with Vim mode and typewriter mode if they are on. It isn't a note: it isn't in your folders, search, or exports, and only you see it. **Open agents file**, beside it, opens the workspace's [agents file](/docs/agents#tell-agents-how-the-workspace-works) the same way. Only the values you change from a default are written, and they follow you to every browser. How much the workspace's files take, and its export, are in Settings under **Account**.

```json
{
  "vim.enabled": true,
  "html.run": "ask first",
  "daily.folder": "Journal"
}
```

A value a setting doesn't allow is flagged, and its default is used. A key that no setting has is flagged and does nothing. JSON that can't be read isn't saved until you fix it. Agents can't read or change your settings.
