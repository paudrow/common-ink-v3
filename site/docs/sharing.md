# Workspaces and sharing

A workspace holds notes, folders, and files, and each member's role decides what they can do there. This page covers roles, invites, sharing with a person or a link, private notes, and signing out.

## Workspaces

The first time you sign in with Google, Common Ink makes a workspace for you. You join others when an admin invites you. The workspace menu at the top of the sidebar lists your workspaces and switches between them. It also holds **Members** and **Settings**.

## Roles

Every member has one of three roles:

| Role | Can |
| --- | --- |
| Viewer | Read notes |
| Editor | Read and change notes and folders |
| Admin | Everything an editor can, and manage members, plugins, and every grant |

Any member can see who the other members are on the **Members** page. A workspace always has an admin, so its only admin can't leave, be removed, or be given another role.

## Invite someone

Only an admin can invite.

1. Open **Members** from the workspace menu.
2. Under **Invite someone**, type the person's email and choose a **Role**.
3. Press **Invite**.
4. Copy the **Invite link** and send it to them.

Common Ink sends no email, so the link is how the person hears about it. The link admits only the email it was made for, whoever ends up holding it. The person becomes a member the next time they sign in with that email.

Pending invites are listed under **Invited**. Press **Link** to show an invite's link again, or **Revoke** to take it back. Inviting the same email again changes the role offered.

## Share a note or a folder with a person

To share a note, press **Share** in the inspector's **Info** panel, choose **Share settings** from the note's card menu in a folder's list, or run **Share this note…** from the command palette. To share a folder, choose **Share** from the folder's menu in the sidebar.

In the Share dialog, type an email in **Add a person by email**, choose **Can view** or **Can edit**, and press **Share**. That access is a grant.

- **Can view** lets them read the notes and their history.
- **Can edit** also lets them change the notes and make new notes in a shared folder.

A grant on a folder covers its notes and the folders inside it. A grant on a note or folder inside it wins for that note or folder, whether it gives more or less. A grant made for an email that hasn't signed in yet waits for them.

Any member who can edit a note or folder can share it. A guest can't share, and neither can an agent. An admin can see and remove every grant in the workspace on the **Sharing** page in the workspace menu, except grants on someone's private note.

### Guests

A grant to someone who isn't a member makes them a guest. A guest sees the notes and folders granted to them and nothing else of the workspace. They don't see its other notes, its members, or how many of anything there are. Notes shared with a guest outside any folder they can see appear under **Shared with me**.

A grant on a member can only narrow what their role allows, and only an admin can narrow a member. Nothing narrows an admin.

## Share a link

The **Link** section of the Share dialog makes an address that lets people read a note or a folder without being added. Choose who it opens for:

- **Anyone with the link**
- **Anyone signed in to Common Ink with the link**
- **Off**

A link is read-only. Its page shows the note's text and no author, history, or backlinks. A note or folder has at most one link. Changing who it opens for keeps the address, and turning it off stops the address at once. A file has no link of its own, so a link on its folder is how to share it by link.

## Private notes

Tick **Private** in the Share dialog to hide a note from every other member of the workspace, admins too. Only the member who made a note can make it private, and they become its owner.

- The owner shares a private note by adding people to the note itself, or by giving it a link. A folder's grants and links don't reach it.
- Only the owner can share it or make it not private, whatever their role.
- Making a note private takes away every grant and link that someone else put on it. The dialog says how many.
- An owner can't leave the workspace while they have private notes, other than daily notes.
- If an admin removes the owner, their private notes stop being private, so the workspace can still reach them.

### Mentioning someone in a private note

When you mention a member in a private note of yours, a notice says they can't see the note and offers **Share with** them, which lets them read it. A mention by itself shares nothing. To turn the offer off, turn off **Offer to share a private note with a member you mention in it** in Settings, or set `"mentions.offerToShare": false`.

## Leave or remove a member

To leave a workspace, press **Leave** on your own row of the Members page. You and your agents lose the workspace at once. What you wrote stays, under your name, and only an admin can bring you back.

An admin removes a member with **Remove** on their row. The member and their agents lose the workspace at once, the grants that named them go with them, and their private notes stop being private.

## Sign out everywhere

A session lasts 30 days in one browser. To end every session you have at once, in every browser and every workspace:

1. Open **Settings** and go to **Account**.
2. Press **Sign out everywhere…**.
3. Leave **Also disconnect my agents** ticked to disconnect your agents too, or untick it to keep them.
4. Press **Sign out everywhere**.

This signs out the browser you are using and your web clipper too. Agents use tokens, not sessions, so they stay connected only if you untick the box. See [Agents](/docs/agents).

An admin can do the same to a member with **Sign out** on the member's row, with **Also disconnect their agents**. The member stays in the workspace and can sign in again. An admin can do this to a person once a day.
