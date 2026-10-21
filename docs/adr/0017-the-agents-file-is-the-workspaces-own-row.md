# 17. The agents file is a row of the workspace's own, given to an agent as it connects

Status: accepted. The maintainer asked on 2026-10-21 for "an agents file to give context to agents working in the space", like the settings file. The choices below were made without him and are open to his review.

## Context

Agents choose where to file a note by the folder and tag descriptions (migrations 0060 and 0061), but nothing told them how a workspace is organized as a whole: what goes where, how notes are named. A repository says that in its AGENTS.md. Settings are a member's own, one row per member per workspace (`settings`), and an agent can't read them. The agents file is the workspace's, written by the people who keep it in order, and read by every agent.

## Decision

**A table of its own, `agents_files`, one row per workspace** (migration 0062), with the text, a revision and the last write's id, as settings have, so a write on an older copy is refused and the browser merges. Three columns on `workspaces` would have needed no line in `erase.ts` or the restore checks, but they would be nullable together, a revision with no text, on the row every request reads for who may do what. With a table, no row is no file, and `erase.ts` says what happens to it: it is cut with the workspace's members and settings when the workspace is deleted, as what is said of the workspace and kept by no note. It holds no person's id, so deleting an account leaves it as it is.

**Written by an admin or an editor, signed in** (`agentsFile.write`: `needs: "edit"`, `by: "member"`, `members: true`). No agent writes it, since it steers every agent in the workspace and one talked into changing it would steer the others; it suggests a change by writing a note. No plugin writes it, full trust or not, and no guest. Everyone who reaches the workspace reads it (`agentsFile.read`), agents limited to folders included: it is about the workspace, as a folder's description is shown to a guest.

**In the instructions an agent connects with, made for its token.** They were one string for every agent, and `server/discover` said they could be cached by anyone. An agent that reaches one workspace is given the file up to 4,000 characters, marked as text from the workspace to weigh as guidance, never instructions. One that reaches several is told which have a file, by name and id, and reads each with `read_agents_file` and that `workspaceId`: given every file at once, it would take one workspace's filing for another's, and the instructions would grow with every workspace. A workspace its member is only a guest in counts only for a token pinned to it: anyone can share a note with an email, and what they wrote isn't put before the member's agent unasked. A workspace's name is quoted there, and a `</agents-file>` in the file is broken, so neither passes for the instructions' own words. `server/discover` is now `cacheScope: "private"`.

**No history.** It is saved as the member pauses, as a note is, but only the last text is kept, as settings are. The editor's own undo covers a session.

**Not in an export.** An export holds the notes and uploads the asker can see, and nothing of the workspace's own: not settings, not tag or folder descriptions. The agents file is the workspace's too.

**Opened as the settings JSON is** (`docs/adr/0016-the-settings-json-is-the-settings-text-in-a-note-editor.md`): its own text in an editor drawn as a note's, in a tab at `/agents-file.md`, with the Markdown a note has and the editor extensions that declare `anyText`. It is no note, so nothing that lists, searches, links or exports notes needs to leave it out. Its address isn't `/agents.md`: the development server answers that with the repository's own AGENTS.md on a file system that doesn't tell case apart, as a Mac's doesn't.

## Consequences

- An agent that stays connected keeps the instructions it was given until it connects again, which a client may put off for up to `ttlMs`. `read_agents_file` always answers the file as it is.
- Two people typing in it at once both keep their words: a write refused for a newer revision is merged over it in the browser (`merged` in `src/web/agentsFileStore.ts`).
- If history is wanted, the row can keep revisions, as for settings.
