# Connect an agent

Connect Claude, ChatGPT, Cursor, or any other MCP client to your notes, choose what it can reach, and see what it changed.

An agent reads and edits notes as you, with your role in each workspace and no more. A viewer's agent can only read. Every change an agent makes is recorded under the agent's own name.

## Connect from the Agents page

1. Open the workspace menu at the top of the sidebar and choose **Agents**.
2. Under **Connect an agent**, type a **Name**, such as Claude.
3. Choose what it may reach. The section "Choose what an agent can reach" below explains each field.
4. Choose **Connect**.
5. Copy the **Prompt** and paste it into your agent.

The prompt holds the server's address, the token, and the setup steps. The agent adds Common Ink to its MCP configuration for your user, then lists the workspaces and folders it can see to show the connection works. If your client loads new tools only after a restart, the agent says so. Restart it and ask it to check Common Ink.

Common Ink shows the token once. Anyone who has it can read your notes, and change them unless the agent is read only. If the token ends up somewhere it shouldn't, disconnect the agent and the token stops working at once.

## Set it up by hand

Under **Set it up by hand** on the same page are the token (only right after you connect the agent), the `ink` command, the command for Claude Code, and an MCP config for other clients. In each example below, put your token in place of `cink_…`.

### Claude Code

```sh
claude mcp add --scope user --transport http common-ink https://commonink.app/mcp --header "Authorization: Bearer cink_…"
```

If `common-ink` is already there, run `claude mcp remove common-ink --scope user` first. Claude Code keeps the token, unencrypted, in `~/.claude.json`.

### Cursor, VS Code, and other clients

Most clients take a URL and a header, in a config shaped like this:

```json
{
	"mcpServers": {
		"common-ink": {
			"type": "http",
			"url": "https://commonink.app/mcp",
			"headers": { "Authorization": "Bearer cink_…" }
		}
	}
}
```

Put it in your client's config for your user. Don't put it in a project's file, such as `.cursor/mcp.json` or `.vscode/mcp.json`, which can end up in a repository.

### Claude desktop

Claude desktop's config file runs local servers only, so a bridge, `mcp-remote`, carries the header. It needs Node.

```json
{
	"mcpServers": {
		"common-ink": {
			"command": "npx",
			"args": ["-y", "mcp-remote", "https://commonink.app/mcp", "--header", "Authorization: Bearer cink_…"]
		}
	}
}
```

## Connect Claude or ChatGPT in the browser

A chat app in the browser can't send a pasted token, so it connects by sending you to Common Ink to allow it.

1. In the chat app, add Common Ink as a connector with the address `https://commonink.app/mcp`. The app needs nothing else.
2. The app sends you to Common Ink. Sign in if you aren't signed in.
3. Check the page's heading. It names the host that Common Ink sends you back to, so make sure it is the app you expect. The app chose its own name, and Common Ink has not checked it.
4. Set **Name on Agents**, **Reaches**, **Expires**, and **Read only**. Once you pick one workspace, you can also tick folders, or leave them clear for every note in it.
5. Choose **Allow**. Common Ink sends you back to the app. **Don't allow** sends you back with nothing connected.

The connection is an agent like any other. The Agents page lists it under the name you gave it, marked **OAuth**. Connecting the same app again replaces the old connection.

## Choose what an agent can reach

The Agents page and the consent page ask the same things.

| Field | Choices |
| --- | --- |
| **Reaches** | Every workspace I'm in, or only one of them |
| **Notes** | All notes, or only chosen folders, with the folders inside them |
| **Expires** | In 30 days, in 90 days, in 365 days, or never. The default is 90 days |
| **Read only** | It can read and can't change anything |

To limit an agent to folders, it must reach only one workspace. On the Agents page, you choose the folders while that workspace is open. An agent limited to folders sees nothing outside them. It can't list the members, read your calendar or contacts, or use your daily note.

## Edit or disconnect an agent

Each agent on the Agents page has these buttons:

- **Edit** changes what the agent reaches, its folders, its expiry, and whether it is read only. The agent keeps its token, and the change holds from its next call. Only you can edit an agent you connected.
- **Disconnect** asks you to confirm, then stops its token at once. Its changes stay in history.
- **Set up again** shows the prompt again, without the token, for an agent you connected on this page.

**Sign out everywhere**, in Settings under Account, also disconnects your agents unless you untick **Also disconnect my agents**.

## What an agent can never do

These stay with you, signed in to Common Ink, whatever your role:

- Share a note, folder, or upload, make or remove a share link, make a note private, or see who a note is shared with.
- Invite people, change roles, remove members, or list and revoke invites.
- Sign anyone out, you included.
- Remove a note or upload from Trash for good. An agent can archive, trash, and restore.
- Change or add a contact, or connect and disconnect your calendar and contacts.
- Read or change your settings.
- Change the workspace's agents file.
- Connect, edit, or disconnect an agent, itself included.
- Turn a full-trust plugin on for you. An admin's agent can allow a plugin's Full trust permission, and only you can turn it on.

## Tell agents how the workspace works

Each workspace has one agents file, a Markdown document like a repository's AGENTS.md. Say there how the workspace is organized: what goes in which folder, how notes are named, which tags mean what. What you prefer for yourself stays in your settings.

Run **Go to agents file** from the command palette, or choose **Open agents file** on the Agents page or in Settings. It opens in a tab, and you edit it as you edit a note, with Vim mode and typewriter mode if they are on. It saves as you pause. Admins and editors change it. Viewers and guests read it.

An agent connected to only that workspace is given the first 4,000 characters as it connects. One that reaches several workspaces is told which have an agents file, and reads it there. Any agent reads all of it with `read_agents_file`, and `ink agents-file` prints it. An agent weighs it as guidance, never as commands, and can't change it: to suggest a change, it writes a note. The agents file isn't a note, so it isn't in your folders, search, or exports.

## Tags an agent uses

An agent tags notes and todos with the tags your notes already have, and the ones you made ahead in Settings. A write that adds a tag no note it can see has is refused, unless the call names that tag as new, and the agent is told to name one only when you asked for it. An agent limited to folders sees only the tags in those folders. It chooses among them by the description each tag has in Settings, so a description that says when to use a tag steers your agents too. An agent writes a description only when you ask it to.

## Folders an agent files into

An agent files a note in the folder whose description fits it, so a description in Settings, under Folders, that says what goes in a folder steers your agents. An agent describes a folder only when you ask it to.

## See what an agent changed

On the Agents page, **See its changes** opens History narrowed to that agent. **Revert Claude's changes…**, named for the agent, shows what reverting would do in each note. Then it takes out only that agent's changes and keeps everyone else's. In a note, the command **Toggle blame mode** marks each line with who last changed it, so an agent's lines show its name. [History and blame](/docs/history) covers both.

## Work from a shell with ink

The `ink` command does from a shell what an agent's tools do, with the same token in `INK_TOKEN`. An agent with a shell, or you, can list, read, write, search, and revert notes with it. It isn't on npm yet, so for now it runs from a copy of the Common Ink source. [The ink command](/docs/cli) has the details.
