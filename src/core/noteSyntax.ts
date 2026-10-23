import { STATES_WRITTEN } from "./boxes.ts";
import { EMBED_SCHEMAS, keysText } from "./embedSchema.ts";

/**
 * What a note can hold besides plain paragraphs, and a short example of each. `note_syntax` says
 * this, and `create_note` and `write_note` point at it. A built-in embed with no row fails
 * test/core/plugin-note-syntax.test.ts.
 */
export interface NoteSyntax {
  /** The embed's name, where this is one. An address embed can share a name with an embed. */
  name: string;
  /** `embed` is `::name{…}` or a `:::name{…}` block. `address` is a URL alone on a line. `prose` is the rest. */
  kind: "embed" | "address" | "prose";
  /** How the tool's description names it. */
  called: string;
  /** What an agent needs in order to write one. */
  about: string;
  /** As it is written in a note. */
  example: string;
}

/** Said by create_note, write_note, and the MCP instructions. */
export const ASK_NOTE_SYNTAX = "Before you write a form, a board, or any other embed, call note_syntax.";

export const NOTE_SYNTAX: readonly NoteSyntax[] = [
  {
    name: "form",
    kind: "embed",
    called: "a form",
    about:
      'A form is a block. The opening line is exactly :::form{} and the closing line is ::: alone. A block with no closing line is ordinary text. The body is JSON. Leave "answers" as {}. A member\'s click stores their choice there under their id, and a later write that drops "answers" wipes those replies. A question\'s type is short, paragraph, one, several or dropdown (each with options, which are the labels), scale (1 to 5, with minLabel and maxLabel), date, time, grid (rows and cols, each {id, label}, and several when a row may take more than one column) or image (options of {id, label, src}, and several when more than one may be picked). "mode": "one" keeps a single shared answer. "anonymous": true keeps tallies, texts and voted instead of answers. "closed": true stops answers. "explain": false hides Other, which a choice question shows otherwise. "ask" is the member ids allowed to answer. "by" is who asked.',
    example: `:::form{}
{
  "answers": {},
  "questions": [
    { "id": "name", "type": "short", "prompt": "Your name" },
    { "id": "day", "type": "one", "prompt": "Which day", "options": ["Monday", "Tuesday"] }
  ]
}
:::`,
  },
  {
    name: "kanban",
    kind: "embed",
    called: "a kanban board",
    about: "A board is a block. Each heading is a column and each list item under it is a card. {.blue} after a heading colours that column. The colours are red, orange, yellow, green, blue, purple, pink and gray.",
    example: `:::kanban{}
## To do

- Write the brief

## Doing {.blue}

## Done
:::`,
  },
  {
    name: "timer",
    kind: "embed",
    called: "a timer",
    about: "A timer's config is how long it runs, such as 5m, 90s or 1h30m, and nothing else. A press writes since=<instant> while it runs and at=<duration> once it is stopped. Leave those out.",
    example: "::timer{5m}",
  },
  {
    name: "stopwatch",
    kind: "embed",
    called: "a stopwatch",
    about: "A stopwatch has an empty config until someone starts it. A press writes since=<instant> while it runs and at=<duration> once it is stopped, as a timer's does.",
    example: "::stopwatch{}",
  },
  {
    name: "html",
    kind: "embed",
    called: "HTML",
    about: "HTML is a block, and it runs shut off from the app and the network. height=480 in the config sets its height in pixels, from 40 to 2000. Left out, it has its own.",
    example: `:::html{}
<p>Hello</p>
:::`,
  },
  {
    name: "event",
    kind: "embed",
    called: "an event",
    about: "An event is the id refer_record answered, then a space, then a label. Anyone but the member whose calendar it is sees only the label.",
    example: "::event{aaaaaaaaaaaa Lunch}",
  },
  {
    name: "contact",
    kind: "embed",
    called: "a contact",
    about: "A contact is the id refer_record answered, then a space, then a name. Anyone but the member whose contacts they are sees only the name. Write the name, never an email.",
    example: "::contact{aaaaaaaaaaaa Ada Lovelace}",
  },
  {
    name: "email",
    kind: "embed",
    called: "an email thread",
    about: "An email thread, or one message in it, is the id refer_record answered, then a space, then a label. Anyone but the member whose email it is sees only the label. Write a subject, never what the mail says.",
    example: "::email{aaaaaaaaaaaa Invoice for October}",
  },
  {
    name: "image",
    kind: "embed",
    called: "a picture",
    about: "A picture is an upload's id, from list_uploads or from the line upload_file answered, then the room to keep for it as WIDTHxHEIGHT. small, medium or large after that, or a whole percent such as 42%, sets how much of the note's column it takes, and without one it is the whole column. crop=X,Y,WIDTH,HEIGHT after that draws only that part of the picture, in the pixels of WIDTHxHEIGHT from its top left corner, and the file itself is never changed; a video is not cropped. The upload's name is never in the note. The embed is on a line of its own. place_upload it before writing it into a note someone else can read.",
    example: "::image{u2p9l4d8a3c7 640x480}",
  },
  {
    name: "video",
    kind: "embed",
    called: "a video",
    about: "A video file is an upload, written as a picture is, with its id and the room to keep. A YouTube address on its own line is a different thing, below.",
    example: "::video{u2p9l4d8a3c7 640x360}",
  },
  {
    name: "audio",
    kind: "embed",
    called: "a recording",
    about: "A recording is an upload's id and nothing after it.",
    example: "::audio{u2p9l4d8a3c7}",
  },
  {
    name: "file",
    kind: "embed",
    called: "a file",
    about: "Any other upload is a file, written as its id alone. It is shown as a card that downloads.",
    example: "::file{u2p9l4d8a3c7}",
  },
  {
    name: "drawing",
    kind: "embed",
    called: "a drawing",
    about:
      'A drawing is an upload holding an Excalidraw scene, the JSON of an .excalidraw file, then the room to keep for it as WIDTHxHEIGHT, and a width as a picture has. Its bytes are that JSON: {"type":"excalidraw","version":2,"elements":[...],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}, each element as Excalidraw writes it, with "preview" holding the picture the app drew of the elements when a member last saved it. To draw one, upload_file such JSON named Drawing.excalidraw, leaving preview out, and write the embed with its id; the size is optional and without it the room is 16:9. The app draws the picture from the elements, for each reader, until a member saves it. Members draw in Excalidraw from the embed, and each save is a new upload whose id the embed then names, so the note\'s history keeps every drawing before it. ::drawing{} with no id is one not drawn yet. On a line of its own. place_upload it before writing it into a note someone else can read.',
    example: "::drawing{u2p9l4d8a3c7 820x460}",
  },
  {
    name: "video",
    kind: "address",
    called: "a YouTube video",
    about: "A YouTube address alone on a line is shown as that video. It is not ::video{}, which is an uploaded file. youtu.be and youtube.com/watch both work, and so does a Shorts address.",
    example: "https://www.youtube.com/watch?v=abcdefghijk",
  },
  {
    name: "post",
    kind: "address",
    called: "a post",
    about: "An X or Twitter status, or a Bluesky post, alone on a line is shown as that post. A Bluesky address has the account's DID, as https://bsky.app/profile/did:plc:…/post/…",
    example: "https://x.com/commonink/status/1",
  },
  {
    name: "math",
    kind: "prose",
    called: "math",
    about: "Math is LaTeX between dollar signs. $…$ stays in the line, with no space just inside either dollar, so a price is left as money. A line that is only $$ opens a formula of its own, and a line that is only $$ closes it.",
    example: `$E=mc^2$

$$
E=mc^2
$$`,
  },
  {
    name: "link",
    kind: "prose",
    called: "a link",
    about: "A link to a note is [[id]] or [[id|the words shown]], with the note's id, so it survives a rename. [[Title]] is stored by the id of the one note with that title. A link to a folder is [[folder:id]], with the folder's id from list_folders. A day is written as a link to it, [[YYYY-MM-DD]], or [[YYYY-MM-DD HH:MM]] with a time on a 24-hour clock where the member is: it goes to that day's daily note, and is listed among the daily note's backlinks. A date written bare is only words. Text in code is left alone.",
    example: "See [[k3f9q2m8x1ab|Budget]] by [[2026-10-23]].",
  },
  {
    name: "mention",
    kind: "prose",
    called: "a mention",
    about: "A mention is a link to a person: [[person:id]] for a member, with their id from list_members, or [[person:Name]] for anyone else. It shows the person's name as it is now, and [[person:id|words]] shows the words instead. [[person:Name]] for a member is stored by their id. A mention on a todo's line assigns it. It gives nobody access. Write a contact's name and never their email.",
    example: "Ask [[person:Ada Lovelace]].",
  },
  {
    name: "todo",
    kind: "prose",
    called: "a todo",
    about: `A todo is a checkbox line: ${STATES_WRITTEN}. !, !! or !!! right after the checkbox is its priority. due:YYYY-MM-DD is the day. every:RULE makes it repeat, and the rules are in list_todos. [[person:Name]] on the line assigns it. A #tag on the line tags it, and so do the tags over it: a heading's, a line of nothing but tags above it in its section, and a list item's it is nested in.`,
    example: "- [ ] !! Call the bank due:2026-10-14 every:1w",
  },
];

/** What note_syntax's description names, so an agent sees each one before calling it. */
export const syntaxDescription = () => `What a note can hold besides plain paragraphs, each with an example in the answer: ${NOTE_SYNTAX.map((row) => row.called).join(", ")}.`;

/** An embed's keys, from its schema, under what the row says of it. */
const keysOf = (row: NoteSyntax) => (row.kind === "embed" && Object.hasOwn(EMBED_SCHEMAS, row.name) ? `\n${keysText(EMBED_SCHEMAS[row.name]!)}` : "");

/** What note_syntax answers, and what ink note-syntax prints. */
export const syntaxText = () => NOTE_SYNTAX.map((row) => `${row.called}\n${row.about}${keysOf(row)}\n\n${row.example}`).join("\n\n");
