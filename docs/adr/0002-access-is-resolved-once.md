# 2. Access is resolved in one place, and a note someone can't see is no note

Status: accepted by the owner of #15 on 2026-10-11, without the maintainer. Issue 1 left several of these open; overrule them here if they are wrong.

## Context

Until #15 a member of a workspace could see every note in it, and a dozen queries said so on their own. Grants, guests, private notes and share links make what someone sees a question about each note. If each operation answered it for itself, one of them would get it wrong, and the one that did would leak a title, a count or an id.

## Decision

**One rule.** `resolve` in `src/core/access.ts` is a pure function from a role (or none), the grants that reach the actor from the item outward, and whether a private note is theirs, to `none`, `view` or `edit`. It is tested against a table that writes out every case. `canShare` beside it says who may share.

**One sight per operation.** `perform` works out the actor's `Sight` once (`src/core/standing.ts`): their role and the grants that name them, or for a share link's holder that link's grant alone. Nothing else in the core decides access.

**Two ways to ask, and no third.** A single note or folder is read only by `loadNote(ctx, id, need)` and `loadFolder(ctx, id, need)`, which take what the caller needs of it and answer `not_found` for an item the actor can't see, in the words used for one that doesn't exist. Every query that lists notes, or reads anything by way of a note (a change, a link, a count), carries `SEEN(alias, param)`, the one SQL condition for "this actor can see this note", bound to `sight.bind`. `test/core/access-matrix.test.ts` runs every operation as nine kinds of actor and their agents against every kind of item, compares each outcome with a written table, and searches every answer for any trace of what that actor can't see. An operation with no row there fails it.

**The choices issue 1 left open.**

| Question | Choice | Why |
|---|---|---|
| Can a grant raise a member above their role? | No. A viewer granted edit on a note stays a viewer. | Issue 1: "narrowed by grants for members". A role is the ceiling; raising someone is changing their role. |
| Does a grant narrow an admin? | No. | An admin manages every grant, so one that bound them would bind nobody. The one thing hidden from an admin is someone else's private note. |
| Who may name a member in a grant, or take such a grant back? | An admin. An editor shares with people outside the workspace. | Narrowing a colleague is deciding who in the workspace sees what, which is the admin's (story 7). An owner naming a member on their own private note is the exception: there it lets them in. |
| Can a guest share on what they were given? | No, whatever their grant. | "An editor can create a grant on a note or folder they can edit": an editor is a member. |
| Who can make a note private? | Only the member who made it. | Otherwise any editor could hide every note in the workspace from its admins. |
| What becomes of the grants and links other people put on a note when its owner makes it private? | They are deleted in the same batch, and the owner is told how many, before and after. What the owner put there stays. | Left in place they stay live where their makers can no longer see or revoke them: an admin's public link would keep serving a note the admin can't open. Refusing instead would leave an editor-owner waiting on a narrowing grant only an admin can take back. |
| Who shares a private note? | Its owner, whatever their role, and nobody else. A viewer who owns one shares it and can share nothing else. | Nobody else can reach it, so nobody else could. |
| Does a grant or link outlast its maker's right to make it? | Yes, once it has taken effect. A grant or link an editor made stays live after they are demoted or removed. An admin sees and revokes them on the Sharing page. Only a grant still waiting for its email is dropped. | As an accepted invite outlasts the admin who made it, and as a shared folder in other tools outlasts the sharer. The cost: removing someone does not undo what they shared, so an admin has to look. |
| Is privacy a folder's too? | No, a note's only. | Issue 1 and `CONTEXT.md` speak only of private notes. |
| What reaches a private note from above? | Nothing: not a folder's grant, not a folder's share link. | It is hidden from members, so it can't be open to a guest of the folder it is in. |
| What happens to a private note when its owner goes? | They can't leave while they own one. An admin removing them makes their private notes ordinary ones, and each keeps whose it was, when, and who removed them, which the Share dialog shows. | A note nobody can reach is lost, and removal can't wait on notes the admin can't see, or a member could make themself unremovable. The cost is real: an admin can read a member's private notes by removing them. It is not silent, and the member has lost access to the workspace anyway. |
| What does a removed member keep? | Nothing. The grants that named them go too. | A grant that narrowed them would otherwise let them back in as a guest. |
| What can a share link do? | Read, never edit. One per item, an unguessable address that stays the same when its kind changes and stops when it is taken away. | Stories 35 and 36 say "read" and "open". Editing by whoever holds an address has no author to record. |
| What does whoever holds a share link see? | The text of the note, or of the notes in the folder. No author, history, backlinks, members, or workspace name, and titles only for linked notes the link also covers. Embeds don't run and media doesn't load. | The safe reading: nothing a member didn't choose to publish. |
| Does a signed-in share link need the person to be allowed to sign in? | Yes. `ALLOWED_EMAILS` says who can sign in to this Common Ink at all, and the link asks only that they have. Opening one makes them nothing in the workspace. | The list is the deployment's gate, not a workspace's. |
| Can an agent share, make a link, or make a note private? | No. All of it is the member's, signed in. | As for members (#14): it isn't in history, so it can't be reverted, and an agent that was talked into it could publish a note. |
| Can an admin delete a folder that holds only notes they can't see? | Yes, and those notes go to Unsorted. | Refusing would tell them the folder isn't empty. |
| Does `links.rebuild` cover notes the admin can't see? | No. | Its count and its cursor would name them. Every write keeps the record anyway. |

**Where this narrows issue 1.** Three of the choices above read issue 1 more narrowly than its words. Each is a choice, not a finding, and behaviour follows the choice.

1. Issue 1 says access comes "from the actor's role, narrowed by grants for members", with no exception. Here nothing narrows an admin. An admin can revoke any grant that names them, so a narrowing one would hold only until they noticed it. If the maintainer wants admins narrowable, `resolve` loses one line (`if (role === "admin") return "edit"`) and the table in `test/core/access.test.ts` says what changes.
2. Story 34 says "as a member, I want to make a note private", of any note. Here only the member who made the note can. Read literally, any editor could make every note in the workspace private to themself and hide it from its admins and its author. If the maintainer wants the literal reading, `canSetPrivate` in `src/core/sharing.ts` is the one place.
3. Story 7 says an admin manages "grants across the workspace". Here the admin's list leaves out grants on a private note that isn't theirs, and they can't revoke them. Listing them would tell the admin the note exists, its title, and who it is shared with, which is what "hidden from admins too" (story 34, `CONTEXT.md`) rules out. The two stories conflict, and privacy won.

## Consequences

- A new operation that reads a note has to go through `loadNote` or carry `SEEN`, and has to be given a row in the matrix. That is the whole of what later features (search, uploads, the dashboard, todos) need from this: "which notes may this actor see" is `SEEN("n", "?k")` with `ctx.sight.bind`, and "what may they do with this one" is `noteLevel(ctx.sight, row)`.
- `NoteSummary.folderId` is null, and `folder.list`'s `unsortedId` is null, for a guest who can't see that folder. A hidden folder's id is not told any more than its name.
- A guest who is invited as a member has the role they were offered from the moment they take the invite up, and the grants that made them a guest are deleted in the same batch: left in place they would narrow a role nobody chose to narrow. A grant on a private note is kept, since it is what lets them in.
- A grant that waited for its email takes effect in one statement that also checks its maker may still share the item (`MAKER_SHARES` in `src/core/sharing.ts`, the SQL form of `canShare`). The matrix test holds it to the same table.
- Access costs one more query an operation for a member (the grants that name them), and one more again when a grant is on a folder or the actor is a guest (the workspace's folders).
