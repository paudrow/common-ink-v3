# Connecting an agent

A member connects an agent and gets a token for it. The agent sends the token to `/mcp` (the MCP server) or uses the `ink` command, which calls `/mcp`. Both go through the same operations as the web app (`src/core/operations.ts`), as the member who connected the agent.

## Rules

- An agent acts with its member's role in each workspace, and no further. A viewer's agent can read and cannot write.
- Its changes are recorded with the agent as author (`author_kind = 'agent'`, `author_id` = the agent's id), under the name the member gave it, so they can be told apart from the member's own.
- A member who loses access to a workspace takes their agents' access with them: every call checks the member's membership at the time.
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

Tools: `list_workspaces`, `list_notes`, `read_note`, `create_note`, `write_note`, `note_history`, and for history `history`, `history_authors`, `activity`, `label_revision`, `revert_note`, `revert_changes`, `reapply_changes`, `undo`, `redo`. Each takes an optional `workspace` id, which can be left out when the member belongs to only one workspace.

History tools never rewrite the record. A revert, an undo, or a redo is a new change under the agent's name that names the changes it took back out (`reverts`), and each change it took out names it (`revertedBy`). `history` filters by `authors`, so an agent's changes can be listed on their own and passed to `revert_changes`. A read-only token can list history and is refused the rest.

Most clients take a URL and a header:

    claude mcp add --transport http common-ink https://commonink.app/mcp --header "Authorization: Bearer $INK_TOKEN"

## The `ink` command

    INK_TOKEN=cink_... INK_URL=https://commonink.app npm run ink -- notes
    npm run ink -- read <id> [--revision N]
    echo "# Title" | npm run ink -- create
    echo "# Title\n\nmore" | npm run ink -- write <id> --base <revision>
    npm run ink -- history <id>
    npm run ink -- changes [--note <id>,<id>] [--author agent:<id>] [--from 2026-10-01] [--to 2026-10-08]
    npm run ink -- authors
    npm run ink -- activity [--timezone America/Chicago]
    npm run ink -- label <id> --revision <n> --name "Draft"
    npm run ink -- revert <id> --revision <n>
    npm run ink -- revert <id> --changes <n>,<n>
    npm run ink -- reapply <id> --changes <n>
    npm run ink -- undo <id>
    npm run ink -- redo <id>
    npm run ink -- workspaces

Add `--workspace <id>` when the member is in more than one workspace.
