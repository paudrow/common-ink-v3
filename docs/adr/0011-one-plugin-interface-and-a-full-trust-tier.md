# 11. One plugin interface, two places to run, and full trust as a permission

Status: decided by the maintainer on 2026-10-11 (issue #56), built in PR 55. This records the decision, how it is enforced, and what it leaves open. It changes ADR 10 in one place: third-party code runs shut off from the app unless an admin grants it full trust and a member turns it on for themself.

## The decision

Every plugin that is a manifest and code, Common Ink's own included, declares itself in one manifest: name, description, the capabilities it asks for with a reason each, and what it adds. Where a plugin runs follows from what it asks for.

- **Shut off, in frames** is the default, and it is ADR 10 unchanged: a frame with an origin of its own, one port, every message decided by the broker, every operation sent to the plugin's own address and checked again by the server.
- **In the page** is the capability `full-trust`. It is asked for in the manifest like any other, with a reason, and decided by the same operation, `plugin.permit`. So it is an admin's alone to grant, and it names the hash of the code that was read.

Built-in plugins that need the editor's internals stay compiled into the app. In this model they are full-trust plugins that ship with it, and the Plugins page says so: "Built-in, full access". Built-ins that need nothing of the page run shut off ("Built-in, sandboxed"), through the same broker, port and address as a third-party plugin. A workspace's plugin is never called built-in: one that asks to run in the page is "Third-party, full trust".

## The two gates on full trust

A plugin that asks for full trust runs, for one member, only while both hold:

1. **An admin's grant of exactly this code stands.** `plugin_permissions.approved` holds the capability as declared and the code's SHA-256.
2. **That member turned it on for themself, for this code.** `plugin.trust` writes a row in `plugin_trust` keyed to the workspace, the plugin and the person asking, with the code's hash. The operation takes no person: nobody turns it on for anyone else, an admin included. Agents and plugins are refused the operation.

Otherwise none of it runs. There is no half measure where its other capabilities run in a frame: a manifest that asks for full trust is in the page or nowhere, and its page says which in one line (not granted; granted and not turned on by you; its code changed since the grant).

Four rules make the gates hold over time. Each is one statement or one batch in `src/core/pluginRecord.ts`, and `test/core/full-trust.test.ts` tries each as an attacker.

- **A change ends it for good.** `plugin.install` with `replaces`, the only way an installed plugin's code changes, marks a grant that is not of the new code as of nothing and deletes every member's row, in the batch that changes the code. So A, then B, then A again restores neither the grant nor anyone's turning it on. The same holds when the same code asks for full trust with another reason, or stops asking and asks again.
- **A decision starts it from nobody.** `plugin.permit` on `full-trust` that takes the grant back, or gives one where none stood, deletes every member's row. Granting again turns nobody back on. Saying again what already stands (a second press of Allow, locking it) decides nothing and turns nobody off.
- **Turning on is one guarded statement.** The insert keeps a row only if, as it runs, the asker is a member, the plugin's code is the code they named, and the grant of that code stands. Whatever it races (an update, a revocation, an uninstall, the member's removal), no row is left that nothing stands behind.
- **Leaving forgets it.** A member who is removed or who leaves loses their rows in the batch that takes them out. Added again, they have turned nothing on. Uninstalling deletes the plugin's rows.

The app does not take the server's word for the code. Before running anything in the page it reads the code, hashes it itself, and compares that with the granted hash. Other code is not run. This guards a swap between the record and the code (a raced update, a cache, a proxy that rewrites one answer). It does not guard against a server that lies in both: the server is the one that says what was granted.

Code that has run in a page can't be taken out of it. So when a full-trust plugin is to stop for a member (they turn it off, the grant is taken back, the code changes, the plugin goes, or they go to another workspace in the same window), the app sends what is typed and loads itself again. The loading again is started with functions the app took before any plugin ran and does not wait on the save. That ends honest code and code that only holds up a save. It is not a boundary: see the residual risks.

On the server the plugin's operations still come to the plugin's address, as the member. `perform` resolves the member's standing as for the member, then lets a full-trust plugin ask anything that is not marked as the member's alone (`by: "member"`). Those stay refused to every plugin, in anyone's session: settings, members and invites, grants and links, making a note private, purging, changing the record of plugins and reading a plugin's code, turning full trust on, and drafts. Reading the record (`plugin.list`) is answered, with nothing of full trust in it. `test/core/access-matrix.test.ts` has four full-trust plugin actors as rows (on; granted and not turned on; not granted; code changed after), each asked every operation as every kind of person.

An agent or a plugin that reads the record (`plugin.list`) is told nothing of full trust: the capability is left out of the manifest and the permissions it is shown, and `fullTrust` is null. An admin is told who has it on. Any other member is told only of themself.

## What full trust can do, stated plainly

The page is not a boundary. Code in the page shares it with the app. So in the session of a member who turned it on, a full-trust plugin can do anything that member can do in that browser, and the host object is a convenience, not a limit:

- read and change every note the member can open, their private notes included;
- see what they type, and what is on screen;
- read and change their settings, their drafts, and what the app keeps in the browser;
- call the server with the member's session directly, past the plugin's address, so those calls are recorded as the member's and not as the plugin's;
- do all of that in **every workspace the member belongs to**, not only the one whose admin granted it: a session is the person's, and the same cookie is sent to every workspace's address;
- if the member is an admin: everything an admin can do, including inviting people, changing roles, installing plugins, and granting full trust to other code;
- send any of it anywhere.

What it cannot do, because the server decides these by who the member is:

- **See a note the member can't.** Every operation resolves access as the member (ADR 2).
- **Do an admin's work in a non-admin's session.** Granting, approving, installing, uninstalling, inviting and changing roles are checked against the member's role.
- **Run for anyone who has not turned it on,** or turn itself on for anyone but the member whose session it is in, or run code other than what an admin granted.

Four residual risks are accepted and recorded here rather than hidden. `test/browser/full-trust.spec.ts` reproduces each, so that a later change that removes one is noticed.

- **A member who turns on a full-trust plugin has given that code everything they can do, and some of it outlasts the switch.** In any member's session it can create an agent token in their name and share their notes by link, and both keep working after the plugin is turned off or uninstalled. In an admin's session it can also invite people, change roles, and install and approve plugins, **including approving a new version of itself**, or another plugin, and turning that on for that admin with no warning shown: the hash pin and the warning hold against everyone except an admin's own session with the plugin on. That is so in every workspace the member is an admin of. It still can't turn anything on for anyone else. The gates are the admin's review of the exact code, and each member's own switch behind a warning that says all of this in those words.
- **It reaches the member's other workspaces.** An admin of workspace A grants it and a member of A turns it on. That member's notes in workspace B, whose admin granted nothing, are within its reach while it runs, because code in the page can ask the server for them with the member's session. The warning says so. Leaving A for B in the same window loads the app again, so the code does not go on running there, but while it runs in A nothing stops the request.
- **Code that means harm can keep running in a window it is already in.** Turning it off, taking the grant back and changing the code all stop the server answering at the plugin's address at once, and load the app again in each open window when that window next reads the record (when it is come back to, and every 15 seconds while it is in front, not while it is hidden). Code in the page can get in the way of that loading, and of its own switch, in its own window. With the member's session it has there what it had. What ends it in that window is closing it. What does hold: the app decides what to run from the record before any plugin's code runs, so a window loaded after it was turned off, or after the grant ended, runs none of it.
- **A full-trust plugin's embeds are drawn from what any editor of a note wrote,** in the session of each reader who has the plugin on. The plugin's author has to treat a note's text as untrusted input, as the app's own embeds do.

Two mitigations were considered and not taken:

- **An admin console on a separate origin, where no plugin runs.** It is the real boundary: admin operations and token minting would be accepted only from that origin, so no code in the app's page could perform them. A separate origin per workspace would close the reach across workspaces the same way. Not taken now because it is a second app surface, a second session, and a change to how every admin works, for a risk that today needs an admin to grant and turn on hostile code. It is the next step if full-trust plugins from outside the team become common.
- **A server rule refusing admin operations and token minting to a member while they have any full-trust plugin on, lifted only for sessions started after they turn it off.** Not taken because it is a half boundary that reads as a whole one: the plugin can turn itself off with the member's session (`plugin.trust` is theirs to call), and the "session started after" condition needs sessions the server can tell apart and revoke, which it does not have (a session is a signed cookie). It would also lock an admin out of administering while a plugin they rely on is on. Without revocable sessions the rule can be walked around, so the choice was to say the risk plainly instead of shipping a rule that looks like it removes it.

## Drafts

A member can copy the source of any plugin that is a manifest and a code text and change it (ADR 10's frames run it). A draft whose manifest asks for full trust does not run at all, shut off or in the page: no admin read that code. It is refused where it is saved as running, where the server reads it for the draft's address, and where the app decides what to run, so forcing any one of the three changes nothing. A draft of a full-trust plugin that does not ask for it runs shut off, with what else the original is allowed.

Publishing is not a new path. An admin installs the draft's text with `plugin.install`, which ends the grant and every member's turning on, and grants the new code as any other.

## Considered and not done

- **A member granting full trust to their own draft in a developer mode.** It would run only in their own browser, where they can already open the console, so it adds no reach. It was left out because the rule "in the page only with an admin's grant of that hash" then has no exception to explain or to get wrong.
- **Pinning the grant to the whole manifest.** A grant is of the capability as declared (name, reason) and the code's hash. A change to another part of the manifest, such as the description, does not end it. The code is what runs.
- **Letting a full-trust plugin take the page at `/`,** or go by a name of the app's own, or write its embeds without the `x-` mark. These are about whose a thing is said to be, not what it may do, and they stay refused to every plugin a workspace installed.
