# 10. Third-party plugins run in frames, and what they may do is a record the server checks

Status: accepted by the owner of #16 on 2026-10-11, without the maintainer. Issue 1 left several of these open; overrule them here if they are wrong.

Until now every plugin was a JavaScript value run in the app's page and handed a `host`. The stack added refusals for plugins that aren't Common Ink's own as it went, and `docs/plugins.md` kept a list of what such a plugin could still reach. Every item on that list had one cause: code in the app's page can read the page, call `fetch` with the member's session, and reach `window`. A refusing `host` object is a courtesy to such code. So "third-party plugin code cannot reach the workspace outside allowed operations" is true only if that code is not in the page.

## Where the code runs

In the frame an HTML embed runs in (#40's machinery): a shell the Worker serves under `sandbox allow-scripts; default-src 'none'; frame-src 'none'`, and inside it a `srcdoc` frame on an origin of its own. The app builds the frame's whole document from the plugin's stored code and talks to it over a `MessagePort` it makes for that frame. The port is the plugin's identity. Every message is a request, parsed against a strict schema and decided in one function from the workspace's record.

We considered a Worker (no DOM, so nothing to draw with, and a Worker made from the app's page shares its origin unless it is made inside such a frame anyway), and running code in the page behind a membrane (a proxy around `host` is the same courtesy, with more surface). A frame is the one thing a browser gives that takes ambient authority away.

What follows from it: a third-party plugin can contribute only what can cross a port. Commands (a title and an id), views and embeds (a frame placed in the slot or below the line), and options (data). Editor extensions and completions can't, and are not offered. Built-in plugins stay in the page, trusted, on the same host.

## Identity and attribution

An install gets an id from the server, and that id is the plugin everywhere. `Actor` has a `plugin` kind: the plugin's operations come to their own address, `/api/workspaces/<id>/plugins/<install id>/ops`, under the member's session, and `perform` resolves the member's standing as for the member, then refuses everything not opened by a capability the record allows that plugin. So a plugin never exceeds its member, and a client that lies can't widen a plugin past the record. Its writes are recorded with `author_kind = 'plugin'` and the member in `author_owner`, so History filters and reverts them as an agent's.

The member's session can still perform anything as the member. The address does not defend against the app; it makes the app's honest path attributable and checked twice.

## The record

Installs, permissions and requests are tables of the workspace (migration 0021), outside settings. Only an admin installs, permits, locks, and uninstalls; a non-admin's yes is a request that allows nothing. Agents read the record and are refused every write to it: an agent reads notes other people wrote, and one talked into installing or approving a plugin would hand the workspace to whoever wrote the note.

- **The source is pasted text**, kept in D1, named by its SHA-256. Not an upload or a note: either could be changed by any editor after the admin read it. Not a URL: what runs must be what was approved.
- **An approval says what it is of**: the capability as declared and the code hash, as one string. `plugin.permit` refuses to allow anything without the hash of the code the admin was shown. Whether it stands is worked out when read, so there is nothing to clean up when a plugin is replaced, and installing the approved code again restores the approval.
- **Lock** means: takes no requests, and is not changed without unlocking in the same step. Admins are not ranked, so a lock is a guard against a slip and against requests, not against another admin.
- **Uninstall keeps a tombstone**, with the code gone, so History can still name the author of old changes.
- **Installed is available, not on.** Each member turns a third-party plugin on for themself. The spec says a plugin is available after an admin installs it; running someone's code in every member's browser on an admin's click goes further than that.

## Network

Off for every frame. A permission (`network`, with sites) turns it on by way of `plugin.frame`, which answers a token good once and for a minute; the Worker answers the shell at `/embed-frame/g/<token>` with those sites in `connect-src`, `img-src`, `media-src` and `font-src`. A token and not a variant address, for the reason recorded in #40. Script is never loaded from a site.

HTML embeds belong to notes, not to a plugin. Their network is one permission in the same record, under the subject `html`, with sites an admin lists: an allowance for the whole workspace. It was that or a permission per note, which would make every editor of a note a party to what an admin approved.

## What this does not do

WebRTC can't be blocked (#40), so a plugin can send out whatever it is permitted to read, with or without `network`. The install prompt says so, and it is the reason capabilities are few and narrow. A plugin's embeds run without a Run button once the member has turned the plugin on, on a config and body that any editor of the note wrote: that is the one path where someone who is not an admin steers code in another member's session, and the docs and the install prompt say so. A plugin's page, tab and embed are labelled `<name> plugin:`, its embeds are written `::x-name{}`, and it can't take a built-in plugin's name; a misleading name of its own is still the admin's to catch.
