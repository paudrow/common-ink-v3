# Connecting an agent

A member connects an agent in the web app, on the Agents page (`/agents`, from the workspace menu or the "Go to Agents" command), and gets a token for it. The page shows the token once with the command to paste, lists the member's agents, edits what each may do, and disconnects them. The agent sends the token to `/mcp` (the MCP server) or uses the `ink` command, which calls `/mcp`. Both go through the same operations as the web app (`src/core/operations.ts`), as the member who connected the agent.

## Rules

- An agent acts with its member's role in each workspace, and no further. A viewer's agent can read and cannot write.
- Its changes are recorded with the agent as author (`author_kind = 'agent'`, `author_id` = the agent's id), under the name the member gave it, so they can be told apart from the member's own.
- A member who loses access to a workspace takes their agents' access with them: every call checks the member's membership at the time.
- A token expires after 90 days by default (`expiresInDays`, 1 to 365, or `"never"` for a token that doesn't expire). An expired token is refused like an unknown one.
- A token can be pinned to one workspace (`workspaceId`: it sees only that workspace, even if its member is in others) and can be read-only (`readOnly`: it can read and can't change anything, even for an editor or admin). Both are checked in the core operations, not only in the tools.
- Names aren't unique: a member can have several tokens named "Claude", told apart on the Agents page by the first characters of each token. Each token is its own author in history. An agent has a name and nothing else to call it by.
- What an agent may do can be changed after it is connected, by the member who connected it and nobody else: whether it is read-only, when it expires, and which workspace it reaches. The token stays the same, and the agent's next call is held to the edit. A disconnected agent can't be edited; an expired one can be given a new expiry.
- Disconnecting an agent stops its token at once. Only a SHA-256 hash of a token is stored; the token is shown once, when the agent is connected.
- A token works only in an `Authorization: Bearer` header. It is not a cookie, so a web page can't use it.

## Connect, edit and disconnect (signed in, from Common Ink's own origin)

    POST   /api/agents        {"name": "Claude"}   ->  201 {"agent": {...}, "token": "cink_..."}
    GET    /api/agents                             ->  {"agents": [...]}   (never the token; shows expiresAt, workspaceId, readOnly)
    PATCH  /api/agents/<id>   {"readOnly": true}   ->  {"agent": {...}}
    DELETE /api/agents/<id>                        ->  204

Optional fields on the POST: `expiresInDays` (default 90, at most 365, or `"never"`), `workspaceId` (one of the member's workspaces), `readOnly` (true or false). For example, a read-only token for one workspace that lasts 30 days:

    {"name": "Claude", "expiresInDays": 30, "workspaceId": "<workspace id>", "readOnly": true}

The PATCH takes the same three fields, each optional, and changes only the ones it is given: `expiresInDays` counts from the edit, and a null `workspaceId` lets the token reach every workspace again. Any other field is refused. These calls need a member's session, which an agent's token is not, so an agent can't connect, edit or disconnect an agent, its own included. They aren't workspace operations, so they have no tool and no entry in `NOT_FOR_AGENTS`: an agent belongs to a person, across their workspaces.

## MCP

`POST /mcp` with `Authorization: Bearer cink_...` and `Content-Type: application/json`. Streamable HTTP, stateless: one JSON-RPC message (or a batch) per POST, answered as JSON. No server-sent events, no sessions. Without a valid token the answer is 401.

Tools: `list_workspaces`, `list_notes`, `read_note`, `create_note`, `write_note`, `move_note`, `note_history`, for folders `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, and for history `history_summary`, `history`, `change_diff`, `history_authors`, `label_revision`, `revert_note`, `revert_changes`, `preview_revert`, `revert_author`, `undo`, `redo`. Each takes an optional `workspace` id, which can be left out when the member belongs to only one workspace. An argument a tool doesn't take is refused by name, not left out.

Every operation the web app performs has a tool with the same fields, and every tool has an `ink` command. `test/core/agent-parity.test.ts` reads the operation schema and fails when one is missing; an operation kept from agents on purpose is listed with its reason in `NOT_FOR_AGENTS` (`src/worker/mcp/tools.ts`). Two are kept from agents: reading and writing the member's settings, which shape the member's own app and are checked against a schema only the app has. The core refuses them to an agent, not only the tools. Connecting and disconnecting agents is not an operation: it needs a member's session, so an agent can't make another token.

History only goes forward. A revert, an undo, or a redo is a new change under the agent's name that names the changes it reverted (`reverts`), and each change it reverted names it (`revertedBy`). There is no putting a change back: to have a reverted change again, revert the change that reverted it, which `revert_changes` does like any other, however many reverts deep. `revert_changes` refuses a change that is already reverted and names the change to revert instead. Read history from the top down: `history_summary` lists the notes that changed, latest first, each with its count of changes and the lines they added and removed; `history` lists changes, each with the lines it added and removed (`added`, `removed`) and, unless `diffs` is false, its diff; `change_diff` reads one change's diff. All three take the same `noteIds`, `authors` and time range, and a summary counts only the changes that match. `history` filters by `authors`, so an agent's changes can be listed on their own and passed to `revert_changes`. `preview_revert` says what a revert would do and writes nothing: pass `revisions` for what `revert_changes` would do, `to` for what `revert_note` to that revision would do, or `author` for what `revert_author` would do to that one note, and it answers with the note's `revision` it was worked out at, the `revisions` that would be reverted, the `diff` from the note as it is to the note after, and `overlaps`, the later changes that still stand and edited the same lines. A revert keeps what those later changes did, on lines it otherwise returns to how they were, so read them first. It refuses what the revert itself would refuse, in the same words. `revert_author` reverts every change one author made that still stands, across the workspace or in `noteIds`, as one new change in each note by whoever asks. It leaves alone what somebody else already reverted and what the author undid themselves, and has stand again what the author reverted of others'. It covers ten notes a call and reads only those notes: while the answer's `next` isn't null, call again with it as `after`. A note that refuses the change, such as one it would make too long, is left as it was and named in `failed`, and the notes after it are still covered. A note the revert leaves with no text, such as one the author created, is named in `emptied` with the title it had: it stays, since there is no deleting a note yet. `ink revert-author` makes those calls itself until every note is covered. The web app does the same from an agent's entry on the Agents page and from History mode when it is filtered to one agent, after showing what it would change in each note (`preview_revert` with `author`). A read-only token can list history and preview a revert, and is refused the rest.

Most clients take a URL and a header:

    claude mcp add --transport http common-ink https://commonink.app/mcp --header "Authorization: Bearer $INK_TOKEN"

## The `ink` command

    INK_TOKEN=cink_... INK_URL=https://commonink.app npm run ink -- notes [--folder <id>] [--since 2026-10-01]
    npm run ink -- read <id> [--revision N]
    echo "# Title" | npm run ink -- create [--folder <id>]
    echo "# Title\n\nmore" | npm run ink -- write <id> --base <revision>
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
    npm run ink -- revert <id> --changes <n>,<n> --preview
    npm run ink -- revert <id> --revision <n> --preview
    npm run ink -- revert <id> --author agent:<id> --preview
    npm run ink -- revert-author agent:<id> [--note <id>,<id>]
    npm run ink -- undo <id>
    npm run ink -- redo <id>
    npm run ink -- workspaces

Add `--workspace <id>` when the member is in more than one workspace.
