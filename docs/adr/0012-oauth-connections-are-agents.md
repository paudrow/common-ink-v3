# 12. A connection by OAuth is an agent, and an app is a stranger

Status: decided by the maintainer on 2026-10-17 (issue #78), built in PR 99. This records the decisions, how they are enforced, and what they leave open.

## Context

A hosted chat app such as claude.ai or ChatGPT connects to an MCP server from its own servers, and it can't send a token a member pastes. The MCP specification has it sign in by OAuth 2.1 instead: it finds the authorization server from the resource, registers itself, sends the member to consent, and trades a code for tokens. Common Ink already had agents, with every limit a member can set. The question was what an OAuth sign-in makes, and how much to trust the app that asks.

## The decisions

- **A connection is an agent.** Consent makes a row in `agents`, with the limits the member picks on the consent page and the app's `client_id`. It goes through `prepareAgent`, the same checks as the Agents page: membership, the folder limit, the cap of 20 agents and the expiry bounds. So everything that holds for an agent holds for it: its own author in history, revert, edit, disconnect and signing out everywhere. Its access token is looked up joined to the agent, so a disconnected, edited or expired agent is held to that on the next call. Nothing about what an agent may reach was added for OAuth.
- **Dynamic client registration only.** Any app registers itself at `/oauth/register` (RFC 7591). There is no list of known apps and no client metadata documents. Every app is a public client: it has no secret and proves itself with PKCE (S256 only). One that asks for a secret is registered without one, and the answer says so.
- **Consent every time.** Each sign-in shows the consent page, even for an app the member allowed before. Allowing the same app again replaces its earlier connection, so reconnecting doesn't add an agent toward the cap.
- **An access token lasts an hour and a refresh token 30 days, and neither past the agent's own expiry.** A refresh token works once and is replaced in the same batch that spends it. One used again within 30 seconds is refused and ends nothing, since it may be a retry after a lost answer. One used again after that ends the connection.
- **A code works once, and a second try ends what the first was given** (RFC 6749 4.1.2). A traded code is kept, marked used, until it would have lapsed, so the second try is seen. The code's spending and the new tokens are one batch, so the agent holds an unspent code or its tokens at every moment, and the sweep that disconnects connections holding nothing never finds a fresh one between the two.
- **Authorize never redirects an error.** Registration is open, so a registered address is not thereby trusted, and a redirect from `/oauth/authorize` would be an open redirector (RFC 9700 4.11.2). What is wrong is said on a page, with a link back that the member may follow. Only the member's own answer, Allow or Don't allow, sends the browser to the app.

## Treating an app as a stranger

Anyone can register an app, under any name, so nothing an app says is trusted, and what it can fill is capped.

- **Its name is its own.** The consent page shows it as the app gave it, beside the host it will send the member back to, as an address bar writes it (punycode). The Agents page marks the row as connected by OAuth from that app, a name nobody checked. Names with control, zero-width or direction-changing characters are refused.
- **Redirect addresses** are https, or http to this machine for a desktop app. They are kept and compared as a browser writes them.
- **Caps count only what is live, and refuse before anything is written.** One address registers at most 20 apps an hour. An IPv6 address counts as its /64, since one host is usually given a whole /64 and could change its address within it at will. At most 1,000 apps wait for a grant. One that never sends anyone to sign in is forgotten after an hour, and one that does and never gets a grant after a day. At most 2,000 sign-ins wait in all, 20 for one app and 10 from one address, fewer than an app's room so one address can't fill it. Addresses are counted by a hash salted with the session secret and logged nowhere.
- **A sweep**, at most once a minute and from the Worker's timer, removes what has lapsed and disconnects connections that hold nothing that works, so they stop counting toward the 20 agents. Nothing depends on its having run: what has lapsed is refused by its own end time wherever it is read.

## Consequences

- A member sees and ends a connection where they see every agent. The Agents page has no OAuth page of its own.
- An app that loses the answer to a refresh can't get it again. It signs in again once its access token's hour is up. Reissuing within a grace window would mean keeping the last answer's tokens.
- Two tries of one code at the same moment are a second use: one gets tokens and the other ends them. An app that sends its code twice has to sign in again.
- `/mcp` has no CORS. Hosted chat apps call it from their servers. A purely in-browser MCP client would need it, and none asks yet.

## Left open

- A rate limit at Cloudflare on `/oauth/register` and `/oauth/authorize`, about 30 requests a minute per IP, is proposed and not set. The caps above bound the damage meanwhile.
- An app's name is never verified. Client ID metadata documents, where an app's `client_id` is an https address that describes it, would let the consent page name a verified host. Nothing asks for them yet.
