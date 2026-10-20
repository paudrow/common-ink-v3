# Writing notes

A note is a markdown file in your workspace. This page covers titles and folders, links, mentions, tags, the / menu, files, Trash, tabs, Vim mode, and settings.

## Titles and folders

A note's title is the text of its first `#` heading. A note with no heading takes its title from its first line of words, skipping a line that is only a web address. A note with no words shows as "Untitled".

To make a note, press **New note** in the sidebar, or run **New note** from the command palette (`mod+shift+p`, where `mod` is ⌘ on a Mac and Ctrl elsewhere). If you close a new note without typing anything, the app discards it.

Every note is in one folder. A new note with no folder in front goes to **Unsorted**. **All notes**, the first row of the folder tree, lists every note you can see. An editor can create, rename, and move folders. An admin can delete a folder once it is empty.

## Links between notes

Type `[[` to list your notes by title, then pick one. The app stores the link by the note's id, as `[[k3j5h8d9f0a1]]`, and shows the note's current title. Renaming or moving the target changes nothing in the notes that link to it.

To give a link its own text, type `|` after the title and then the text. The link is stored as `[[id|display text]]`.

Click a link to open its note, or `mod`-click to open it in a tab behind. A link to a note that doesn't exist, or that you can't see, reads as unavailable. The inspector's **Backlinks** panel lists the notes that link to the one in front.

## Mentions

Type `@` to list the workspace's members and your own contacts. A member's mention is stored by their id and shows their current name in the theme colour. Anyone else's is stored by name and shows in gray.

A mention gives nobody access to the note and notifies nobody. Click a mention to open the person's page. A mention on a todo's line assigns the todo. See [Todos](/docs/todos).

## Tags

Write `#tag` anywhere outside code, with no space after the `#`. A tag tags the whole note, even on a todo's line. It needs something besides digits, so `#12` is not a tag, and matching ignores case. The sidebar lists your tags with their counts of notes, and each tag has a page of its notes.

## The / menu

Type `/` at the start of a line or after a space to open the embed menu. Keep typing to narrow it, and pick an item to write it into the note.

| Item | What it writes |
| --- | --- |
| Timer | `::timer{5m}`, a countdown that runs the same for everyone reading the note |
| Stopwatch | `::stopwatch{}`, with its time kept in the note |
| Kanban board | A block whose `##` headings are columns and whose list items are cards |
| Form | Questions that members answer, with the answers kept in the note |
| HTML | A block of HTML that runs in a frame shut off from the app |
| Event, Contact | A place for a reference to one of your events or contacts, which you paste over it. See [Calendar and contacts](/docs/calendar-contacts) |
| Upload a file | A file you pick from your computer |
| Insert an upload | A file already uploaded to the workspace |

An embed with settings has an options button in its card, for a timer's length or a board's column colours. Dragging a card on a kanban board moves its lines in the note.

An HTML embed can't read the app, your session, or other notes, and it reaches only the sites an admin lists. The setting `html.run` decides when one runs. With `automatically` it runs as soon as it is on screen. With `ask first` it shows a **Run** button. A page opened from a share link always asks first.

Some markdown is drawn in place without the menu:

- A table is drawn as a table. Type in its cells, and right-click a cell to add or delete rows and columns.
- LaTeX between `$` signs, such as `$e^{i\pi} + 1 = 0$`, is drawn as math. `$$` on lines of its own makes a display formula.
- A fenced code block is drawn in its language's colours, with Copy and a wrap toggle.
- A YouTube address, or the address of a post on X or Bluesky, alone on a line shows the video or post below it.

## Files

Paste or drop a file into a note to upload it. A picture, a video, or a recording shows in the note. Any other file on a line of its own shows as a card with its name, size, and **Download**, and among words as a chip. A file can be up to 25 GB.

A file you upload is yours alone until you put it in a note, which moves it into the note's folder. Then whoever can see that folder sees the file. In a private note it stays yours. The **Uploads** page lists every file you can see.

## Archive and Trash

**Archive** keeps a note and its links, and leaves it out of folder lists, search, the dashboard, and the Todos page until a query asks for `is:archived`. **Unarchive** brings it back.

**Move to Trash** keeps a note in Trash for 30 days, where you can read it but not change it. **Restore** puts it back in its folder, or in Unsorted if that folder is gone. After 30 days the note and its history are removed. The member who made the note, or an admin, can **Delete forever** sooner.

## Tabs and splits

A single click opens a note in a preview tab, shown in italics, which the next single click replaces. To keep a tab, double-click it, edit the note, or choose **Keep open** from the tab's menu.

To split the editor, choose **Split right** or **Split down** from a tab's menu, or drag a tab to the edge of a group. `mod+.` fills the window with the tab in front, and pressing it again puts everything back.

## Vim mode

Vim mode is off until you turn it on, on the **Plugins** page or with `"vim.enabled": true` in your settings. It gives every note's editor vim's modes, motions, and operators, and `gd` follows the link under the cursor.

Outside a note's text, wherever you are not typing, vim's keys move through the app:

| Keys | What they do |
| --- | --- |
| `ctrl+o`, `ctrl+i` | Go back and forward through the places you have been, across tabs |
| `j`, `k`, `gg`, `G`, `ctrl+d`, `ctrl+u` | Move through the rows of a list |
| `enter` or `l` | Open the selected row |
| `h` | Collapse the selected row, or go to its parent |
| `za` | Expand or collapse the selected row |
| `/`, then `escape` | Go to the search box, and back to the list |
| `ctrl+w`, then `h`, `j`, `k`, or `l` | Go to the sidebar, editor group, or inspector on that side |
| `gt`, `gT` | Go to the next or previous tab |

## Settings

Open **Settings** from the workspace menu at the top of the sidebar. Settings are JSON, and **Open settings (JSON)** shows the JSON itself. Only the values you change from a default are written, and they follow you to every browser.

```json
{
  "vim.enabled": true,
  "html.run": "ask first",
  "daily.folder": "Journal"
}
```

A value a setting doesn't allow is flagged, and its default is used. A key that no setting has is flagged and does nothing. JSON that can't be read isn't saved until you fix it. Agents can't read or change your settings.
