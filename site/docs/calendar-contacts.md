# Calendar and contacts

You can connect your Google Calendar and Google Contacts to see your events and people beside your notes, and to point at them from a note. Only you see them, and Common Ink keeps no copy.

## Connect Google Calendar and Contacts

When you sign in with Google at commonink.app, Google asks whether Common Ink may see and change your calendar events and see your contacts. Google lists each one separately, so you can allow one and untick the other. You can sign in and allow neither.

To connect one later, or after you unticked it:

1. Open **Calendar** in the sidebar, or **Contacts** under **More**.
2. Press **Connect Google Calendar** or **Connect Google Contacts**.
3. Allow it on Google's page. Google sends you back to Common Ink.

Changing a contact needs one more agreement. On a person's page, press **Connect again to edit contacts** and allow it at Google.

If Google stops answering for your account, the page says so and offers **Reconnect** in place of **Connect**.

## Who sees them

Your calendar and contacts are yours, not the workspace's. No other member sees that you connected them, or any event or contact in them, whatever their role. Admins don't see them either. The connection is yours in every workspace you belong to, and leaving a workspace doesn't end it.

Common Ink doesn't store your events or contacts. Each time a page shows one, Common Ink reads it from Google as you. It keeps only the connection, encrypted, and the references your notes hold.

## The Calendar page

**Calendar** shows your events by **Day**, **3 days**, **Week**, **Month**, or **Agenda**. **Today**, and the arrows beside it, move through the days. Times are in your own time zone. An all-day event stays on its dates wherever it is read.

- Press **Calendars** to choose which calendars to show and to pick your **Default calendar**, where new events go.
- Press **New event**, or drag across the grid, to add an event.
- Open an event to see its details and change it. A calendar you can only read, such as a holidays calendar, refuses changes.

A change to an event goes to Google as you. It is not part of a note's history, so Common Ink can't revert it.

The settings **First day of the week** (`calendar.weekStarts`) and **Highlight weekends** (`calendar.weekends`) change how the page draws weeks.

## The Contacts page and person pages

**Contacts** lists your contacts, with a search by name, email, or organization. Press a contact to open their person page.

A person page shows what your contacts hold about that person, which only you see. Press **Edit** to change the contact. The change is written back to Google Contacts. The same page lists the open todos assigned to the person and the lines that mention them, in notes you can see. **New note about** the person makes a note that mentions them.

Type `@` in a note to mention a contact. The note keeps only the name, as `[[person:Sam Okafor]]`, in gray, so anyone who reads the note sees the name and nothing else of your contact. A mention shares nothing. See [Writing notes](/docs/notes).

## Point at an event from a note

A note can reference one of your events without copying it:

```markdown
Agenda for [[event:r8m2k4q9x1cd]]
```

To write one, type `[[` in a note. After your notes, the list offers your events, nearest first. Picking one writes the reference. You can also open an event on the Calendar page, run **Copy event reference** from the command palette, and paste it into a note.

You see the event's title as it is now in Google. Anyone else, and anyone opening the note from a share link, sees "Event". To show words of your own instead, type `|` and the words, as `[[event:r8m2k4q9x1cd|Planning with Sam]]`. Everyone sees those words, so write only what others may read. Click the event to open its details.

To point at a contact, mention them with `@`. An agent that asks `refer_record` for one of your contacts is given the same mention to write, `[[person:Sam Okafor]]`.

An event's details list **Notes about this event**, which are the notes you can see that reference it. **New note about this event** makes one.

## What your agent can do

A connected agent acts as you, so it reaches your calendar and contacts too. Any agent can read your events in a span of time, read your contacts, and read the record a reference of yours stands for. An agent that isn't read-only can also:

- Add an event to a calendar you can add to. With no calendar named, it goes in your default calendar.
- Change your events, where Google lets you change them.
- Write a reference to an event, or a mention of a contact, into a note.

An agent can't change or add contacts, and it can't connect or disconnect Google. An agent limited to some folders gets none of this, because your calendar and contacts are in no folder. See [Agents](/docs/agents).

## Disconnect

Open the **Calendars** dialog or the **Contacts** page and press **Disconnect Google…**. Your calendar and contacts were connected as one Google account, so they disconnect together. References in notes stop showing details and show their words alone. You can connect again at any time.
