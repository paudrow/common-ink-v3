import type { Plugin } from "../plugin-api.ts";

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** `::stopwatch{}` in a note: a click starts or stops it, and a double click sets it back to zero. Its time isn't kept in the note. */
export const stopwatch: Plugin = {
  id: "stopwatch",
  name: "Stopwatch",
  activate(host) {
    host.embeds.register({
      name: "stopwatch",
      title: "Stopwatch",
      render(el) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "stopwatch";
        button.title = "Click to start or stop. Double-click to reset.";
        let before = 0;
        let startedAt: number | null = null;
        let timer: ReturnType<typeof setInterval> | undefined;

        const show = () => {
          button.textContent = clock(before + (startedAt === null ? 0 : Date.now() - startedAt));
          button.setAttribute("aria-label", `Stopwatch, ${button.textContent}`);
          button.setAttribute("aria-pressed", String(startedAt !== null));
        };
        const stop = () => {
          if (startedAt !== null) before += Date.now() - startedAt;
          startedAt = null;
          clearInterval(timer);
        };
        button.addEventListener("click", () => {
          if (startedAt === null) {
            startedAt = Date.now();
            timer = setInterval(show, 250);
          } else stop();
          show();
        });
        button.addEventListener("dblclick", () => {
          stop();
          before = 0;
          show();
        });
        show();
        el.append(button);
        return stop;
      },
    });
  },
};
