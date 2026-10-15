/** What an agent may reach, in the words a person uses for it. */
export interface Reach {
  name: string;
  readOnly: boolean;
  /** The one workspace it reaches, by name, or null for every workspace its member is in. */
  workspace: string | null;
  /** The folders it is limited to there, by path, or null for all notes. Empty when it is limited and none can be named here. */
  folders: readonly string[] | null;
}

/** How an agent reaches Common Ink. `token` is null once it is no longer shown. */
export interface Connection {
  /** Common Ink's origin, such as https://commonink.app. */
  origin: string;
  agent: Reach;
  token: string | null;
}

const SERVER = "common-ink";

/** Stands for the token in commands written while it isn't shown. Plainly not one: a token starts with `cink_`. */
const NO_TOKEN = "<token>";

const quoted = (name: string) => JSON.stringify(name);

const listed = (names: readonly string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function reaches({ workspace, folders }: Reach) {
  if (workspace === null) return "It reaches every workspace I'm in.";
  if (folders === null) return `It reaches only my workspace ${quoted(workspace)}.`;
  if (!folders.length) return `It reaches only some folders of my workspace ${quoted(workspace)}, and the rest of it is hidden from you.`;
  return `It reaches only the ${folders.length === 1 ? "folder" : "folders"} ${listed(folders.map(quoted))} of my workspace ${quoted(workspace)} and the folders inside ${folders.length === 1 ? "it" : "them"}. The rest of it is hidden from you.`;
}

/** The commands and config for setting the connection up by hand, each with the token in it while it is shown. */
export function byHand({ origin, token }: Connection) {
  const url = `${origin}/mcp`;
  return {
    ink: `export INK_URL=${origin}\nexport INK_TOKEN=${token ?? `"${NO_TOKEN}"`}\nnpm run ink -- notes`,
    claudeCode: `claude mcp add --transport http ${SERVER} ${url} --header "Authorization: Bearer $INK_TOKEN"`,
    config: JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url, headers: { Authorization: `Bearer ${token ?? NO_TOKEN}` } } } }),
  };
}

/**
 * A prompt to paste into an agent, such as Claude Code, Cursor or Claude desktop, so it adds the connection
 * to itself and checks it works. The token is in it only while it is shown; after that it says how to get one.
 * Every name in it is quoted, since a folder's name is anyone's in the workspace to write.
 */
export function connectPrompt(connection: Connection): string {
  const { origin, agent, token } = connection;
  const url = `${origin}/mcp`;
  const bearer = `Authorization: Bearer ${token ?? NO_TOKEN}`;
  const can = agent.readOnly
    ? "Through its MCP server you can read my notes, my folders and their history. This connection is read only: you can't change anything."
    : `Through its MCP server you can read my notes, my folders and their history, and create, edit, move and revert them. You act as me, with my role in each workspace and no more, and every change you make is recorded under the name ${quoted(agent.name)}.`;
  const tokenLine = token
    ? `- Token: ${token}`
    : `- Token: not shown here. Common Ink shows a token only once, when the agent is connected. If I gave it to you, use it in place of ${NO_TOKEN} below. If I haven't, don't do step 1 with ${NO_TOKEN}: stop and ask me for it. If I no longer have it, ask me to connect a new agent at ${origin}/agents and to give you the prompt it shows. Never guess or make up a token.`;
  return [
    "Please connect yourself to my notes in Common Ink, then check that the connection works.",
    "",
    `Common Ink is a markdown notes app at ${origin}. I connected you to it as an agent named ${quoted(agent.name)}. ${can} ${reaches(agent)}`,
    "",
    "The connection:",
    `- MCP server: ${url}`,
    "- Transport: Streamable HTTP (JSON over POST; no SSE, no OAuth)",
    tokenLine,
    "",
    `1. Add the server to your MCP configuration for my user (global), named "${SERVER}". Never add it to a project's config, such as .mcp.json, .cursor/mcp.json or .vscode/mcp.json, which can end up in a repository. Keep the servers already there, and replace one named "${SERVER}". Most clients take a URL and a header, in a config shaped like this:`,
    `   {"mcpServers": {"${SERVER}": {"type": "http", "url": "${url}", "headers": {"Authorization": "Bearer ${token ?? NO_TOKEN}"}}}}`,
    `   If you are Claude Code, run this yourself, after \`claude mcp remove ${SERVER} --scope user\` if it is already there:`,
    `   claude mcp add --scope user --transport http ${SERVER} ${url} --header "${bearer}"`,
    "   If your client only runs local (stdio) servers, as Claude desktop's config file does, a bridge can carry the header. It needs Node:",
    `   {"mcpServers": {"${SERVER}": {"command": "npx", "args": ["-y", "mcp-remote", "${url}", "--header", "${bearer}"]}}}`,
    "   If you can't change your own configuration, as in a chat app, say so and tell me where I would add it, without repeating the token, and stop there.",
    "2. If its tools only appear after a restart, tell me so and stop. I'll restart you and ask you to check Common Ink (Claude Code keeps this conversation with `claude --continue`). Then do step 3.",
    "3. Check it works: call the list_workspaces tool, then list_folders for each workspace it lists, and tell me which workspaces and folders you can see. A 401 means the token is wrong or the agent was disconnected.",
    "",
    `Keep the token secret: it lets whoever has it ${agent.readOnly ? "read" : "read and change"} my notes. Write it nowhere but your MCP configuration: not in a project's files, a commit or a note, and don't repeat it to me.`,
  ].join("\n");
}
