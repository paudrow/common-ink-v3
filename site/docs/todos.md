# Todos

A todo is a checkbox line in a note, with its priority, due date, repeat, assignees, and tags written on the same line. This page shows how to write each one, what checking off a repeating todo does, and how to work with the Todos page and daily notes.

## Write a todo

Start a list item with a checkbox anywhere in a note outside a code block:

```markdown
- [ ] !! Call the bank due:2026-10-14 every:1m @[[Sam Okafor]] #money
```

Any list mark works (`-`, `*`, `+`, `1.`), at any indent. `- [x]` is a done todo, `- [-]` one you won't do, and `- [>]` one put off in the backlog. An abandoned todo is struck through and a backlogged one is dimmed. Both stay in their note and leave the Todos page until you ask for them with `is:abandoned` or `is:backlog`. Click either one's box to open it again. The editor draws each option as a chip. Click a chip to change it from a popover instead of typing.

| Part | Written | Notes |
| --- | --- | --- |
| Priority | `!`, `!!`, `!!!` | Low, Medium, High. Right after the checkbox. With none it is None |
| Due date | `due:2026-10-14` | A calendar date as `YYYY-MM-DD`, with no time. Typing `due:` offers the days ahead |
| Repeat | `every:2w` | One of the rules below |
| Assignee | `@` and a name | A mention on the line. A todo can have several |
| Tag | `#money` | Tags the whole note. Every todo in a note has the note's tags |

The due date's popover offers **Today**, **Tomorrow**, **Next week**, **Clear**, and a date field. The priority's offers High, Medium, Low, and None.

A due date is a day, so whether a todo is due today depends on your own time zone. A todo is overdue when its due date is before today.

## Make a todo repeat

Write `every:` and a rule. Each rule has one spelling, in lower case, with commas and no spaces. These are the most useful:

| Written | Repeats |
| --- | --- |
| `every:1d`, `every:2w`, `every:1m`, `every:1y` | Every N days, weeks, months, or years after the due date |
| `every:3d-after-done` | N days after you last checked it off |
| `every:mon,thu` | On those days of every week |
| `every:mon,tue,wed,thu,fri` | Every weekday |
| `every:2w-mon` | On Monday of every second week |
| `every:1st-day`, `every:15th-day` | On that day of every month |
| `every:last-day` | On the last day of every month |
| `every:2nd-tue`, `every:last-fri` | On that weekday of every month |
| `every:mar-1` | On that date every year |
| `every:1st-mon-sep` | On that weekday of that month every year |
| `every:1m-times-5` | Monthly, 5 more times, then it stops |
| `every:mon-until-2026-12-31` | Every Monday until that day |

For a rule like `every:2w`, a todo you check off late moves past the dates you missed, so it is never left overdue. A month too short for `every:31st-day` uses its last day. Use `every:last-day` to stay on the month's end.

You don't have to type a rule. The Repeat chip's popover offers **Doesn't repeat**, **Daily**, **Weekdays**, a weekly and a monthly rule from the due date, **Yearly**, and **Custom**, which builds any rule as a sentence. Press **Done** to save.

## Check off a repeating todo

Checking off a repeating todo does three things at once:

1. The line stays open, with its next due date.
2. Its `done:` mark records the day and how many times it has been done.
3. A checked copy of the line, with a link back to its note, goes at the end of your daily note for that day.

```markdown
- [ ] Water the plants due:2026-10-17 every:1w #home done:2026-10-11x1
- [x] Water the plants due:2026-10-10 #home [[k3j5h8d9f0a1]]
```

The first line is the todo after you checked it off on the 11th. The second is the copy on your daily note. The result is the same whether you check the box in the note, on the Todos page, or an agent does it.

The **Task completed** notice has an **Undo** button. Undo puts the line back and takes the copy off your daily note. To skip one occurrence without checking it off, open the due date's popover and pick **Skip to** the next date.

To stop a todo repeating, pick **Doesn't repeat**, or remove the `every:` token. A rule with an end, such as `-times-5`, checks the todo off for good on its last time.

## Assign a todo

Type `@` on the todo's line and pick a member or one of your contacts. Assigning gives the person no access to the note and doesn't notify them. On the Todos page, press an assignee's chip to change who the todo is assigned to. A todo with nobody has an **Assign** chip in that place.

## The Todos page

**Todos** in the sidebar lists the open todos in every note you can see, leaving out archived notes and notes in Trash. Each row shows the todo, its chips, and its note's name. Press the note's name to open the note at that line. Press the words to edit them in place. Right-click a row for **Open note** and **Open to the side**.

The query bar at the top narrows the list. It reads the same language as search, so `assignee:@me due:<=today` lists what is yours and due. **Advanced** builds a query by picking. **Sort** orders the list by **Due date**, **Priority**, **Recently changed**, **Note**, or the todo's words. A few queries to start from:

| Query | Lists |
| --- | --- |
| `due:<today` | Overdue todos |
| `assignee:@me` | Todos assigned to you |
| `priority:>=medium #work` | Medium and High todos tagged `work` |
| `has:repeat` | Repeating todos |
| `is:done updated:>=7d` | Done todos in notes changed in the last week |
| `is:backlog` | Todos put off in the backlog |
| `is:open OR is:backlog` | Open todos and the backlog together |

[Search](/docs/search) lists every filter.

## Daily notes

A daily note is your note for one day, headed with the date, as in `# 2026-10-11`. The app makes it the first time it is needed, such as when you open today's note or check off a repeating todo. It goes in the **Daily** folder at the top of the workspace, and it is private to you.

Open it from **Today** in the sidebar, or with these commands:

- **Open today's daily note**
- **Yesterday's note** and **Tomorrow's note**
- **Previous day** and **Next day**, from a daily note

Three settings change how daily notes behave:

| Setting | Default | What it does |
| --- | --- | --- |
| `daily.folder` | `Daily` | The top-level folder new daily notes go in |
| `daily.private` | `true` | Whether a new daily note is hidden from other members |
| `daily.timeZone` | none, which is UTC | The time zone an agent uses for "today" when it doesn't say the day |

A todo's words are filed only where everyone who reads the daily note can read the todo. That is when your daily note is private and shared with nobody, or when neither note is private and neither they nor their folders have a grant or a share link. Anywhere else the copy is a link alone, without its words.
