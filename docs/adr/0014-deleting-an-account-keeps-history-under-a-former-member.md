# 14. Deleting an account keeps its history under a former member

Status: decided by the maintainer on 2026-10-19 (issue #79, "your data"). This records the choice, how it is enforced, and what it leaves open.

## Context

A person can delete their own account, and an admin can delete a workspace. Both remove everything from the app at once, and from backups as those expire (D1 Time Travel keeps 30 days). Deleting a workspace is plain: everything in it goes. Deleting an account is not. What a person wrote in a workspace they share is part of other people's notes: each note's history is a chain of changes, every one with an author, and a revert, a blame or an undo reads that chain. Something has to stand where the deleted person stood.

## The choice

Each deleted account gets a row of its own in `people`, made in the batch that deletes the account: a fresh random id, the name "A former member", an email at `.invalid` that is unique and that no mail reaches, and `former = 1`. Every reference to the person that is kept (the author of a change, a label, a completion, who last changed a note or put it in Trash, who installed a plugin, who made a grant or a link) is pointed at it. Their agents stay as that row's, renamed "A former member's agent", revoked, with their tokens gone, so history still says which agent did what. Then the person's own row is deleted, with their name and email.

| Option | Why not |
| --- | --- |
| One former member shared by every deleted account | The work of two people who left would read as one person's: a revert of "their" changes would take back both, and history would tie them together. |
| Null the author | Every reader of history, revert and blame would need a case for a change with no author, and the schema says an author is always there. Two people's work would still run together. |
| Delete their history | Other people's notes are made of it. A note's text would no longer be the sum of its changes, so reverts and blame would break, and someone else's work would vanish with the person who left. |

A fresh id per account keeps two people apart, and the former member's row says nothing of who they were.

## What goes and what stays

`src/core/erase.ts` lists every column that can hold a person's id (`PERSON_COLUMNS`) or a workspace's (`WORKSPACE_COLUMNS`), with what deleting one does to it, and the statements are made from those lists. `test/core/erase.test.ts` reads the schema and fails for a column that holds a person or a workspace and isn't listed, so a new table can't quietly keep someone. A second test seeds something of a person's in every table, deletes the account, and looks in every column of every table for their id and their email; only the columns listed as kept may still hold either.

- **Gone:** private notes and uploads and their files, settings, pins, last visits, membership, invites they made or that were for them, grants that named them, plugin drafts, requests and trust, data sources (ended at Google once the deletion has gone through, so a refused deletion keeps them; a refused revoke is logged and the tokens are deleted all the same), source references, the clipper, OAuth requests, codes and tokens, and every workspace they were the only member of.
- **Kept, under the former member:** their changes, labels, completions, notes and uploads that were not private, grants and share links they made, plugins they installed and permissions they decided.
- **Kept as written:** a mention of them in someone else's note. It is the writer's text, and reads as a name, as a mention of someone who was never a member does.

Deleting the person's row is the last statement, and the database refuses it while a column declared to refer to `people` still does, so a declared reference the lists missed fails the deletion rather than outliving it.

## Deleting a workspace

One batch marks the workspace (`deleting_at`) and deletes everything that lets anyone in: members, invites, grants and links, frame grants, and agents limited to it with their tokens. Its uploads are marked as being removed, so none can be read. Every way into a workspace already asks for a membership or a grant, and `standingIn` and `standingByLink` also refuse a marked workspace. Its notes, uploads, folders and plugins are then erased a chunk at a time, as much as fits in the request, and the hourly timer carries on with any workspace still marked. Each chunk is one batch, or the steps `finishRemoving` already takes for an upload's bytes, so a run stopped anywhere is carried on by the next.

## Consequences

- A person who deletes their account and signs in again with Google is a new person, with a new workspace of their own.
- A grant they made for an email nobody has signed in with yet is taken away when that person signs in, as one whose maker can no longer share is (`MAKER_SHARES`): a former member is a member of nothing.
- Account deletion is one batch whose re-pointing statements scan tables such as `changes` by columns with no index. That is a few seconds at most at this size, once per deletion; an index would be the fix if it grows.
- Open: whether a mention of a deleted person should be rewritten. It is kept as written for now.
