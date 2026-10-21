# Search and the query language

Notes, todos and uploads are found by one query language, written the way GitHub's search is. The Search page, the search bar of every folder's list, the Todos page, the `search`, `list_todos` and `list_uploads` tools and `ink search` / `ink todos` / `ink uploads` all read the same text, with the same parser (`src/core/query.ts`).

    budget "second quarter" #money -is:archived
    editor:@me updated:>=7d (has:open-todo OR has:backlink)
    due:<today priority:>=medium -tag:someday
    type:image uploader:@me used:no size:>1mb

## How a query is read

- A word finds a note with that word, or one that starts with it, ignoring case and accents. `"a phrase"` finds the words together in order.
- A space is AND. `AND`, `OR` and `NOT` are operators only in capitals, so `or` is a word. `-` before a term is NOT, and a NOT of a NOT is read as the term itself. Parentheses group, up to 8 deep, and can't be empty. NOT binds first, then AND, then OR.
- `key:value` is a filter. A value with a space is in quotes: `folder:"Common Ink"`. Days and numbers take `>`, `>=`, `<`, `<=` and a range `a..b`, where `*` leaves a side open.
- `in:` and `sort:` are for the whole query. They are written anywhere outside parentheses, once, and can't be negated.
- A query has at most 40 terms and 200 characters, counted as it is written out in full: `#money` is `tag:money` there, and `-(a b)` is `NOT (a b)`.

A character that is no syntax is read as the words around it, as it always was: `C++`, `it's`, `f(x)` and `+Home` are words, and a quote left open is no phrase. A word with a colon is a filter when what is before the colon is a filter's name. It is an error when that is letters and hyphens alone and names no filter, so a misspelt `titel:x` is said to be one, with the filters nearest to it. It is words when what follows the colon starts with `/`, when what is before it has a digit or another character in it, or when nothing follows: `https://example.com`, `10:30` and `re:` are words. Anything in quotes is words.

A query that can't be read is refused, never answered with nothing: the error says which characters and why. `folder:`, `editor:`, `author:` and `uploader:` name something, and a name that finds nothing is refused too, as `No folder named "X"`, `Nobody named "X" has changed a note you can see` or `Nobody named "X" has uploaded a file you can see`. A folder the asker can't see, and someone who has changed no note, or uploaded no file, the asker can see, are refused in exactly those words, so a refusal never says whether the thing exists, or whether someone is a member.

## Days

A day is `YYYY-MM-DD`, or counted from today: `today`, `yesterday`, `tomorrow`, `7d` for seven days ago, `+7d` for seven days ahead. The server never works out today. The asker says it, as `today`, and a query with a counted day and no `today` is refused. The app and `ink` always say it, from the machine's own clock.

`updated:`, `created:` and `uploaded:` are times, and a day begins and ends where the asker is: `zone` says where, as a time zone's name. Left out, it is the member's zone: the one their setting `daily.timeZone` names, or else the one of the browser they last used Common Ink in, or else UTC. `due:` is a calendar date with no time, so no zone bears on it.

## What a query covers

A search covers live notes. It covers archived notes too when the query says `is:archived` anywhere, and Trash when it says `is:trashed`: so `is:archived` alone is the archived notes, and `budget (is:open OR is:archived)` is both. Todos are the same, and for done ones: a query that says neither `is:open` nor `is:done` anywhere lists only open todos, `is:done` or `-is:open` is the done ones, and `is:open OR is:done` is both.

`is:shared` is true of a note with a grant of its own, a person or a link, and only where the asker may list that note's grants: a member who can share it. For an agent and for a guest it is true of nothing, since neither is told how a note is shared.

`has:backlink` counts only links from notes the asker can see. `editor:` is anyone who has changed the note, and `author:` whoever made its first change.

`in:body` looks in the note's text, which has its heading in it. A todo's words are looked for in its own line, as a note's are: by the start of a word, ignoring case and accents.

`has:attachment` is a note whose text shows an upload: `::image{…}`, `::video{…}`, `::audio{…}` or `::file{…}` outside code, whether or not the asker can see the upload.

## Uploads

An upload's words are looked for in its file's name, anywhere in it, ignoring case (of unaccented letters): `report` finds `Q2-report.pdf`, and the words of a phrase or of `q2-report` are found in that order with anything between them. `name:` is the same for one value, taken as written, `%` and `_` included. `#` is no tag here, and `in:`, `tag:` and `has:` are for notes and todos. A listing covers live uploads, and archived ones and Trash as a search does notes, by `is:archived` and `is:trashed`.

- `type:` (or `kind:`) is `image`, `video`, `audio`, `pdf`, `text` or `other`, the one classification the app and the server share (`fileClass` in `src/core/filetypes.ts`). A PDF is one whose name ends in `.pdf` and whose bytes start `%PDF-`. Text is a file of no other type whose name ends in one of: txt, md, markdown, csv, tsv, json, log, yaml, yml, toml, xml, html, css, js, ts, py, sh, sql. A PDF uploaded before PDFs were told apart is `other`.
- `uploader:` is who uploaded it, a member or an agent, by name, or `@me`. A name is looked for only among those who uploaded a file the asker can see, so a guest or an agent limited to folders is told nothing of anyone else.
- `used:yes` is an upload that a note the asker can see shows, archived notes included, and `used:no` one that none does. A note in another workspace, or one the asker can't see, never counts, and `list_uploads` answers each upload's `uses` by the same count.
- `size:` is in bytes, or with `kb`, `mb` or `gb` after the number (1024 of the one before), and compares: `size:>1mb`, `size:<=500kb`, `size:1mb..5mb`.
- `uploaded:` is the day it was uploaded, compared as `created:` is.
- `is:shared` is an upload with a grant of its own that the asker may list, and `is:private` one private to its owner.
- `sort:` is `uploaded-desc`, which is also the order with none, `uploaded-asc`, `name-asc` or `size-desc`.

## Every form

The tables are generated from `FILTERS` in `src/core/query.ts`, the one place a filter is said: `node scripts/query-docs.ts` writes them, and `test/core/query.test.ts` fails when they differ. The help behind **?** in the app, the `query_syntax` tool and `ink syntax` are the same rows.

<!-- syntax -->
### Notes

| Write | It finds | Example |
| --- | --- | --- |
| `word` | Has the word, or one that starts with it, ignoring case and accents | `budget` |
| `"a phrase"` | Has the words together, in that order | `"second quarter"` |
| `a b` | Both: a space is AND, which can also be written | `budget plan` |
| `a OR b` | Either. OR, AND and NOT are operators only in capitals | `budget OR plan` |
| `-a, NOT a` | Not: before a word, a phrase, a filter or a group | `budget -plan` |
| `( )` | Groups, up to 8 deep. NOT binds first, then AND, then OR | `(budget OR plan) -draft` |
| `key:>DAY, >=, <, <=` | After, on or after, before, on or before a day or a number | `updated:>2026-10-01` |
| `key:A..B` | From A to B, both included. * leaves one side open | `created:2026-10-01..*` |
| `today, yesterday, tomorrow, 7d, +7d` | A day counted from today: 7d is seven days ago, +7d seven days ahead | `updated:>=7d` |
| `#NAME` | Short for tag:NAME | `#money` |
| `key:"a value"` | A value with a space in it is written in quotes | `folder:"Common Ink"` |
| `folder:NAME` | In a folder, named or by its id, or in a folder inside it | `folder:Unsorted` |
| `tag:NAME` | Tagged. #NAME is short for it. A todo has its note's tags | `tag:money` |
| `updated:DAY` | The day the note was last changed | `updated:>=2026-10-01` |
| `created:DAY` | The day the note was made | `created:2026-10-01..2026-10-14` |
| `editor:NAME, edited-by:NAME` | Changed by a member or an agent, by name. @me is you | `editor:@me` |
| `author:NAME` | First written by a member or an agent, by name. @me is you | `author:@me` |
| `mentions:NAME, mention:NAME` | Mentions a person, by name or id. @me is you | `mentions:"Grace Hopper"` |
| `is:open` | Not archived and not in Trash | `is:open` |
| `is:archived` | Archived. A query that doesn't say so leaves archived notes out | `is:archived` |
| `is:trashed` | In Trash. A query that doesn't say so leaves Trash out | `is:trashed` |
| `is:shared` | Shared by itself with a person or by a link, where you may see how it is shared | `is:shared` |
| `is:private` | Private to one member | `is:private` |
| `has:todo` | Has a todo, open or done | `has:todo` |
| `has:open-todo` | Has an open todo | `has:open-todo` |
| `has:link` | Links to another note | `has:link` |
| `has:backlink` | Linked to from a note you can see | `has:backlink` |
| `has:tag` | Has any tag | `has:tag` |
| `has:attachment` | Shows an upload: a picture, a video, sound or a file | `has:attachment` |
| `no:WORD` | Lacks it: the same as -has:WORD | `no:todo` |
| `in:title` | Every word of the query is looked for in the note's title | `budget in:title` |
| `in:body` | Every word is looked for in the note's text, or for a todo in its line | `budget in:body` |
| `sort:updated-desc` | Latest changed first | `sort:updated-desc` |
| `sort:updated-asc` | Longest unchanged first | `sort:updated-asc` |
| `sort:created-desc` | Newest first | `sort:created-desc` |
| `sort:created-asc` | Oldest first | `sort:created-asc` |
| `sort:title-asc` | By the note's title, A to Z | `sort:title-asc` |
| `sort:title-desc` | By the note's title, Z to A | `sort:title-desc` |

### Todos

| Write | It finds | Example |
| --- | --- | --- |
| `word` | Has the word, or one that starts with it, ignoring case and accents | `budget` |
| `"a phrase"` | Has the words together, in that order | `"second quarter"` |
| `a b` | Both: a space is AND, which can also be written | `budget plan` |
| `a OR b` | Either. OR, AND and NOT are operators only in capitals | `budget OR plan` |
| `-a, NOT a` | Not: before a word, a phrase, a filter or a group | `budget -plan` |
| `( )` | Groups, up to 8 deep. NOT binds first, then AND, then OR | `(budget OR plan) -draft` |
| `key:>DAY, >=, <, <=` | After, on or after, before, on or before a day or a number | `updated:>2026-10-01` |
| `key:A..B` | From A to B, both included. * leaves one side open | `created:2026-10-01..*` |
| `today, yesterday, tomorrow, 7d, +7d` | A day counted from today: 7d is seven days ago, +7d seven days ahead | `updated:>=7d` |
| `#NAME` | Short for tag:NAME | `#money` |
| `key:"a value"` | A value with a space in it is written in quotes | `folder:"Common Ink"` |
| `folder:NAME` | In a folder, named or by its id, or in a folder inside it | `folder:Unsorted` |
| `tag:NAME` | Tagged. #NAME is short for it. A todo has its note's tags | `tag:money` |
| `updated:DAY` | The day the note was last changed | `updated:>=2026-10-01` |
| `created:DAY` | The day the note was made | `created:2026-10-01..2026-10-14` |
| `editor:NAME, edited-by:NAME` | Changed by a member or an agent, by name. @me is you | `editor:@me` |
| `author:NAME` | First written by a member or an agent, by name. @me is you | `author:@me` |
| `assignee:NAME, assigned:NAME` | Assigned to a person: mentioned on the todo's line, by name or id. @me is you | `assignee:@me` |
| `is:open` | Not done. A query that says neither is:open nor is:done lists only open todos | `is:open` |
| `is:done` | Done. With is:open OR is:done, both | `is:done` |
| `is:archived` | Archived. A query that doesn't say so leaves archived notes out | `is:archived` |
| `is:trashed` | In Trash. A query that doesn't say so leaves Trash out | `is:trashed` |
| `is:shared` | Shared by itself with a person or by a link, where you may see how it is shared | `is:shared` |
| `is:private` | Private to one member | `is:private` |
| `has:link` | Links to another note | `has:link` |
| `has:backlink` | Linked to from a note you can see | `has:backlink` |
| `has:tag` | Has any tag | `has:tag` |
| `has:due` | Has a due date | `has:due` |
| `has:repeat` | Repeats | `has:repeat` |
| `no:WORD` | Lacks it: the same as -has:WORD | `no:link` |
| `due:DAY` | The day a todo is due. Overdue is due:<today | `due:<today` |
| `priority:LEVEL, importance:LEVEL` | A todo's priority: high, medium, low or none, written !!!, !!, ! or nothing. 3 to 0 read the same | `priority:>=medium` |
| `in:title` | Every word of the query is looked for in the note's title | `budget in:title` |
| `in:body` | Every word is looked for in the note's text, or for a todo in its line | `budget in:body` |
| `sort:updated-desc` | Latest changed first | `sort:updated-desc` |
| `sort:updated-asc` | Longest unchanged first | `sort:updated-asc` |
| `sort:created-desc` | Newest first | `sort:created-desc` |
| `sort:created-asc` | Oldest first | `sort:created-asc` |
| `sort:title-asc` | By the note's title, A to Z | `sort:title-asc` |
| `sort:title-desc` | By the note's title, Z to A | `sort:title-desc` |
| `sort:due-asc` | Soonest due first, and those with no due date last | `sort:due-asc` |
| `sort:due-desc` | Latest due first, and those with no due date last | `sort:due-desc` |
| `sort:priority-desc` | Highest priority first | `sort:priority-desc` |
| `sort:text-asc` | By the todo's words, A to Z | `sort:text-asc` |

### Uploads

| Write | It finds | Example |
| --- | --- | --- |
| `word` | Its name has the word in it, ignoring case | `report` |
| `"a phrase"` | Its name has the words in that order | `"q2 report"` |
| `a b` | Both: a space is AND, which can also be written | `report type:pdf` |
| `a OR b` | Either. OR, AND and NOT are operators only in capitals | `type:image OR type:video` |
| `-a, NOT a` | Not: before a word, a phrase, a filter or a group | `-type:image` |
| `( )` | Groups, up to 8 deep. NOT binds first, then AND, then OR | `(type:pdf OR type:text) used:no` |
| `key:>VALUE, >=, <, <=` | After, on or after, before, on or before a day; larger, at least, smaller, at most a size | `size:>=500kb` |
| `key:A..B` | From A to B, both included. * leaves one side open | `size:1mb..5mb` |
| `today, yesterday, tomorrow, 7d, +7d` | A day counted from today: 7d is seven days ago, +7d seven days ahead | `uploaded:>=7d` |
| `key:"a value"` | A value with a space in it is written in quotes | `folder:"Common Ink"` |
| `folder:NAME` | In a folder, named or by its id, or in a folder inside it | `folder:Unsorted` |
| `name:TEXT` | The file's name has this in it, ignoring case | `name:report` |
| `type:image` | A picture | `type:image` |
| `type:video` | A video | `type:video` |
| `type:audio` | Sound | `type:audio` |
| `type:pdf` | A PDF | `type:pdf` |
| `type:text` | Text to read, by its name's ending: txt, md, markdown, csv, tsv, json, log, yaml, yml, toml, xml, html, css, js, ts, py, sh, sql | `type:text` |
| `type:other` | Any other file | `type:other` |
| `uploader:NAME, uploaded-by:NAME` | Uploaded by a member or an agent, by name. @me is you | `uploader:@me` |
| `used:yes` | A note you can see shows it | `used:yes` |
| `used:no` | No note you can see shows it | `used:no` |
| `size:SIZE` | How big the file is: bytes, or kb, mb or gb | `size:>1mb` |
| `uploaded:DAY` | The day the file was uploaded | `uploaded:>=2026-10-01` |
| `is:open` | Not archived and not in Trash | `is:open` |
| `is:archived` | Archived. A query that doesn't say so leaves archived uploads out | `is:archived` |
| `is:trashed` | In Trash. A query that doesn't say so leaves Trash out | `is:trashed` |
| `is:shared` | Shared by itself with a person or by a link, where you may see how it is shared | `is:shared` |
| `is:private` | Private to one member | `is:private` |
| `sort:uploaded-desc` | Latest uploaded first | `sort:uploaded-desc` |
| `sort:uploaded-asc` | Earliest uploaded first | `sort:uploaded-asc` |
| `sort:name-asc` | By the file's name, A to Z | `sort:name-asc` |
| `sort:size-desc` | Largest first | `sort:size-desc` |
<!-- /syntax -->

## In the app

The search field is a plain text field that takes all of this. As a filter's name or its value is typed it is offered under the field: Tab takes the first offer, the arrows move and Enter takes the one they came to, and Escape closes the list. Folders, tags and people are offered from what the member can already list. A query that can't be read says so under the field, with the part that is wrong marked, and nothing is asked of the server until it reads.

**Advanced**, beside the field, opens the builder: a row for each condition, with its field, is or is not, a comparison where the field has one, and its value. It opens on a first row to fill in, which is no part of the query until it is. **State** is open, archived or in Trash (and done, of a todo), and **Visibility** is shared or private; both are written `is:`. **Add a condition** adds a row, **Match all** or **any** joins them, and there is the order and where words are looked for. Every change is written into the field, and what is typed in the field is read back into the rows. A query rows can't show, one with a group inside it or AND and OR together, stays as it is typed, and the builder says so and changes nothing. **?** in the builder opens the help over the page: every form with what it means and an example, under the builder's headings, and an example is a button that puts it in the field, runs it and closes the help. Escape or its close button closes it and gives the keyboard back to the **?**.

On the Search page the inspector is about the notes found (`useInspected`, labelled "Search" and the query): Info counts them and History is theirs, and both follow the query as it is typed.

The Todos page has the same bar and builder, for todos. Its query is kept in the browser, so the page opens the way it was left. For uploads the builder has no "Words in", its sizes are compared as more or less, and the people it offers for `uploader:` are those who uploaded a file the member can list.

A todo's priority is written `priority:` with a word, `high`, `medium`, `low` or `none`, and compared in that order (`priority:>=medium`). `priority:` is the name the builder, the help and the completions write. `importance:` is another name for it, as `edited-by:` is for `editor:`, and the numbers 3 to 0 read as the words, so a query written before the words still reads; written back, it says `priority:` and the word. `sort:priority-desc` is highest first, and `sort:importance-desc` reads the same.

## For agents

`search`, `list_todos` and `list_uploads` take the query as `query`, with `today` and `zone`. Their older arguments (`folderId`, `hasTodos`, `includeArchived`, `sort`; `tag`, `dueFrom`, `dueTo`, `noDue`, `importance`, `includeCompleted`, `noteId`) still work and narrow the query further: each is turned into the same tree the query is, so there is one way a listing is narrowed. `folderId` on `search` and `list_uploads` is the folder's own notes or uploads, where `folder:` takes in the folders inside it.

Every value in a query is bound, never written into SQL. A statement binds each of its values once, and at most 93 for the largest query the limits allow with every older argument set, under D1's hundred. One that would bind more is refused as `invalid`.
