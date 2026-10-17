// A timer that belongs to no note: started from the command palette, shown in the bottom bar. There
// is no markdown to hold it, so it is kept in this browser for this workspace. It runs on through a
// reload here, nobody else sees it, and another browser doesn't have it. There is one at a time.
const KEY = "running";
const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

// `1h30m`, `5m`, `90s` in milliseconds, or null for anything else.
function durationOf(written) {
  const match = written ? DURATION.exec(written) : null;
  if (!match) return null;
  const [h = "0", m = "0", s = "0"] = match.slice(1);
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

// A quick timer as it is kept: how long it runs, as typed, and when it was started.
const kept = (value) => (value && typeof value.length === "string" && durationOf(value.length) && typeof value.since === "number" ? { length: value.length, since: value.since } : null);

function left(timer, now) {
  const seconds = Math.ceil(Math.max(0, durationOf(timer.length) - Math.max(0, now - timer.since)) / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// Asks how long, and again for as long as what is answered isn't a length.
async function start() {
  const running = kept(await ink.storage.get(KEY));
  let value = running ? running.length : "5m";
  let error;
  for (;;) {
    const answer = await ink.prompt({ title: "Quick timer", label: "How long", value, error, hint: "Enter starts it in the bottom bar. It is kept in this browser, not in a note." });
    if (answer === null) return;
    value = answer.trim();
    if (durationOf(value)) return ink.storage.set(KEY, { length: value, since: Date.now() });
    error = "Write a length such as 5m, 90s, or 1h30m.";
  }
}

ink.onCommand("start", () => void start().catch(() => {}));
ink.onCommand("stop", () => void ink.storage.set(KEY, null));

if (ink.context.kind === "view") {
  const button = document.createElement("button");
  button.type = "button";
  button.style.color = "var(--accent)";
  button.addEventListener("click", () => void ink.storage.set(KEY, null));
  let timer = null;
  let ticking;
  const show = () => {
    clearInterval(ticking);
    if (!timer) return void button.remove();
    const draw = () => {
      const now = Date.now();
      const done = now - timer.since >= durationOf(timer.length);
      button.textContent = `Quick timer ${left(timer, now)}`;
      button.title = done ? "Dismiss" : "Stop it";
      button.setAttribute("aria-label", `Quick timer, ${done ? "finished" : `${left(timer, now)} left`}`);
      button.style.color = done ? "var(--danger)" : "var(--accent)";
      if (done) clearInterval(ticking);
    };
    ticking = setInterval(draw, 250);
    draw();
    ink.root.append(button);
  };
  ink.onStorage((key, value) => {
    if (key !== KEY) return;
    timer = kept(value);
    show();
  });
  ink.storage.get(KEY).then((value) => {
    timer = kept(value);
    show();
  });
}
