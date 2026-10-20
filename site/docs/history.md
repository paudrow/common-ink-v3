# History and blame

Common Ink records every change to a note with its author, whether that is you, another member, an agent, or a plugin. This page shows how to read a note's history, see who wrote each line, label a revision, and revert changes.

## What history records

Each change has its author, what it changed, and the revision it was made on. An author is a member, an agent, or a third-party plugin acting for a member. Each agent connection is its own author, so two agents with the same name stay apart.

History only goes forward. An undo, a redo, and a revert are each recorded as a new change that names the changes it reverted. Nothing is erased, and every change either still stands or was reverted.

## Read a note's history

Press the **History** icon in the inspector bar at the right of the window. The panel lists the changes of whatever is in front. For a note it lists them by time, and for a folder **By time** or **By note**. The icon is marked when a note has changes you haven't seen.

Changes are grouped under the day they were made. One author's edits to a note that follow each other less than ten minutes apart show as one row.

- Click a change to see what it did.
- ⌘-click on a Mac, or Ctrl-click elsewhere, to add a change to the selection or take it out.
- Shift-click to select a range.
- Tick a day to select the whole day, or press **Select all**.

The diff under the list shows what the selected changes did together. Where a later change edited lines the selection wrote, the diff marks it as a conflict before you revert anything.

Press **Open in History** to open the same list as the **History** page, under **More** in the sidebar. The History page lists the changes to every note you can see, and its **Everyone**, **People**, and **Agents** filter narrows the list by who made each change.

## See who wrote each line

Blame mode marks each line of a note with who last changed it. To turn it on for a note, flip the **Blame** switch in the note's History panel, or run **Toggle blame mode** from the command palette. The note keeps it on for you in that browser.

A column at the left of the text marks each run of lines that one change last wrote. The first line of a run names who wrote it and when, with the change's label if it has one.

- Your own lines say "You", in grey.
- Other members' lines use one family of colours.
- Agents' lines use another family, and say whose agent it is.
- A strip at the column's edge is stronger the newer the change.

Press a run to open its change in History. The commands **Next change in blame** and **Previous change in blame** move between runs and open each change. Typing inside a line changes who last wrote it. Adding or removing lines around it does not.

Agents can ask for the same view with the `note_blame` tool. See [MCP tools](/docs/mcp-tools).

## Label a revision

A label names one revision of a note, such as "Sent to the printer". Select the change that made the revision. In the diff of the selection, open the **…** menu beside the note's name and choose **Label this revision…**. A revision has at most one label, and a note uses each label once. Labels show in History and in blame mode.

## Revert changes

A revert is a new change that takes the effect of earlier changes out of a note and keeps every other change. You choose what to revert in one of three ways.

| To revert | Do this |
| --- | --- |
| A note back to a revision | Select the change that made the revision, open the **…** menu beside the note's name, and choose **Revert the note to this revision…** |
| Chosen changes | Select them, in one note or across many, and press **Revert…** |
| Everything an agent did | On the **Agents** page, press the revert button on the agent's row, such as **Revert Claude's changes…** |

Every revert opens a preview first. It lists the changes it would revert and the lines it would remove and add, note by note. Nothing changes until you confirm.

If a later change edited a line the revert changes, the preview shows a conflict. Settle each one:

- **Keep the later edit** keeps the newer words.
- **Go back to how it was** returns the line to before the reverted change, and drops the later edit.
- **Edit** lets you type the lines by hand.

A revert is recorded as one new change in each note it touches. To bring reverted changes back, revert the revert.

Reverting an agent's changes keeps everyone else's. Reverting the change that checked off a repeating todo also takes its copy off the daily note. See [Todos](/docs/todos).

## Undo and redo

**Undo** (⌘Z on a Mac, Ctrl+Z elsewhere) reverts your own latest change to a note that still stands. **Redo** (⌘⇧Z, or Ctrl+Shift+Z) reverts your latest undo, until you edit again. Other people's changes are kept either way, so undoing never removes a teammate's or an agent's work.
