# 4. Recurrence is a token, the count is on the line, and a completion is one act of the server

Status: accepted by the owner of #20 on 2026-10-11, without the maintainer, who issue #20 says should confirm the token syntax. Overrule it here if it is wrong.

## Context

Issue #20 asks for todos that recur, set through a chip, with a chip that says when one was last done and how many times and opens its history. Checking one off keeps the line, moves its due date, and adds the checked line to the completer's daily note. ADR 3 settled that a todo is its line and has no id, and left two ways to check a box: `todo.set`, and any edit of the note's text.

## Decision

**The rule is one token, `every:<rule>`.** It sits beside `due:` and reads the same way: lower case, standing alone, the first readable one counts, anything else is words. The rules are `2w` (d, w, m, y), `3d-after-done`, `mon,thu`, `3rd-day`, `last-day`, `2nd-last-day`, `2nd-tue`, `last-fri`, `2nd-last-fri`. Each rule has one spelling, so a line is never rewritten to say the same thing another way. `docs/todos.md` has the table and what each gives.

**"Every N" and "N after the due date" are one rule.** Issue #20 lists them apart. `every:3d` is the due date plus N, and again until it is ahead of the day it was done, so a late completion skips what was missed. A form that added N once and stopped left a todo done months late overdue for good, a few days further on each time it was checked. Made to catch up, it is the plain rule, so there is no `-after-due`. `every:3d-after-done` counts from the day it was done.

**A day of the month is an ordinal, not a count of days.** Issue #20 says "N days from the start or end of the month", which could put N = 1 on the 1st or the 2nd. `3rd-day` and `last-day` can be read only one way, and `2nd-last-day` and `2nd-last-fri` fall out of the same form. A day the month doesn't have gives the nearest end of the month. A 5th weekday the month doesn't have skips the month, since nobody means the 4th by it.

**The last day done and the count are on the line: `done:2026-10-10x12`.** The alternative was to count completions in the record. A todo has no id, so the record can only find a todo's completions by following its line through every later change, which loses a line that is cut and pasted, and costs a replay of the note's changes each time a note is drawn. On the line, the count goes where the line goes, an agent reads it without another call, undoing a completion takes it back with the due date, and the chip that shows it has a token to stand on, which the editor's rule that nothing moves between drawn and as written needs. The line is rewritten on each completion either way, for its due date.

**The history is in the record.** A `completions` row is written with each completion: the day, who, the daily note, and where the line started. `todo.history` follows those places forward to the line asked about. It is asked for only when the chip is opened. It can come up shorter than the count, for a line that was moved by cut and paste or whose count was typed in by hand, and says so.

**A completion is the server's, whichever way the box was checked.** `todo.set` completes through `completeTodo`. A `note.write` that checks a recurring todo's box is completed by the same function when it lands, and the writer is answered with the line rolled forward. So the editor's checkbox, a typed `x`, vim, the CLI and an agent rewriting the note all do one thing, and no client can get it wrong or skip the daily note. A write checked a todo off when the line was an open todo before it and is a done, recurring one after it. The line is followed by where the write's changes are, not by what it says, so typing on the line in the same save doesn't lose the completion. The editor's checkbox saves at once.

**It is one batch.** The change to the todo's note, the change to the daily note or the making of it and its folder, and the completion's row succeed or fail together. A member's daily note for a day is a row in `daily_notes` with that as its key, so two completions at once make one note: the one that loses runs again and adds to it.

**Asked twice, done once.** `todo.set` follows the line it was shown through the note's changes, as ADR 3 has it, and changes nothing when that line already reads as the call would leave it: for a recurring todo, with the due date and count this call gave it. A write sent again is rebased on the note as it stands, where a completion has been recorded on that line since the revision the write was based on: its box is left open and nothing is filed. Someone else's edit to the line since then doesn't stop the completion.

**Daily notes are private by default, and words are filed only where their readers could read the todo.** A filed line copies a todo's words out of its note. Private keeps them with the one who checked it off. A member turns that off in settings, and then the words are filed only when neither note is private and nothing is shared on either or on a folder above them. Otherwise the link back is filed alone.

**Taking a completion back takes its filed line back.** The completion's row keeps the daily note's revision and the place the line was filed at. A change that takes the completion out (undo, revert, reverting an author) records, in the same batch, a change to the daily note that removes that line, found by following its place and left alone if the member has edited it. Putting the completion back files it again unless it is still there.

**A member's daily notes don't keep them from leaving.** They were made private for the member, not by them. On leaving they are released as a removed member's private notes are.

**The day is the completer's.** The app sends `on`, today in the browser's zone. With none, as an agent may leave it, the server uses the zone the member's `daily.timeZone` setting names, or UTC.

**Amended 2026-10-13: the grammar is wider, still one token and one spelling a rule.** The maintainer asked for version 1's rules along with its editor. The token now also writes every Nth week on chosen days (`2w-mon,thu`), several days or weekdays of a month (`1st-day,15th-day`, `1st-tue,3rd-tue`), every Nth month of those (`3m-last-fri`), a date or a weekday of a month every year (`mar-1`, `1st-mon-mar`, `2y-mar-1`), and an end (`-until-2026-12-31`, `-times-5`). Every spelling read before reads as the same rule. `Rule` is one shape in place of four kinds: a unit and a count, what it picks out of each period, where it counts from, and its end. One spelling still: every one is written with no number, a list has one order, and an end comes last. The days of a week alone were read in any order before this and still are.

**The end is in the token, not a token of its own.** Version 1 wrote `until:` and `times:` beside `rec:`. Here a rule with its end is one construct: one chip in the editor, shown as written only while the cursor is on it, and one `every` value in a listing, in `todo.set`, on the command line and in an agent's call. Two more tokens would be two more chips on a line for one thing a member reads as one ("every month · 5 left"), and a count left on a line whose rule was taken away. The cost is that a completion rewrites the rule's token to count down, as it already rewrites the due date and the `done:` mark. The count is what is left, counting the one due now, so `-times-1` is the last and no line ever says none. The last time checks the todo off for good and leaves its tokens as written, so opening it again finds the rule it had.

**A skip is a change, not a completion.** `todo.set` with `skip` moves the due date as checking the todo off would and writes no `done:` mark, no row in `completions` and nothing on a daily note. It is refused where there is no later occurrence to move to.

**Not taken from version 1:** `RRULE:` spellings, a day of the year (`day-50`), rules typed in words ("every other week"), and the menu of a task's fields. The first two are ways to say twice what the token says once or what nobody asked for, and the last two are features of their own.

## Considered

- **`every:` in words, such as `every:2 weeks` or `every:monday`.** A token can't hold a space, and whole words give each rule several spellings.
- **iCalendar's `RRULE`.** It covers everything and nobody types it.
- **Completing in the browser, by having the checkbox call `todo.set`.** A typed `x`, vim and an agent's `write_note` would still check the box without completing, and each new client would have to learn the rule.
- **Leaving a typed `[x]` on a recurring todo as a plain check.** It would be a way to end a recurring todo, and a way to lose a completion by using the keyboard. Taking `every:` away ends it.
- **A counter and no date, or a date and no counter, on the line.** The chip shows both, and neither can be had from the other.
- **Daily notes open to the workspace, with nothing filed from a private note.** Who can see a todo is decided by grants on its note and the folders above it, per member, so "private" is not one bit to test.

## Consequences

- `every:1m` on the 31st drifts to the 28th after February, since the line holds only the latest due date. `every:last-day` and `every:31st-day` don't, and the editor of a rule says so and offers the last day when a rule lands past the 28th.
- Taking back a completion made by someone else changes that person's daily note, which may be private to them, as a change by whoever took it back. They are told only of daily notes they can see.
- Reverting an agent's changes takes out the heading of a daily note the agent's completion made, since that change was the agent's. The note is still the member's daily note for the day.
- The server reads three of a member's settings (`daily.folder`, `daily.private`, `daily.timeZone`) to act for them. It still tells an agent none of them.
