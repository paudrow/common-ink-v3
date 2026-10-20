# Search

Every folder's list, the Search page, and the Todos page share one search bar and one query language. This page shows how a query is read, how to build one with Advanced, and every filter there is.

## Where you search

A search bar heads every folder's list and shows the folder it searches. With nothing typed, the list is the folder's notes. Type a query and the list becomes the notes in that folder that match, each card with the lines that matched.

The **Search** page in the sidebar is the same list over every note you can see. The Todos page has the same bar for todos, and the Uploads page has it for files. Your agents and the `ink` CLI read the same language.

As you type a filter's name or value, the bar offers completions. Tab takes the first, the arrow keys move, and Enter takes the one you moved to. Folders, tags, and people are offered from what you can already see.

## How a query is read

- A word matches a note that has that word, or a word that starts with it, ignoring case and accents.
- `"second quarter"` matches the words together, in that order.
- A space between terms means AND. `OR` means either. `AND`, `OR`, and `NOT` are operators only in capitals, so `or` is a word.
- `-` before a word, a phrase, a filter, or a group excludes it. `NOT` does the same.
- Parentheses group terms, up to 8 deep. `NOT` binds first, then AND, then OR.
- `key:value` is a filter. Put a value with a space in quotes, as in `folder:"Common Ink"`.
- Dates and numbers compare with `>`, `>=`, `<`, `<=`, and ranges with `a..b`. `*` leaves one side of a range open.
- A day is `YYYY-MM-DD`, or a day counted from today, such as `today`, `yesterday`, `tomorrow`, `7d` for seven days ago, and `+7d` for seven days ahead.
- `#money` is short for `tag:money`, and `no:tag` is short for `-has:tag`.

A query has at most 40 terms and 200 characters.

A search covers live notes. Archived notes are included only when the query says `is:archived`, and Trash only when it says `is:trashed`. So `is:archived` alone lists archived notes, and `budget (is:open OR is:archived)` searches both.

Notes whose title matches come first, then the most recently changed. A `sort:` filter changes the order, and `in:title` looks for the words in titles only.

If the bar can't read a query, it says why under the field and marks the part that is wrong. A misspelt filter is an error, not a search. For `foldr:Projects`, the bar asks whether you meant `folder:`. A word is still read as words when a digit or a symbol comes before its colon, or when nothing or a `/` follows it, as in `10:30`, `re:`, and `https://example.com`.

## Build a query with Advanced

Press **Advanced** beside the bar to open the builder. Each condition is a row with a field, is or is not, a comparison where the field has one, and a value. **Add a condition** adds a row. **Match all** or **Match any** joins the rows. **Words in** and **Sort** set where words are looked for and the order.

Each change is written into the bar, and what you type in the bar is read back into the rows. A query the rows can't show, such as one with a group inside it, stays as you typed it.

Press **?** in the builder to open the query syntax help. Every example in it is a button that runs the query.

## Examples

| To find | Type |
| --- | --- |
| Notes you changed this week that still have an open todo | `editor:@me updated:>=7d has:open-todo` |
| A phrase in one folder and the folders inside it | `folder:Projects "launch plan"` |
| Notes tagged `money` but not `taxes` | `#money -#taxes` |
| Notes with either word in the title | `(budget OR forecast) in:title` |
| Archived notes about the budget | `budget is:archived` |
| Notes made in October that have no tags | `created:2026-10-01..2026-10-31 no:tag` |
| Notes that mention a person | `mentions:"Grace Hopper"` |
| Notes that show a file, oldest change first | `has:attachment sort:updated-asc` |
| Todos assigned to you and overdue, on the Todos page | `assignee:@me due:<today` |
| Large files no note uses, on the Uploads page | `used:no size:>10mb` |

`@me` stands for you in `editor:`, `author:`, `mentions:`, `assignee:`, and `uploader:`.

`folder:`, `editor:`, `author:`, and `uploader:` must name something you can see. A name that matches nothing is refused with a message, so a typo doesn't look like an empty result.

## Every filter

<!-- generated:search-syntax -->
