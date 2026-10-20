# Plugins

Turn Common Ink's plugins on and off, install a workspace's own plugins, decide what each may do, and start writing one.

Most of Common Ink is plugins, such as the sidebar, tabs and splits, the command palette, and Vim mode. A third-party plugin is one a member wrote and an admin installed in a workspace.

## Turn a plugin on or off

Open **Plugins** under **More** in the sidebar. Each plugin is a card with a switch. Turn a plugin off and what it adds goes away until you turn it back on. The choice is yours alone, and it follows you to other browsers.

Most built-in plugins start on, and a few start off, such as Vim mode. Press a card to open the plugin's page, with what it adds, its permissions, its settings, and its source.

Each card says what kind of plugin it is:

| Label | What it means |
| --- | --- |
| Built-in, full access | Comes with Common Ink and runs inside the app with everything you have |
| Built-in, sandboxed | Comes with Common Ink and runs shut off from the app, such as Word count and Backlinks |
| Third-party | An admin installed it, and it runs shut off from the app |
| Third-party, full trust | An admin installed it, and it runs inside the app once it is granted and you turn it on |

A third-party plugin is off for each member until that member turns it on.

## Install a third-party plugin

Only an admin can install a plugin. A plugin is two pieces of text, a manifest in JSON and its code in JavaScript. Nothing is fetched from anywhere, so what you paste is what runs.

1. On the Plugins page, go to **Install a plugin**.
2. Paste the **Manifest (JSON)** and the **Code (JavaScript)**.
3. Choose **Review**. The review lists each permission the plugin asks for, with the reason its author gave. Every box starts unticked.
4. Tick what the plugin may do.
5. Choose **Install**. Install adds the plugin and allows only what you ticked.

If the plugin adds embeds, the review warns you that an embed runs as soon as a note with one is opened, on whatever an editor of that note wrote. The menu on the plugin's page has **Update…** and **Uninstall…**.

## What a plugin can ask for

| Permission | What it allows |
| --- | --- |
| Read notes | The notes and folders you can see, which of them link to a note, and search across them |
| Write notes | Make notes and change the ones you can change. History records each change as the plugin's |
| Read todos | The todos in the notes you can see |
| Read members' names | The names and roles of the workspace's members, never their emails |
| Use the network | Load from and send to the sites it lists, and no other |
| Full trust | Run inside Common Ink, with everything you can do |

A plugin acts as you and never has more than you do. If you are a viewer, a plugin allowed to write notes still can't change one.

An approval is for one version of the code, named by its SHA-256 hash. When an admin updates a plugin, every permission goes off until an admin allows it for the new code. A permission whose reason or sites change goes off too.

A member who isn't an admin sees **Ask an admin** in place of **Allow**, and nothing is allowed until an admin approves.

## Full trust

A plugin with full trust runs inside Common Ink instead of shut off from it. It runs for you only while both of these hold:

- An admin granted this exact code, with **Allow** on its Full trust permission.
- You turned it on for yourself with the switch on its page, and confirmed the warning with **Turn it on for me**.

Nobody can turn it on for you, an admin included. Any change to its code ends it for everyone, until an admin grants the new code and each member turns it on again.

While you have it on, it can do anything you can do, in every workspace you belong to. It can read and change every note you can open, your private notes included, see what you type, and send any of it anywhere. It can create an agent token in your name and share your notes by link, and both keep working after you turn it off. If you are an admin, it can also invite people, change roles, and approve plugins, a new version of itself included. It can't see notes you can't see.

Turning it off loads Common Ink again, so none of its code is left running. Code that means harm can get in the way of that in a window it already runs in, and closing that window ends it.

## What the sandbox doesn't cover

A plugin without full trust runs in a frame shut off from the app. A few things still get through:

- **WebRTC.** A frame can open a WebRTC connection, and no browser lets Common Ink block it. So a plugin can send what it is allowed to read to another computer, with or without the network permission. Allow Read notes only for a plugin you would trust to send those notes out.
- **Names.** Everything a plugin shows starts with its name and the word "plugin". It can't take one of Common Ink's own names, but it can pick a misleading name of its own.
- **Who changed a note.** A plugin that reads notes sees who last changed each one, by name.

## Build a plugin

`ink plugin-new` writes a manifest and code to start from. `ink plugin-validate` says what installing them would make of them, or why it would be refused. Neither installs anything. [The ink command](/docs/cli) shows how to set up `ink`.

```sh
ink plugin-new "Reading time" --out reading-time
ink plugin-validate --manifest @reading-time/manifest.json --code @reading-time/plugin.js
```

To change an installed plugin, choose **Edit a copy** under Source on its page. That makes a draft that is yours alone. **Run my draft** runs it in place of the original, for you only, with no more than the original is allowed. An admin can publish a draft, which replaces the plugin and turns its permissions off until an admin allows them again.

The full author reference is [docs/plugins.md on GitHub](https://github.com/paudrow/common-ink-v3/blob/main/docs/plugins.md). It covers the manifest, the `ink` object a plugin's code is handed, and styling.
