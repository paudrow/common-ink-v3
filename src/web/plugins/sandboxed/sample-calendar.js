// A day of sample events. The member's own calendar is not read: a plugin that runs shut off is refused event.list.
const style = document.createElement("style");
style.textContent = `
body { margin: 0; color: var(--ink); font: inherit; }
h2 { margin: 12px 14px 4px; font-size: 0.8em; font-weight: 600; color: var(--muted); }
ul { margin: 0; padding: 0; list-style: none; }
li { display: flex; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
time { flex: none; width: 3.2em; color: var(--muted); }
`;
document.head.append(style);

const heading = document.createElement("h2");
heading.textContent = "A sample day";
const list = document.createElement("ul");
list.setAttribute("aria-label", "Sample day");
for (const [at, title] of [
  ["9:00", "Standup"],
  ["12:00", "Lunch"],
  ["3:00", "A walk"],
]) {
  const row = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = at;
  time.dateTime = at;
  row.append(time, document.createTextNode(title));
  list.append(row);
}
ink.root.append(heading, list);
