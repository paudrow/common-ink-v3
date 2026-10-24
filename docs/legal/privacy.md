> **Draft, needs legal review.** Every statement about what Common Ink stores, sends or deletes was checked against the code on 19 October 2026, and what it counts on 23 October 2026. Text in [square brackets] is a business decision or promise the maintainer has to confirm or fill in.

# Privacy policy

Common Ink keeps what it needs to run your notebook, and shows your notes only to the people and agents you let in. This page says what Common Ink stores, why, who else handles it, how long it is kept, and how you get a copy or have it deleted.

Effective [date].

## Who runs Common Ink

Common Ink, at commonink.app, is run by [operator's legal name] ("we", "us"). Write to [contact address] about anything on this page.

## What Common Ink stores

### Your account

When you sign in with Google, Google tells Common Ink your email address and your name. Common Ink keeps those two things, the time you first signed in, and a count of the times you signed out everywhere. It does not keep your profile picture or a copy of your Google password.

A signed-in browser holds a session cookie. The session itself lives in that cookie, and the database keeps nothing per session.

### What you put in a workspace

- Workspaces, folders and the role of each member (admin, editor or viewer).
- Notes: their text, title, folder, whether they are private to you, and whether they are archived or in Trash.
- Every change to a note: what changed, when, and who made it (a member, an agent or a plugin). This is the note's history, which lets anyone who can see the note see and revert its changes.
- What Common Ink works out from a note's text so it can search and list it: its todos, tags, links, mentions of people, which uploads it refers to, and a search index of its words.
- Uploads: the file's name, type, size, a fingerprint of its contents (SHA-256), who uploaded it, and its bytes. The bytes are kept in Cloudflare R2. The rest is in the database.
- What each member keeps for themselves: their settings, pinned notes, daily notes, completed recurring todos, and the time they last read the workspace.

### Sharing

- Invites: the email address invited, the role offered, and who invited them.
- Grants: who shared a note, folder or upload with whom, by email address, and with what access. A grant can name an email address that has not signed in yet.
- Share links: the link's secret, what it opens, and who made it.

### Agents and connected apps

- An agent is a program you connect to act for you, such as Claude or ChatGPT, or a script with a token. Common Ink keeps its name, the limits you set (which workspace, which folders, read only, when it expires), when it was made and last used, and when it was disconnected. It keeps only a hash of the agent's token, never the token itself.
- An app that connects through a sign-in (OAuth) also has the name and return addresses it registered with, and a hash of the network address it registered from, which is used only to count registrations. Its access codes and tokens are kept only as hashes.

### The web clipper

The Common Ink Clipper for Chrome sends what you choose to clip: the page's text, its address, and its images and files, which your browser downloads from the sites they are on. They become a note and uploads like any other. Common Ink keeps a hash of the clipper's token, the extension's ID, and when it was allowed and last used.

### Plugins

For each plugin installed in a workspace, Common Ink keeps its code and description, who installed it, and what admins allowed it to do. A plugin you are writing is kept as your draft until you install it. A plugin can keep its own settings in your browser.

### Your calendar and contacts

If you connect Google Calendar or Google Contacts, Common Ink keeps the access tokens Google gives it, the account's email address, and which permissions you agreed to. The tokens are encrypted (AES-256-GCM) before they reach the database, and the key is not in the database.

Common Ink does not keep your events or contacts. It reads them from Google each time you or your agent ask, and shows them to you alone. A note that refers to an event or a contact holds only a reference to it, with the label you wrote. Nobody else in a workspace can see that you connected a calendar or contacts, or anything in them.

## Google user data

### What Common Ink asks Google for, and when

Signing in asks for `openid`, `email` and `profile`, to learn who you are. Common Ink keeps only your email address and name from them.

Signing in also asks, in the same Google screen, for your calendar and your contacts, so they work without a separate step. Google lets you untick each one. You can connect or reconnect them later from Common Ink.

| Scope | What Common Ink does with it |
|---|---|
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Lists your calendars, and whether you may change each one. |
| `https://www.googleapis.com/auth/calendar.events` | Shows your events, and creates and changes events when you or your agent ask. |
| `https://www.googleapis.com/auth/contacts.readonly` | Shows your contacts. |
| `https://www.googleapis.com/auth/contacts` | Asked for only when you first choose to edit a contact. Creates and changes contacts, and their photos, when you or your agent ask. |

A change is sent to Google with your own access, so Google records it as yours. It is not part of a note's history and can't be reverted in Common Ink.

If Google answers for an account that can't use Common Ink, or Common Ink can't keep what Google sent, it asks Google at once to end the calendar and contacts access it was given.

### Limited Use

Common Ink's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. In plain words, for what Common Ink does:

- Your Google data is used only for features you can see in Common Ink: signing you in, and showing and changing your calendar and contacts.
- It is passed on only to provide those features at your request: to you, and to an agent you connected when that agent asks for your events or contacts. It is also passed on where the law requires it, for security, or [in a merger or sale, with your consent first].
- It is never sold, never used for advertising, and never used to decide creditworthiness.
- [No person at Common Ink reads it unless you ask, it is needed for security, or the law requires it.]

You can disconnect your calendar and contacts in Common Ink. That deletes the tokens and asks Google to end the access. You can also remove Common Ink's access in your [Google Account](https://myaccount.google.com/connections).

## How Common Ink uses what it stores

- To sign you in and show you the workspaces you belong to.
- To store, search, show and sync your notes and files, for you and for the people and agents you share them with.
- To read and change your calendar and contacts when you or your agent ask.
- To keep Common Ink secure and fix problems.

## What Common Ink counts

Common Ink counts how it is used, so we know what to build and fix. It does this in two ways, and neither counts anything a note says.

**The site's public pages** (the home page, the docs, this policy and the terms) use [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/). It counts visits, the page visited, the site that linked to it, and the visitor's country, browser and device type, and how fast the page loaded. It sets no cookie, keeps nothing in your browser, and does not follow you to other sites. Those pages load its script from `static.cloudflareinsights.com`. The app's pages, a page a share link opens, and the frames embeds and plugins run in never load it.

**The app** counts on the server, as things happen, and loads no script for it. Each count says what happened (such as signing up, opening the app, making or editing a note, adding or completing a todo, recording, transcribing, clipping a page, inserting a timer, deleting a tag, or which tool an agent called), in which workspace, whether a person, an agent or a plugin did it, and when. It names who did it only by a code made from their account with a key kept on the server: a pseudonym, the same for one person each time, which nobody without that key can turn back into a person. A count never holds what a note, a title, a tag, a file name, a folder name or an email says, and never an email address or a name. The counts are kept in Cloudflare Workers Analytics Engine and read only in aggregate, on a page only Common Ink's operators can open: how many people were active each week, how many signed up, how much people and agents each wrote, and which features are used.

Common Ink sends your notes, files, calendar and contacts to no AI model of its own. The Worker has no AI service connected. An agent you connect is different, and is covered below. [We don't sell or rent your information, use it for advertising, or let anyone train AI models on it.]

## Who can see your content

- **You.** A private note or upload is seen by you alone, even in a shared workspace.
- **The members of a workspace**, according to their role. A guest sees only the notes, folders and uploads shared with them.
- **Anyone with a share link** you made for a note or a folder, until you turn the link off. A link can be for anyone, or for anyone signed in to Common Ink.
- **Agents you connect.** An agent reads and writes with the access you gave it, never more than your own. What it reads goes to the company that runs it, such as Anthropic or OpenAI, under that company's terms.
- **Plugins** an admin approved. A plugin reads and changes only what its permissions allow. A plugin allowed to reach the network can send what it reads to the sites it names. A plugin given full trust runs in your session and can do anything you can.
- **Our service providers**, below.
- **The law.** [We may disclose information when we believe the law requires it.]

## Service providers

- **Cloudflare** runs Common Ink: the Worker that answers every request, the D1 database, the R2 bucket that holds uploads, the Worker's logs, the counts of how the app is used (Workers Analytics Engine), and Web Analytics on the site's public pages. Its data centers may be outside your country.
- **Google** signs you in, and holds your calendar and contacts if you connect them.

The Worker sends requests to no other service. Some features make your browser talk to other sites directly:

- The site's public pages load Cloudflare Web Analytics from `static.cloudflareinsights.com` and send it the visit.

- Embeds of YouTube videos, posts on X, and Bluesky posts load from those services (YouTube's from `youtube-nocookie.com`).
- The Weather plugin, when you add it to your Dashboard, sends your browser's location or a place you type to Open-Meteo and BigDataCloud.
- Night shift, when it follows sunset, sends the place you type to Open-Meteo to find its position.
- The clipper downloads a clipped page's images and files from their sites, and asks YouTube and X to describe a clipped video or post.

## Logs

The Worker writes a log line when something fails. Before a line is kept, `src/core/logs.ts` removes tokens, cookies, email addresses, share link secrets, sign-in codes, and anything an error quotes, which is where note text would be. Cloudflare's own record of each request, which would include its address, is turned off, because an address can hold a share link's secret. Cloudflare keeps the Worker's logs for 7 days on the Workers Paid plan [confirm the plan]. Cloudflare may also keep records such as IP addresses for its own security, under its own policy.

## Cookies and browser storage

Common Ink sets two cookies, both needed to sign in:

- `__Host-ink_session` keeps you signed in, for 30 days.
- `__Host-ink_google` protects the step where Google signs you in, and lasts 10 minutes.

Your browser's local storage keeps preferences such as the workspace you last opened and the panels you had open, and what plugins store for you. Common Ink uses no analytics, advertising or tracking cookies. The app's pages load no scripts from other sites, and an embed runs in a frame of its own. The site's public pages load one, Cloudflare Web Analytics, which sets no cookie (see What Common Ink counts).

## How long Common Ink keeps it

- Your account and workspaces: until you delete them.
- Notes and uploads in Trash: 30 days, then the hourly job removes them for good, a note with its history. Removing one from Trash yourself removes it at once.
- An upload that never finishes: removed by the hourly job after a day with nothing sent to it.
- A note's history: as long as the note.
- Sessions: 30 days, or until you sign out everywhere.
- An app connected by sign-in: its access token lasts an hour and its refresh token 30 days. A new refresh token replaces the old one each time it is used. The hourly job deletes codes and tokens a day after they expire.
- The clipper: 90 days, then you allow it again.
- Google tokens: until you disconnect, or until Google stops accepting them, when they are deleted.
- Logs: 7 days.
- Counts of how the app is used: three months, which is as long as Workers Analytics Engine keeps them. Web Analytics on the public pages is kept by Cloudflare under its own policy, with no cookie and nothing that names you.
- Backups: the database's history (Cloudflare D1 Time Travel) goes back 30 days. Anything deleted from the database stays in that history until it is 30 days old, and then it is gone. Uploads' bytes have no backup. When Common Ink deletes them from R2, they are gone at once.

## Deleting your data

**Your account.** You delete your account in Settings, under Account. It removes your name and email, your settings, your private notes and private uploads, your calendar and contacts connection (once your account is gone, Common Ink asks Google to end its access), your clipper, the invites you sent and those sent to you, the grants waiting for your email, and every workspace you are the only member of. Your agents stop at once. Your changes in workspaces shared with others stay, attributed to "A former member", with no name or email, and so do the agents that made changes there, as "A former member's agent". Where someone else mentioned you in their notes, the mention keeps your name as they wrote it: that text is theirs. If you are the only admin of a workspace that others are in, you first make another member an admin, or delete the workspace.

**A workspace.** An admin deletes a workspace in Settings. From that moment nobody reaches it: its members, invites, grants, share links and the agents limited to it go at once. Its notes, their history, its uploads and their bytes, and its folders are then erased, most often in the same request, and otherwise by the hourly job.

What a deletion removes from the database stays in the backup history until it is 30 days old. Counts of how the app was used are not deleted with an account or a workspace: they stay, under the same pseudonym and workspace id and with nothing that names you, until they are three months old.

## Getting a copy of your data

In any workspace, you can download a zip of every note and file you can read there. The notes come as Markdown and the files as they were uploaded, in their folders. What is in Trash is left out: restore it first to include it.

## Your rights

[You can ask us to see, correct, export or delete your information by writing to [contact address]. We answer within [30] days. Depending on where you live, you may have more rights, such as to object to how we use your information, and to complain to your data protection authority.]

## Security

All traffic to Common Ink is encrypted. Google tokens are encrypted before they are stored, and agent, clipper and app tokens are stored only as hashes. Every request is checked against what its person or agent may reach. To report a security problem, follow the [security policy](https://github.com/paudrow/common-ink-v3/blob/main/SECURITY.md). [If we learn of a breach that affects your data, we will tell you within [time].]

## Children

[Common Ink is not for children under [age], and we don't knowingly collect their information.]

## Changes to this policy

[If we make a material change, we will tell you in Common Ink or by email before it takes effect.] Before Common Ink uses Google user data in a new way, it will ask for your agreement to the new policy.
