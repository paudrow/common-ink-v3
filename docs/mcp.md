# Connecting an agent

A member connects an agent in the web app, on the Agents page (`/agents`, from the workspace menu or the "Go to Agents" command), and gets a token for it. The page shows the token once with the command to paste, lists the member's agents, and disconnects them. The agent sends the token to `/mcp` (the MCP server) or uses the `ink` command, which calls `/mcp`. Both go through the same operations as the web app (`src/core/operations.ts`), as the member who connected the agent.

## Rules

- An agent acts with its person's access in each workspace, and no further: their role where they are a member, narrowed by any grant that names them, and where they are a guest only what was granted. A viewer's agent can read and cannot write. A note its person can't see, such as another member's private note, is no note to the agent: it is in no listing, count, backlink, link title or history, and asking for it by id answers `not_found: No such note`, the same as for an id that was never a note's. Every listing of a note carries `access`, `edit` or `view`: what the agent may do with it.
- An agent can't share. Granting a note or a folder to someone, making or removing a link, making a note private, and reading who a note is shared with are for the member, signed in, in the Share dialog. A link can put a note before the whole internet, and none of this is a change in history that could be reverted.
- Its changes are recorded with the agent as author (`author_kind = 'agent'`, `author_id` = the agent's id), under the name the member gave it, so they can be told apart from the member's own.
- A member who loses access to a workspace takes their agents' access with them: every call checks the member's membership at the time. Removing a member, or their leaving, ends it on the agent's next call, and a change of role changes what the agent can do on its next call.
- An agent can see who is in a workspace (`list_members`: each member's person id, name, and role, and never an email, whatever its member's role) and can't change it. Inviting, changing a role, removing a member, leaving, and listing or revoking invites are for the member, signed in, on the Members page. Who is in a workspace decides who can read and change everything in it, that isn't a change in history that could be reverted, and an agent reads notes other people wrote, so one that was talked into it could invite a stranger as admin. The core refuses these to an agent whatever its member's role, not only the tools.
- A token expires after 90 days by default (`expiresInDays`, 1 to 365). An expired token is refused like an unknown one.
- A token can be pinned to one workspace (`workspaceId`: it sees only that workspace, even if its member is in others) and can be read-only (`readOnly`: it can read and can't change anything, even for an editor or admin). Both are checked in the core operations, not only in the tools.
- Names aren't unique: a member can have several tokens named "Claude", told apart by an optional `label` ("laptop"). Each token is its own author in history.
- Disconnecting an agent stops its token at once. Only a SHA-256 hash of a token is stored; the token is shown once, when the agent is connected.
- A token works only in an `Authorization: Bearer` header. It is not a cookie, so a web page can't use it.

## Connect and disconnect (signed in, from Common Ink's own origin)

    POST   /api/agents        {"name": "Claude"}   ->  201 {"agent": {...}, "token": "cink_..."}
    GET    /api/agents                             ->  {"agents": [...]}   (never the token; shows expiresAt, workspaceId, readOnly)
    DELETE /api/agents/<id>                        ->  204

Optional fields on the POST: `label` (up to 60 characters), `expiresInDays` (default 90, at most 365), `workspaceId` (one of the member's workspaces), `readOnly` (true or false). For example, a read-only token for one workspace that lasts 30 days:

    {"name": "Claude", "label": "laptop", "expiresInDays": 30, "workspaceId": "<workspace id>", "readOnly": true}

## MCP

`POST /mcp` with `Authorization: Bearer cink_...` and `Content-Type: application/json`. Streamable HTTP, stateless: one JSON-RPC message (or a batch) per POST, answered as JSON. No server-sent events, no sessions. Without a valid token the answer is 401.

Tools: `list_workspaces`, `list_notes`, `read_note`, `create_note`, `write_note`, `backlinks`, `rebuild_links`, `move_note`, `note_history`, for folders `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, and for history `history_summary`, `history`, `change_diff`, `history_authors`, `label_revision`, `revert_note`, `revert_changes`, `revert_author`, `undo`, `redo`, and `list_members` for who is in the workspace. Each takes an optional `workspace` id, which can be left out when the member belongs to only one workspace. An argument a tool doesn't take is refused by name, not left out.

Every operation the web app performs has a tool with the same fields, and every tool has an `ink` command. `test/core/agent-parity.test.ts` reads the operation schema and fails when one is missing; an operation kept from agents on purpose is listed with its reason in `NOT_FOR_AGENTS` (`src/worker/mcp/tools.ts`). Two kinds are kept from agents: reading and writing the member's settings, which shape the member's own app and are checked against a schema only the app has, and every change to a workspace's members and invites (see Rules). The core refuses them to an agent, not only the tools. Connecting and disconnecting agents is not an operation: it needs a member's session, so an agent can't make another token.

History only goes forward. A revert, an undo, or a redo is a new change under the agent's name that names the changes it reverted (`reverts`), and each change it reverted names it (`revertedBy`). There is no putting a change back: to have a reverted change again, revert the change that reverted it, which `revert_changes` does like any other, however many reverts deep. `revert_changes` refuses a change that is already reverted and names the change to revert instead. Read history from the top down: `history_summary` lists the notes that changed, latest first, each with its count of changes and the lines they added and removed; `history` lists changes, each with the lines it added and removed (`added`, `removed`) and, unless `diffs` is false, its diff; `change_diff` reads one change's diff. All three take the same `noteIds`, `authors` and time range, and a summary counts only the changes that match. `history` filters by `authors`, so an agent's changes can be listed on their own and passed to `revert_changes`. `revert_author` reverts every change one author made that still stands, across the workspace or in `noteIds`, as one new change in each note by whoever asks. It leaves alone what somebody else already reverted and what the author undid themselves, and has stand again what the author reverted of others'. It covers ten notes a call and reads only those notes: while the answer's `next` isn't null, call again with it as `after`. A note that refuses the change, such as one it would make too long, is left as it was and named in `failed`, and the notes after it are still covered. A note the revert leaves with no text, such as one the author created, is named in `emptied` with the title it had: it stays, since there is no deleting a note yet. `ink revert-author` makes those calls itself until every note is covered. The web app does the same from an agent's entry on the Agents page and from History mode when it is filtered to one agent. A read-only token can list history and is refused the rest.

A link from one note to another is `[[<note id>]]` or `[[<note id>|display text]]` in the note's text (`docs/adr/0001-links-stored-by-id.md`). The text holds the id and never the title, so an agent gets the titles beside it: `read_note` answers with `links`, each linked note's id and its title now, or a null title for a note that doesn't exist or that the member can't see. An agent may write a link by title, `[[Title]]` or `[[Title|display text]]`, and `create_note` and `write_note` store it by the id of the one note with that title, ignoring case. When no note the member can see has the title, or several do, the write is refused and nothing is written; the message lists the ids to choose from. Only links the write introduces are looked up: one whose target, as written, was already in the text at `baseRevision` is left exactly as it is, so an agent is never refused for a link someone else wrote. A new target that reads as an id, twelve lowercase letters and digits, is taken for the note with that id, or failing that the one note with that title, and refused when it is neither. `linkTitles: "keep"` stores such text as written, for a note that means `[[` literally. Text in code, fenced or inline, is never read as a link. `backlinks` lists the notes whose text links to a note. `rebuild_links` makes the record behind it again from the notes' text; every write keeps that record, so it is only for one changed some other way, and it needs the admin role.

Most clients take a URL and a header:

    claude mcp add --transport http common-ink https://commonink.app/mcp --header "Authorization: Bearer $INK_TOKEN"

## The `ink` command

    INK_TOKEN=cink_... INK_URL=https://commonink.app npm run ink -- notes [--folder <id>] [--since 2026-10-01]
    npm run ink -- read <id> [--revision N]
    echo "# Title" | npm run ink -- create [--folder <id>]
    echo "# Title\n\nmore" | npm run ink -- write <id> --base <revision> [--link-titles keep]
    npm run ink -- backlinks <id>
    npm run ink -- links-rebuild
    npm run ink -- move <id> --folder <folder id>
    npm run ink -- folders
    npm run ink -- folder-create "Plans" [--parent <folder id>]
    npm run ink -- folder-rename <folder id> --name "Plans"
    npm run ink -- folder-delete <folder id>
    npm run ink -- changed [--note <id>,<id>] [--author agent:<id>] [--from 2026-10-01] [--to 2026-10-08]
    npm run ink -- history <id>
    npm run ink -- diff <id> --change <n>
    npm run ink -- changes [--note <id>,<id>] [--author agent:<id>] [--from 2026-10-01] [--to 2026-10-08]
    npm run ink -- authors
    npm run ink -- label <id> --revision <n> --name "Draft"
    npm run ink -- revert <id> --revision <n>
    npm run ink -- revert <id> --changes <n>,<n>
    npm run ink -- revert-author agent:<id> [--note <id>,<id>]
    npm run ink -- undo <id>
    npm run ink -- redo <id>
    npm run ink -- workspaces                 # role is admin, editor, viewer, or guest
    npm run ink -- members

Add `--workspace <id>` when the member is in more than one workspace.
