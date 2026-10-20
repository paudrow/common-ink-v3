# Agent tools

This page lists every tool Common Ink's MCP server offers an agent, with each tool's arguments and an example call.

The server is at `https://commonink.app/mcp`. It speaks Streamable HTTP, one JSON-RPC message or batch per POST, answered as JSON. An agent signs in with a token in an `Authorization: Bearer` header, or by OAuth from a chat app in the browser. [Connect an agent](/docs/agents) shows both.

Each tool acts as the member who connected the agent, with their role in each workspace and no more. The limits set when the agent was connected narrow that further, to one workspace, to some folders, or to reading only. Every change a tool makes to a note is recorded in history under the agent's name.

Each tool takes an optional `workspaceId`. Leave it out when the member is in one workspace. An argument a tool doesn't take is refused by name. Ids in the examples are made up.

<!-- generated:mcp-tools -->
