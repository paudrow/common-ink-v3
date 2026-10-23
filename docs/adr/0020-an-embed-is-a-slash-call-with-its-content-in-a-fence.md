# 20. An embed is `/name(args)`, with its content in a fence under it

Status: decided by the maintainer on 2026-10-23 (issue #207). It replaces `::name{config}` and the `:::name{config}` … `:::` block. Links are separate: ADR 19, which made an event a link, `[[event:ref]]`, so an event is no embed.

## Context

An embed was written `::name{config}` in a line, and one that holds content `:::name{config}` on a line, its body, then `:::` on a line. Outside Common Ink, on GitHub, in an export, in another editor, the block read as three stray lines of colons around text, and its HTML or JSON was drawn as paragraphs. The editor drew a board's body as the note's markdown and a form's JSON as words. The colons were also a second notation beside `[[…]]` for everything else a note points at.

## Decision

**Every embed is `/name(args)`** (`src/core/embedSyntax.ts`). The first arg is a value alone, the id or main value, then `key=value`, with a value in quotes where it has spaces: `/event(abc label="Team sync")`. Args carry over from `{…}` one to one, so every embed's own reader of its config is unchanged. Parentheses inside args nest, and those inside quotes don't count, so `/event(abc Lunch (team))` is one embed.

**It counts only where it can't be anything else.** `/name(` is an embed at the start of a line or after whitespace, and only for a name that is an embed's: one a plugin registered, in the editor, and one of the app's own or any `x-` plugin's, on the server, which can't ask the plugins. A path (`/usr/bin(x)`), "and/or (x)", an address and inline code never become one.

**Content goes in an ordinary fenced block on the very next line**, tagged with what it is:

````text
/kanban()
```markdown
## To do
- Draft the post
```
````

An embed declares what its content is: `markdown`, `html` or `json` (`content` beside `block` in the plugin API; a block that says nothing is markdown, as every block's body was). A fence is an embed's content only directly under an embed line whose kind holds content, and that line holds the embed and nothing else. Any other fence is code. A fence is read as CommonMark reads it, so content may hold a shorter fence, and a rewrite that would put a closing line in the content writes the fence longer. An embed that holds content with no fence under it is drawn empty, and its first content writes the fence. Outside Common Ink this reads as one line and a highlighted code block.

**One reader walks a note once** (`readNote`) and says of each line whether it is the note's words, code, a fence, or an embed's content. Markdown content is the note's words, as a board's body was: its todos, tags, links and uploads are the note's. HTML and JSON content are not, as a form's body wasn't. Lines, uploads, references, tags, titles and snippets, and the checks on an agent's write, all read through it.

**The editor draws content as its kind.** Markdown content is parsed as the note's own markdown (`src/web/embedContent.ts`), so while the source is shown a board's checkboxes, `[[links]]` and `#tags` work as they do anywhere in the note. HTML and JSON are code blocks in their language's colours, and JSON is checked as it is typed.

**The cursor opens an embed, as it always has.** With the cursor on an embed, by the arrow keys, vim's motions, a press on its body or a search, it is shown as written, `/name(args)` and its content, in place, before its drawing: an inline embed's text in its line before it, a block's lines above its card. It is drawn again when the cursor leaves. Down from the line above a block goes into its first line, and up from below into its last. A press on an embed's own controls runs them without opening it. **Edit source**, at the foot of the Settings panel every embed a member can change now has, is a second way in: it puts the cursor at the start of the embed's line. The first build of #207 kept an embed drawn whatever the cursor did; in use that left no way to see a plugin's text, so the maintainer had the cursor open it again.

**A name close to an embed's is said so.** `/timr(5m)`, where an embed would be and close to an embed's name by #190's rule for keys (two edits or less, or the start of one), has a quiet hint in the editor, "No embed called timr. Did you mean /timer?", whose fix writes the name. A word nowhere near a name, a path or `/usr/bin(x)`, has none. An agent's write that adds one is refused, saying the same, as a wrong key is.

**The insert menu writes the new form.** `/` lists the embeds as before, and picking one writes `/name(args)`, with an empty fence for one that holds content. `::` no longer opens the menu.

## The conversion

Notes written before this hold `::name{config}` and `:::name{config}` blocks. They are converted once, on the server (`note.convertEmbeds`, `src/core/oldEmbeds.ts`), not as each note is opened, for the reason ADR 19 gives: the index, search, the upload references and every agent read the text, and a note nobody opens would read wrong to all of them, and keep the old reader alive, until someone did. It works as ADR 19's conversion does, so the two can be one later:

- A note that holds `::` is marked when this ships (migration 0068). Once a member who may change notes signs in, the app asks the server to convert, and the server converts each marked note that member may change, a batch at a time, as an ordinary change of theirs labelled "Embeds converted" in the note's history. It can be undone like any change.
- `::name{config}` becomes `/name(config)`, with a space before it where it followed a letter or a digit. One that followed any other mark, inside `**…**` or an address, is left as written: a space there would undo the mark around it, and it shows as the text it is. `:::name{config}` with its body and closing `:::` becomes `/name(config)` with the body in a fence tagged with the embed's kind: `markdown` for a board and a plugin's block, `html`, `json` for a form. An embed inside a board's body is converted with it; an HTML or JSON body is left exactly as it was.
- Code, fenced or inline, a block never closed, and a name that was never an embed's are left as written. A config the parentheses can't hold, as an event's label with a `)` nothing opens or a stray quote, is written without its parentheses, and then without its quotes, so it is still its embed. Running it again changes nothing.
- A write whose text holds an old form again, a revert or a tab or agent from before, marks the note to be converted the next time a member comes in.
- `::contact{ref Name}` becomes a mention of them by name, `[[person:Name]]`, as `@` writes one: a contact is no embed now. One with no name has nothing to name them by, and is left as written.
- `::event{ref label}` is left to ADR 19's conversion, which writes it as `[[event:ref]]`. The two run in one order whichever a member's app asks for first: the conversion of links converts a note's embeds first, as their own change, so an old HTML or JSON block's body is the block's and never read for mentions. A note written before both has "Embeds converted" and then "Links converted" in its history.

## Consequences

- An agent's write of the old form is refused, naming the line and what to write instead, as a wrong key is (#190).
- A plugin's embed name must not be a word people write after a slash in prose. The app's names are, and `x-` names aren't, so `/timer(5m)` in a sentence is a timer.
- An inline embed typed right after a word (`word/timer(5m)`) is text until a space is put between them.
- A revealed board shows one more line than before, its fence's opening line, so a step of the arrow keys through it takes one more press.
