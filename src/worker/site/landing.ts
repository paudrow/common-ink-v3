import { SUPPORT, wayIn, type SitePage, type Visit } from "./layout.ts";

const heading = (text: string, id: string) => `<h2 id="${id}">${text}</h2>`;

type Author = { name: string; when: string; tone: "you" | "agent" | "member" };

/** One run of lines as the blame column shows it: who last wrote them, and when. */
const run = (who: Author, lines: string, className = "") =>
  `<div class="run ${who.tone}${className ? ` ${className}` : ""}"><p class="who"><span class="who-name">${who.name}</span><span class="who-when">${who.when}</span></p><div class="lines">${lines}</div></div>`;

const todo = (text: string, chips: string[], done = false) =>
  `<li class="todo${done ? " done" : ""}"><span class="box" aria-hidden="true"></span><span class="todo-text">${text}</span>${chips.map((chip) => ` <span class="chip">${chip}</span>`).join("")}</li>`;

const hero = (visit: Visit) => `
<section class="hero" aria-labelledby="hero-title">
  <div class="note">
    ${run(
      { name: "You", when: "9:41", tone: "you" },
      `<h1 id="hero-title">Notes you write with your agent</h1>
      <p class="lede">A markdown notebook your AI agent can read, edit and extend. Every line shows who wrote it.</p>`,
    )}
    ${run(
      { name: "Claude", when: "agent, 9:43", tone: "agent" },
      `<p>Action items from Monday's call:</p>
      <ul class="todos">
        ${todo("Send Sam the revised pricing", ["High", "Oct 23", "Sam Okafor"])}
        ${todo("Book a room for the launch dinner", ["Oct 30"])}
        ${todo("Write the weekly update", ["Every week"])}
      </ul>`,
      "arrives",
    )}
    ${run({ name: "Sam Okafor", when: "editor, yesterday", tone: "member" }, `<ul class="todos">${todo("Draft the terms of service", [], true)}</ul>`)}
  </div>
  <div class="ways-in">
    ${wayIn(visit)}
    <a class="quiet" href="#agents">How agents connect</a>
  </div>
  ${visit.signedIn ? "" : `<p class="fine">Early access. To join, write to <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>`}
</section>`;

const agents = `
<section aria-labelledby="agents">
  ${heading("Bring the agent you already use", "agents")}
  <p>Claude, ChatGPT, Cursor or any MCP client connects in a minute, with only the access you give it.</p>
  <pre class="terminal"><code>claude mcp add --scope user --transport http common-ink \\
  https://commonink.app/mcp --header "Authorization: Bearer cink_…"</code></pre>
  <p><a href="/docs/agents">Set up any client</a> or see <a href="/docs/mcp-tools">every tool an agent gets</a>.</p>
</section>`;

const history = `
<section aria-labelledby="history">
  ${heading("Version control for every note", "history")}
  <p>See who wrote each line. Revert one change, or everything an agent did.</p>
  <figure class="specimen history-panel" role="img" aria-label="The History page showing only agents' changes, each with a Revert button">
    <p class="tabs"><span>Everyone</span><span>People</span><span class="on">Agents</span></p>
    <ol>
      <li><b>Claude</b><span>Changed 4 lines in Launch plan</span><time>2 min ago</time><span class="revert">Revert</span></li>
      <li><b>Claude</b><span>Added 3 todos to Monday's call</span><time>9:43</time><span class="revert">Revert</span></li>
      <li class="other"><b>Weekly digest</b><span>Created Week 42 review</span><time>Sunday</time><span class="revert">Revert</span></li>
    </ol>
  </figure>
</section>`;

const extend = `
<section aria-labelledby="extend">
  ${heading("Your agent can build what's missing", "extend")}
  <p>Ask your agent for a plugin and it writes one. You approve its code, and it runs in a sandbox. Notes can render HTML too, so a chart or a small tool lives right in the note.</p>
  <figure class="specimen html-demo" role="img" aria-label="An HTML block in a note, and the bar chart the note draws from it">
    <pre><code>/html()
\`\`\`html
&lt;p&gt;Sign-ups by week&lt;/p&gt;
&lt;ol class="bars"&gt;
  &lt;li style="--h: 30%"&gt;&lt;/li&gt;
  …
&lt;/ol&gt;
\`\`\`</code></pre>
    <div class="bars"><p>Sign-ups by week</p><ol><li style="--h: 30%"></li><li style="--h: 45%"></li><li style="--h: 40%"></li><li style="--h: 70%"></li><li style="--h: 95%"></li></ol></div>
  </figure>
</section>`;

const FEATURES: [string, string][] = [
  ["WYSIWYG markdown", "Write markdown and see it formatted as you type."],
  ["First-class Vim", "Vim keys in the editor and across the app."],
  ["Calendar", "Agenda-style notes that live with your meetings."],
  ["Contacts", "A CRM in your notes, with every mention on a person's page."],
  ["Sharing like Google Drive", "Share a workspace, a folder or one note, to edit, to view, or by link."],
  ["Todos", "Due dates, priorities and repeats, gathered from every note."],
  ["On your phone", "Read and write from anywhere."],
  ["Web clipper", "Save any page into a note from Chrome."],
];

const rest = `
<section aria-labelledby="rest">
  ${heading("And the rest of a good notebook", "rest")}
  <dl class="features">${FEATURES.map(([name, line]) => `<div><dt>${name}</dt><dd>${line}</dd></div>`).join("")}</dl>
</section>`;

const questions = `
<section aria-labelledby="questions">
  ${heading("Questions", "questions")}
  <details><summary>Is there AI built in?</summary><p>No. You bring your own agent.</p></details>
  <details><summary>Do you train AI on my notes?</summary><p>No, and we don't sell your data.</p></details>
  <details><summary>What does it cost?</summary><p>Nothing during early access.</p></details>
</section>`;

const end = (visit: Visit) => `
<section class="end" aria-labelledby="start">
  ${heading("Start a notebook", "start")}
  <div class="ways-in">${wayIn(visit)}</div>
</section>`;

export const landing: SitePage = {
  path: "/",
  title: "Common Ink",
  description: "A markdown notebook your AI agent can read, edit and extend, where every line shows who wrote it.",
  kind: "landing",
  body: (visit) => [hero(visit), agents, history, extend, rest, questions, end(visit)].join("\n"),
};
