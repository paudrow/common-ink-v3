# 16. The settings JSON is the settings' own text in a note's editor, not a note

Status: accepted. The maintainer asked on 2026-10-21 for the JSON to be "a file like any other note", hidden unless opened from the command palette. The choice between a hidden note and the settings' own text was made without him and is open to his review.

## Context

Settings opened over the window as a dialog, at an address under `/settings`, and the JSON was one of its views (`/settings/json`) with an editor of its own. The maintainer didn't like that it wasn't the same editor as a note's, and asked for the JSON to be a file opened and edited as a note is, hidden from everything else. A member's settings are theirs alone in a workspace, kept with a revision by `settings.read` and `settings.write`, which an agent can't call.

Two ways to give it a note's editor:

1. **A note with a hidden flag**, owned by the member. It would get history, the editor and sync with no new code, but every place notes are listed, searched, indexed, linked, exported, counted or handed to an agent would need to leave it out, and one place that forgot would show a member's settings to other members or to agents. Settings would also be in two places, the note and the settings row the plugins read.
2. **The settings' own text, drawn in a note's editor.** No exclusions: it is in no listing because it isn't a note. Privacy is what it already was.

## Decision

**The JSON is the settings store's text in an editor drawn as a note's is (`src/web/SettingsFile.tsx`), in a tab at `/settings.json`.** It has the note's width, face, size, room under the last line and foot, and the plugins' editor extensions that declare `anyText`: vim, typewriter mode and line numbers. Extensions about what a note holds (links, todos, embeds, blame) don't apply to JSON and aren't given to it. Only Common Ink's own plugins may declare `anyText`: an extension in that editor could read every setting and write any of them, and a plugin may change only its own remembered settings. Undo and redo there are the editor's own, since it has no history on the server, and the settings as they arrive from the server are never in that history.

**Typing that isn't a JSON object is the store's draft** (`SettingsStore.draft()` and `type()`). It is saved nowhere, the settings stay as they were, the editor marks where it stops being JSON, and Settings' options wait for it as they did. It lives in the store, not the tab, so closing the tab and opening it again shows it.

**Commands.** `Go to settings (UI)` (`go.settings`) opens the dialog and `Go to settings (JSON)` (`settings.openJson`) the tab; each kept the id it had, so a key a member bound still works. A page view names such a command with `command`, which only the app's own plugins may do. An address kept from before, `/settings/json`, is written as `/settings.json` by the router's table of moved addresses (`src/web/moved.ts`).

**Storage and Export moved into Account.** They were under every category of Settings. They are about the workspace and the person, not settings.

## Consequences

- The JSON has no history of its own. A note's would have given it one for free; if that is wanted, the settings row can keep revisions.
- A change made in Settings' options, by a plugin's key, or in another window reaches the open tab as the smallest change that turns one text into the other (`src/web/textChange.ts`), so the cursor stays where it was.
- A new editor extension that is about how an editor is worked, not what a note holds, says `anyText: true` to be in the JSON's editor too.
