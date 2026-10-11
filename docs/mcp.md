# Connecting an agent

A member connects an agent in the web app, on the Agents page (`/agents`, from the workspace menu or the "Go to Agents" command), and gets a token for it. The page shows the token once with the command to paste, lists the member's agents, and disconnects them. The agent sends the token to `/mcp` (the MCP server) or uses the `ink` command, which calls `/mcp`. Both go through the same operations as the web app (`src/core/operations.ts`), as the member who connected the agent.

## Rules

- An agent acts with its person's access in each workspace, and no further: their role where they are a member, narrowed by any grant that names them, and where they are a guest only what was granted. A viewer's agent can read and cannot write. A note its person can't see, such as another member's private note, is no note to the agent: it is in no listing, count, backlink, link title or history, and asking for it by id answers `not_found: No such note`, the same as for an id that was never a note's. Every listing of a note carries `access`, `edit` or `view`: what the agent may do with it.
- An agent can't share. Granting a note, a folder or an upload to someone, making or removing a link, making a note private, and reading who a note is shared with are for the member, signed in, in the Share dialog. A link can put a note before the whole internet, and none of this is a change in history that could be reverted.
- Its changes are recorded with the agent as author (`author_kind = 'agent'`, `author_id` = the agent's id), under the name the member gave it, so they can be told apart from the member's own.
- A member who loses access to a workspace takes their agents' access with them: every call checks the member's membership at the time. Removing a member, or their leaving, ends it on the agent's next call, and a change of role changes what the agent can do on its next call.
- An agent can see who is in a workspace (`list_members`: each member's person id, name, and role, and never an email, whatever its member's role) and can't change it. Inviting, changing a role, removing a member, leaving, and listing or revoking invites are for the member, signed in, on the Members page. Who is in a workspace decides who can read and change everything in it, that isn't a change in history that could be reverted, and an agent reads notes other people wrote, so one that was talked into it could invite a stranger as admin. The core refuses these to an agent whatever its member's role, not only the tools.
- A token expires after 90 days by default (`expiresInDays`, 1 to 365). An expired token is refused like an unknown one.
- A token can be pinned to one workspace (`workspaceId`: it sees only that workspace, even if its member is in others) and can be read-only (`readOnly`: it can read and can't change anything, even for an editor or admin). Both are checked in the core operations, not only in the tools.
- Names aren't unique: a member can have several tokens named "Claude", told apart by an optional `label` ("laptop"). Each token is its own author in history.
- Disconnecting an agent stops its token at once. Only a SHA-256 hash of a token is stored; the token is shown once, when the agent is connected.
- A token works only in an `Authorization: Bearer` header. It is not a cookie, so a web page can't use it.

- An agent can archive a note, move it to Trash and restore it, with edit on the note, since each can be taken back. It can't remove a note from Trash for good: that takes the note's history with it and nothing brings it back, so it is for the member, signed in, on the Trash page.

- An agent can list uploads, read one's details and where it is used, upload a file, download one, move, archive, trash and restore one, with the same access its member has. It can't remove an upload from Trash for good or make one private: both are for the member, signed in.

- An agent reads its member's data sources and no other member's: `list_events`, `list_contacts` and `read_record` answer for the member who connected the agent, whatever their role, and there is no argument that names anyone else. `update_event` changes the member's real calendar, as the member, and a read-only token is refused it and `refer_record`. A change to an event is not in Common Ink's history and can't be reverted from here. An agent can't connect or disconnect a data source: agreeing is the member's, in their browser. What an agent reads from a data source is the member's private data, and an agent that writes it into a shared note has shared it (`docs/adr/0006-data-sources-are-one-persons.md`).

## Connect and disconnect (signed in, from Common Ink's own origin)

    POST   /api/agents        {"name": "Claude"}   ->  201 {"agent": {...}, "token": "cink_..."}
    GET    /api/agents                             ->  {"agents": [...]}   (never the token; shows expiresAt, workspaceId, readOnly)
    DELETE /api/agents/<id>                        ->  204

Optional fields on the POST: `label` (up to 60 characters), `expiresInDays` (default 90, at most 365), `workspaceId` (one of the member's workspaces), `readOnly` (true or false). For example, a read-only token for one workspace that lasts 30 days:

    {"name": "Claude", "label": "laptop", "expiresInDays": 30, "workspaceId": "<workspace id>", "readOnly": true}

## MCP

`POST /mcp` with `Authorization: Bearer cink_...` and `Content-Type: application/json`. Streamable HTTP, stateless: one JSON-RPC message (or a batch) per POST, answered as JSON. No server-sent events, no sessions. Without a valid token the answer is 401.

Tools: `list_workspaces`, `list_notes`, `read_note`, `create_note`, `write_note`, `backlinks`, `rebuild_links`, `list_todos`, `todo_filters`, `set_todo`, `todo_history`, `daily_note`, `find_daily_note`, `rebuild_todos`, `move_note`, `note_history`, `search`, `list_tags`, for a note's state `archive_note`, `trash_note`, `restore_note`, `list_trash`, for the member's data sources `list_sources`, `list_events`, `update_event`, `list_contacts`, `refer_record`, `read_record`, for uploads `list_uploads`, `read_upload`, `move_upload`, `archive_upload`, `trash_upload`, `restore_upload`, `list_trashed_uploads`, for folders `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, and for history `history_summary`, `history`, `change_diff`, `history_authors`, `label_revision`, `revert_note`, `revert_changes`, `revert_author`, `undo`, `redo`, for the member's dashboard `list_pins`, `pin_note`, `last_visit`, and `list_members` for who is in the workspace. Each takes an optional `workspace` id, which can be left out when the member belongs to only one workspace. An argument a tool doesn't take is refused by name, not left out.

Every operation the web app performs has a tool with the same fields, and every tool has an `ink` command. `test/core/agent-parity.test.ts` reads the operation schema and fails when one is missing; an operation kept from agents on purpose is listed with its reason in `NOT_FOR_AGENTS` (`src/worker/mcp/tools.ts`). The two operations that carry a file's bytes, `upload.create` and `upload.open`, have no tool because a tool call carries only text: they are listed in `OVER_HTTP` beside it with the address an agent uses instead, and each has an `ink` command (see Uploads over HTTP). Two kinds are kept from agents: reading and writing the member's settings, which shape the member's own app and are checked against a schema only the app has, and every change to a workspace's members and invites (see Rules). The core refuses them to an agent, not only the tools. Connecting and disconnecting agents is not an operation: it needs a member's session, so an agent can't make another token.

History only goes forward. A revert, an undo, or a redo is a new change under the agent's name that names the changes it reverted (`reverts`), and each change it reverted names it (`revertedBy`). There is no putting a change back: to have a reverted change again, revert the change that reverted it, which `revert_changes` does like any other, however many reverts deep. `revert_changes` refuses a change that is already reverted and names the change to revert instead. Read history from the top down: `history_summary` lists the notes that changed, latest first, each with its count of changes and the lines they added and removed; `history` lists changes, each with the lines it added and removed (`added`, `removed`) and, unless `diffs` is false, its diff; `change_diff` reads one change's diff. All three take the same `noteIds`, `authors` and time range, and a summary counts only the changes that match. `history` filters by `authors`, so an agent's changes can be listed on their own and passed to `revert_changes`. `revert_author` reverts every change one author made that still stands, across the workspace or in `noteIds`, as one new change in each note by whoever asks. It leaves alone what somebody else already reverted and what the author undid themselves, and has stand again what the author reverted of others'. It covers ten notes a call and reads only those notes: while the answer's `next` isn't null, call again with it as `after`. A note that refuses the change, such as one it would make too long, is left as it was and named in `failed`, and the notes after it are still covered. A note the revert leaves with no text, such as one the author created, is named in `emptied` with the title it had: it stays, since there is no deleting a note yet. `ink revert-author` makes those calls itself until every note is covered. The web app does the same from an agent's entry on the Agents page and from History mode when it is filtered to one agent. A read-only token can list history and is refused the rest.

A link from one note to another is `[[<note id>]]` or `[[<note id>|display text]]` in the note's text (`docs/adr/0001-links-stored-by-id.md`). The text holds the id and never the title, so an agent gets the titles beside it: `read_note` answers with `links`, each linked note's id and its title now, or a null title for a note that doesn't exist or that the member can't see. An agent may write a link by title, `[[Title]]` or `[[Title|display text]]`, and `create_note` and `write_note` store it by the id of the one note with that title, ignoring case. When no note the member can see has the title, or several do, the write is refused and nothing is written; the message lists the ids to choose from. Only links the write introduces are looked up: one whose target, as written, was already in the text at `baseRevision` is left exactly as it is, so an agent is never refused for a link someone else wrote. A new target that reads as an id, twelve lowercase letters and digits, is taken for the note with that id, or failing that the one note with that title, and refused when it is neither. `linkTitles: "keep"` stores such text as written, for a note that means `[[` literally. Text in code, fenced or inline, is never read as a link. `backlinks` lists the notes whose text links to a note. `rebuild_links` makes the record behind it again from the notes' text, for every note in the workspace; every write keeps that record, so it is only for one changed some other way, and it needs the admin role.

A mention of a person is `@[[<person id>|<name>]]` for a member of the workspace and `@[[<name>]]` for anyone else, such as one of the member's contacts (`docs/adr/0007-mentions-are-ids-for-members-and-names-for-everyone-else.md`). `read_note` answers with `mentions`: each person once, with `member` true and their name now for a member, and otherwise the name as written. An agent may write `@[[Name]]` or `@[[id]]` for a member, and `create_note` and `write_note` store it as `@[[id|Name]]`; `list_members` gives the ids. A name several members have is refused with the ids to choose from. A name no member has is kept as written, a mention of someone by name. `mentionNames: "keep"` stores every mention as written. A mention gives nobody access, tells nobody, and makes no offer to share: that is the member's, in the app. Every reader of the note sees the name, so an agent writes only the name of a contact, never their email or anything else `list_contacts` told it. A mention on a todo's line assigns the todo: `list_todos` answers each todo's `assignees` and narrows by `assignee` (a member's id or a name) and `assignedToMe`, `todo_filters` lists the assignees there are, and `set_todo` takes `assign` and `unassign`.

A todo is a checkbox line in a note, with its options as tokens on the line: `- [ ] !! Call the bank due:2026-10-14 +Home` (`docs/todos.md`). An agent makes one by writing that line with `create_note` or `write_note`. `list_todos` lists the todos in the notes the member can see, open ones unless `includeCompleted`, narrowed by `project`, `tag`, `importance`, and a range of due days. Due dates are calendar dates and the server never works out today, so an agent passes the days it means: overdue is `dueTo` yesterday. `set_todo` checks one off or changes its importance, due date or project, by rewriting its line as a change under the agent's name. It takes `id`, `revision`, `line` and `text` as `list_todos` gave them, follows that line through every change made to the note since, and is refused as a conflict when the line itself was changed or deleted. A todo that reads the same is never taken for it, and the same call made twice changes nothing more. `rebuild_todos` and `rebuild_links` are one operation, for an admin: it makes the index behind `list_todos` and the record behind `backlinks` again for every note in the workspace, and answers only `done`. Notes written before there was an index need no rebuild: they are indexed the first time todos are listed.

A todo with `every:` recurs: `every:2w`, `every:mon,thu`, `every:3d-after-done`, `every:last-fri` (`docs/todos.md` has every rule). `set_todo` takes `every` to set or clear it. Checking a recurring todo off, by `set_todo` or by a `write_note` that checks its box, leaves it open with its next due date and files the checked line on the daily note of the agent's member, and the answer's `filed` says the day and the note. Both take `on`, the day it is for the member; left out, it is today in the zone the member's `daily.timeZone` setting names, or in UTC. `todo_history` lists each time a recurring todo was checked off and by whom. `daily_note` finds or makes the member's daily note for a day.

A member's dashboard keeps two things of theirs, outside any note (`docs/adr/0009-the-dashboard-is-a-view-and-keeps-two-things.md`). Pins: `list_pins` lists the notes the member pinned that they can see now and that are live, and the archived ones with `includeArchived`; it changes nothing, so a pin on a note the member can't see now is back when the note is, and `pin_note` pins one or takes its pin away for the member, which needs only that the member can see the note, changes nothing in it, and is refused to a read-only token. The last visit: `last_visit` answers `readUntil`, the time up to which the member marked the changes on their dashboard read, or null, and `now`. What they haven't read is `history` with `from` set to `readUntil` and `notAuthors` naming the member, which is how the dashboard makes its summary. Only the member marks changes read (`visit.mark` is kept from agents): an agent that did would hide from them what they haven't looked at. `find_daily_note` answers the member's daily note for a day when there is one and makes nothing, where `daily_note` makes it.

A note is live, archived, or in Trash, and every listing of it says which as `state` (`docs/adr/0005-a-note-has-a-state-beside-its-access.md`). `archive_note` archives and unarchives. An archived note is left out of `list_notes`, `list_todos`, `todo_filters`, `list_tags` and `search` unless `includeArchived` is true, and is read and written as any note. `list_notes` and `search` also take `includeArchived: "only"`, for the archived notes alone. `trash_note` moves a note to Trash, where `list_trash` lists it with `purgesAt`, the time it is removed for good, 30 days on. Until then `read_note` reads it, every change to it is refused as a conflict, and `restore_note` brings it back as it was. `revert_author` with `trashEmptied` moves the notes it left empty to Trash. `list_notes` with `updatedSince` also reports a note whose state changed since, and each note has `stateAt`. A removed note reads as no such note, and a link to it has a null title, exactly as for a note that never existed.

`search` finds notes by their text: every word must be in the note, each matching the start of a word, ignoring case and accents. `"a phrase"` matches in order, `#tag` narrows to notes with that tag, `+project` to notes with a todo in that project. `folderId` narrows to the notes in one folder (not the folders inside it; a folder the agent can't see is no such folder), `hasTodos` to notes with an open todo, and `sort` orders the results: `match` (title matches first, then the latest changed; the default), `recent`, `created` or `title`. Each result has the note and the first lines that matched, with `marks` saying where in each line. `list_tags` lists the tags of the notes the agent can see with how many notes have each, and `list_notes` with `tag` lists the notes under one.

An upload is a file in a workspace, kept in a folder as a note is, with a `state` and `access` as a note has. `list_uploads` lists the ones the agent can see, in one folder or all, without archived ones unless `includeArchived` is true. Each has its `id`, `name`, `type` (what its bytes are served as), `kind` (`image`, `video`, `audio` or `file`), `size` in bytes, and `width` and `height` for an image whose bytes say them. `read_upload` answers one upload with `usedIn`, the notes the agent can see that refer to it. A note refers to an upload with an embed on a line of its own that starts with the upload's id: `::image{<id> WIDTHxHEIGHT}`, `::video{<id> WIDTHxHEIGHT}`, `::audio{<id>}`, or `::file{<id>}` for anything else. The size is the room the app keeps for it, and the upload's name is never in the note. `read_note` answers with `uploads`, each upload the text refers to, with a null `upload` for one that doesn't exist or that the member can't see. `move_upload` puts one in another folder and `archive_upload` archives or unarchives it; neither changes what notes show. `trash_upload` moves one to Trash for 30 days, where `list_trashed_uploads` lists it with `purgesAt`, and the notes that refer to it say it is in Trash until `restore_upload` brings it back. Each of these needs edit on the upload.

Three operations on uploads are kept from agents, and the core refuses them whatever the tools do. Removing an upload from Trash for good (`upload.purge`) removes its bytes past recovery, as removing a note for good does its history. Making an upload private (`upload.setPrivate`) hides it from every other member and is not a change in history, as with a private note; an agent can't upload a file as private either. Reading an upload through a shared link (`shared.upload`) is for whoever holds the link, in a browser, with no token. Sharing an upload is kept from agents with all other sharing.

A member's calendar and contacts are data sources (`docs/adr/0006-data-sources-are-one-persons.md`). `list_sources` says which the member has and each one's `state` (`connected`, `needs_reconnect`, `not_connected`) and `writable`. `list_events` takes a span as two times and the `timeZone` whose days all-day events are matched by; an event's `when` is `{ allDay: false, from, to }` in milliseconds or `{ allDay: true, from, to }` with its first and last day. `update_event` takes the event's `sourceId`, `id` and `etag` as read and only the fields to change, and is refused with `conflict` when the event changed since, and with `forbidden` for an event whose `editable` is false. `list_contacts` lists contacts, narrowed by `query`. A note references a record with an embed that holds no copy of it: `refer_record` answers the `::event{<ref> <label>}` or `::contact{<ref> <label>}` to write, and `read_record` reads what a `ref` stands for now. The label is plain text in the note, which every reader sees. The ref leads to the record only for the member who made it.

Most clients take a URL and a header:

    claude mcp add --transport http common-ink https://commonink.app/mcp --header "Authorization: Bearer $INK_TOKEN"

## Uploads over HTTP

A file's bytes never travel in a tool call. An agent sends and fetches them at two addresses, with the same token as `/mcp` in the same `Authorization: Bearer` header. The core decides each request as it decides a tool call: the member's role and grants, a read-only token, and a token pinned to one workspace all hold here.

    POST /api/workspaces/<workspace id>/uploads
         Authorization: Bearer cink_...
         Content-Type: application/octet-stream
         Content-Length: <how many bytes>
         X-Ink-Upload: <encodeURIComponent of the JSON {"name": "cat.png", "folderId": "<folder id>"}>
         <the bytes>
      ->  201 with the upload, as list_uploads gives it

    GET  /api/workspaces/<workspace id>/uploads/<upload id>
         Authorization: Bearer cink_...
      ->  200 with the bytes

`name` is required. `folderId` is optional, and the file goes to Unsorted without it. Uploading needs edit on the folder, so a viewer's agent and a read-only token are refused with 403. A workspace the token can't reach, and an upload the member can't see, answer 404. No token, or one Common Ink doesn't know, answers 401. `Content-Length` is required (411 without it) and the body must be exactly that long. Any type but `application/octet-stream` is refused with 415.

A file can be at most 50 MB: a longer `Content-Length` is refused with 413 before any of the body is read. A workspace's uploads can be at most 1 GB together, those in Trash too, and an upload that would pass that is refused with 409.

What a file is served as is decided by the server from the ending of its name and its first bytes together, and never from a type the client declares. It is a picture, a video or a sound only when both agree: `.png`, `.jpg`, `.gif`, `.webp`, `.avif`, `.svg`, `.mp4`, `.m4v`, `.mov`, `.webm`, `.mp3`, `.m4a`, `.wav`, `.ogg` (`src/core/filetypes.ts`). Anything else, such as a PDF, an HTML page, or a file named `.png` whose bytes are not a PNG, is kept as it came and served as `application/octet-stream` with `Content-Disposition: attachment`, a download that no browser will show as a page. An SVG is served as `image/svg+xml` and also as a download, since opened as a page it could run script.

The GET honours `Range` (206 with `Content-Range`) and `If-None-Match` with the `ETag` of an earlier answer (304 with no body), and `HEAD` answers the headers alone. Every answer with an upload's bytes carries `X-Content-Type-Options: nosniff`, a `Content-Security-Policy` that sandboxes it, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-cache`. There is no other address for a file, and none that outlasts the request: access that was taken away stops the next one.

`ink upload` and `ink download` are these two requests. `upload` prints the upload and the line a note shows it with. `download` saves under the upload's name in the current directory, using only the last part of the name, or at `--out`, and never replaces a file that is there unless `--force true`.

## The `ink` command

    INK_TOKEN=cink_... INK_URL=https://commonink.app npm run ink -- notes [--folder <id>] [--since 2026-10-01]
    npm run ink -- read <id> [--revision N]
    echo "# Title" | npm run ink -- create [--folder <id>]
    echo "# Title\n\nmore" | npm run ink -- write <id> --base <revision> [--link-titles keep]
    npm run ink -- search 'budget "second quarter" #money +Home' [--folder <folder id>] [--archived true|only] [--has-todos true] [--sort match|recent|created|title] [--limit 20] [--offset 20]
    npm run ink -- tags [--archived true]
    npm run ink -- notes --tag money [--archived true|only]
    npm run ink -- archive <id>
    npm run ink -- unarchive <id>
    npm run ink -- trash <id>
    npm run ink -- restore <id>
    npm run ink -- trashed
    npm run ink -- backlinks <id>
    npm run ink -- links-rebuild
    npm run ink -- todos [--project Home] [--tag money] [--due-from 2026-10-01] [--due-to 2026-10-14] [--no-due true] [--importance 2,3] [--completed true] [--note <id>]
    npm run ink -- todo-filters
    npm run ink -- todo <id> --revision <n> --line <n> --text "- [ ] Call the bank" [--done true] [--importance 2] [--due 2026-10-14|none] [--add-project Home] [--remove-project Work]
    npm run ink -- todo <id> --revision <n> --line <n> --text "- [ ] Water the plants" --every 1w|none [--on 2026-10-11]
    npm run ink -- todo-history <id> --revision <n> --line <n> --text "- [ ] Water the plants every:1w done:2026-10-11x1"
    npm run ink -- daily [--on 2026-10-11]
    npm run ink -- daily-find [--on 2026-10-11]
    npm run ink -- pins
    npm run ink -- pin <id>
    npm run ink -- unpin <id>
    npm run ink -- visit
    npm run ink -- todos-rebuild
    npm run ink -- move <id> --folder <folder id>
    npm run ink -- uploads [--folder <folder id>] [--archived true]
    npm run ink -- upload cat.png [--folder <folder id>] [--name "Tabby.png"]
    npm run ink -- download <upload id> [--out cat.png] [--force true]
    npm run ink -- upload-info <upload id>
    npm run ink -- upload-move <upload id> --folder <folder id>
    npm run ink -- upload-archive <upload id>
    npm run ink -- upload-unarchive <upload id>
    npm run ink -- upload-trash <upload id>
    npm run ink -- upload-restore <upload id>
    npm run ink -- uploads-trashed
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
    npm run ink -- revert-author agent:<id> [--note <id>,<id>] [--trash-emptied true]
    npm run ink -- undo <id>
    npm run ink -- redo <id>
    npm run ink -- sources
    npm run ink -- events --from 2026-10-11 --to 2026-10-18 [--timezone America/Chicago]
    npm run ink -- event-update <source id> "<event id>" --etag '<etag>' [--title "Lunch"] [--location "Cafe"] [--description "..."] [--days 2026-10-14,2026-10-15 | --start 2026-10-14T17:00:00Z --end 2026-10-14T18:00:00Z]
    npm run ink -- contacts [sam]
    npm run ink -- refer <source id> "<record id>"
    npm run ink -- record <ref>
    npm run ink -- workspaces                 # role is admin, editor, viewer, or guest
    npm run ink -- members

Add `--workspace <id>` when the member is in more than one workspace.
