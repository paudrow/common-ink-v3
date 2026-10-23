# Security audit follow-up, 23 October 2026

This follow-up covers the two areas that the [22 October audit](audit-2026-10-22.md) recorded as not covered. It audits `main` at `ac488ee1`, after #203:

1. Parsing another person's note text in the reader's browser, where slow or superlinear parsing could stall the tab.
2. Data dropped or pasted into a note from another site's page.

It follows Cloudflare's [security-audit skill](https://github.com/cloudflare/security-audit-skill) in its scoped `quick` profile:

- two hunters, one for each area;
- one final coverage critic;
- the parent's own timing of every regex literal in `src/web` and `src/core` under V8, the engine Chromium uses;
- a fresh reviewer of the fixes.

Three findings are confirmed. Each is fixed in #210 as one change, and each change's test fails on `main` and passes with the fix. One candidate needs a check that this machine can't make. One area turned up nothing.

This document names each finding's root cause, the files involved, the fix and the test. The regression tests hold the exact inputs that reproduce each finding, so this document doesn't restate them.

## Findings, by severity

| # | Finding | Severity | Reproduced | Status |
|---|---|---|---|---|
| 1 | A note of many forms costs seconds of work on every read | medium | yes | fixed in #210 |
| 2 | A long run of spaces in a note's words stalls the reader's tab | medium | yes | fixed in #210 |
| 3 | Runs of spaces or `#`s in a heading, a board heading or a table cell stall the tab | low | yes | fixed in #210 |
| 4 | The app's own drag types are trusted from any drag source | — | no | needs validation |

Severity follows the skill's scale, as in the 22 October audit. In each confirmed finding, the text came from someone other than the person whose tab or request did the work: another member, a guest with edit access, an agent or a plugin. The person affected was anyone who opened the note, including an anonymous visitor with a share link. Nothing found reads or changes data across a boundary.

## Confirmed and fixed

### 1. A note of many forms costs seconds of work on every read

**Root cause.** For each line, `linesOutsideCode` (`src/core/lines.ts`) checked every `:::form` block in the note. The cost was lines × forms. The Worker runs it several times on every note read (`note.read` in `src/core/operations.ts`: links, mentions and uploads), and the browser runs it from the tags, todos, links and mentions fields.

**Reproduced.** On a note near the size limit, each read took about 20 s in the dev Worker, and the note's share link did not open within 5 minutes. On the old code, `test/core/long-lines.test.ts` "a note of many forms" took 4.6 s against a 200 ms budget.

**Fix.** The form spans come in order, so a pointer walks them once.

### 2. A long run of spaces in a note's words stalls the reader's tab

**Root cause.** This is in `@lezer/markdown` 1.8.0, not in the app. Its `HardBreak` inline rule looks from each space to the end of the run of spaces, so a run costs time quadratic in its length. It is reached wherever note text is parsed as Markdown: the editor, the note and file readers, the share page, a table cell, a todo's links, and Markdown in a code block, a file or a plugin's source.

**Reproduced.** In node, 80,000 spaces took 13.7 s to parse. In Chromium, a share-link visitor's tab stalled for seconds while it read such a note.

**Fix.** `src/web/plugins/lib/markdownSpaces.ts` adds `spaceRuns`, an inline rule placed before `HardBreak`. It takes a run of spaces in one step, unless the run is a hard break, which it leaves to the parser's own rule. Every `markdown()` call uses it. The two direct parses (`tables/inline.ts`, `todos/linksOut.ts`) use `noteParser`. Code-block and file highlighting go through `withSpaceRuns(languages)`. The fuzz in `test/node/markdown-spaces.test.ts` checks that the parse trees are the same as before.

### 3. Runs of spaces or `#`s in a heading, a board heading or a table cell stall the tab

**Root cause.** Several patterns ran on note text in the browser:

- `[ \t]*$` before a heading's closing marks, in `src/web/plugins/gfm/marks.ts`;
- the kanban `HEADING` and `COLOURED` patterns, and the copy of `HEADING` in `colourColumn`, in `src/web/plugins/kanban/board.ts`;
- `\s*\n\s*` on a table cell, in `src/web/plugins/tables/table.ts` and `rendering.ts`;
- `#+$` on a title, in `src/core/markdown.ts`.

V8 tries each again from every position in a run, so each is quadratic in Chromium. workerd stops a pattern that backtracks too long and finishes it with a linear engine, which is why the 22 October audit measured `#+$` as fast there.

**Reproduced.** Every case was measured in Chromium on `main`:

- reading the heading marks stalled a share-link visitor's tab;
- drawing a board stalled the tab, and so did recolouring one of its columns;
- typing in a table cell stalled it.

The tests in `test/browser/long-lines.spec.ts` and `test/node/backtracking.test.ts` fail on `main` and pass with the fix.

**Fix.** Each pattern is now a loop that makes one pass. Fuzzing against the old patterns, 400,000 inputs and 147,274 headings for `colourColumn`, found no differences.

## Needs validation

### 4. The app's own drag types are trusted from any drag source

`carried()` in `src/web/dragged.ts` acts on the `application/x-common-ink-note` and `application/x-common-ink-tab` types without checking that the drag began in this window. So does the folder row's drop handler in `src/web/plugins/folders.tsx`, which moves the note it names. The app's other drop targets do check: folder drags, links, Manage tables and kanban each check a drag they started themselves.

- In Chromium, a drag that began in a run HTML embed did not deliver the type, and nothing moved.
- A drag from another window or another site couldn't be tested here, and that is the open case.

Recommended fix (open question 1): `carry()` writes a random per-drag token under its own type, and every drop checks it.

## Covered with no finding

- **Dropped and pasted files.** A note writes an upload's embed from the server's id, kind and size, never from the file's name. The name is bounded, and escaped when downloaded. The server sniffs the file's type. Recording only uploads the microphone's audio.
- **Dropped and pasted text and HTML.** CodeMirror takes `text/plain`. Table-cell paste takes `text/plain`. HTML embeds keep their Run step.
- **Links dropped from other sites.** A dropped link opens a tab only when it is the app's own address, and a navigation can't leave the app's origin.
- **Bullet drag in #195.** It uses pointer events and reads no drag data. The other open PRs (#188, #189, #190, #193, #204) add no superlinear patterns on note text that we could see.

## Hardening notes

- The date chip's `OPEN` pattern (`src/web/plugins/dates/drawing.ts`) is quadratic in V8, but the app didn't reach it on a long line when we tried. A last-bracket scan would make it linear.
- `below.ts` `read()`, `embedding.ts` `inlineDrawn` and the math formula skip each check every block for each item. A lookup over the sorted blocks would avoid that.
- `Math.min(...)` and `Math.max(...)` over very large arrays overflow the stack. This is in `kanban/board.ts` (a card followed by very many indented lines) and `tables/table.ts` (a table of very many rows), and the board or table then isn't drawn. A loop avoids it.
- Table cells are `contentEditable` with no drop handler, so a `text/html` drop puts sanitized markup in the cell. The CSP and the `textContent` read stop any effect. `plaintext-only` would remove the case.
- `carried()` doesn't check a page tab's path with `keepsATab`, so a bad path is stored in the layout before navigation refuses it.

## Not covered, for a next run

- **The upload file page.** It draws up to 2 MiB of Markdown with the drawing plugins, and CSV and TSV through `FileTable`. The fixes above make the same parsers linear, but this page wasn't hunted.
- **The Worker's write path.** Finding 1's fix makes its form scan linear too. The rest of the path, and `export.ts`, weren't hunted.
- **Inbound email.** The `email()` handler is an entry point for any sender. The timing scan flagged patterns in `src/core/mail.ts` and `src/core/logs.ts`.
- **The Chrome clipper extension.** It was out of scope, as on 22 October.

## Open questions

1. Should the app's own drag types be tied to a drag that started in this window? Recommendation: yes, with a random per-drag token. Separately, check a drag from another window in Firefox and Safari.
2. Should the `HardBreak` slowdown be reported to `@lezer/markdown`? Recommendation: yes, so the app's own rule can be dropped once upstream fixes it. Filing it goes to an outside project, so it's Audrow's to file or approve.
3. Should the next audit run cover the four areas above, starting with inbound email? Recommendation: yes. Email is the only entry point here that anyone outside the allowlist can reach.

## How it was done

- **Agents.** 2 hunters, 1 final critic and 1 reviewer of the fixes. The critic found one gap in scope, the upload file page, which is deferred as the `quick` profile requires. It also mapped three gaps out of scope.
- **Evidence.** Agents read source only. The parent ran the timing scan and the browser checks with the repository's own tests and dummy accounts, on a dev server on this machine.
- **Records.** The skill's coverage ledger, checked by its validator, is kept outside the repository at `~/security-audit-skill/common-ink-v3/run-3/`.
