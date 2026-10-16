import type { Dispose, PluginHost, Upload } from "../../plugin-api.ts";
import { shownTable, tableOf } from "./delimited.ts";
import { firstLines, pagesSaid, pagesShown, previewOf, SHOWS, type Place } from "./previewing.ts";
import { textOf } from "./reading.ts";

/** The most columns of a CSV a preview draws: the rest are for the file's own page. */
const PREVIEW_COLUMNS = 12;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

const endingOf = (name: string) => /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? "";

/** A sheet of paper with its corner folded and the file's ending on it: what a file with nothing to show is shown as. */
function typeIcon(name: string): HTMLElement {
  const box = el("div", "upload-type-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 48 60", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path")).setAttribute("d", "M30 2H6a4 4 0 0 0-4 4v48a4 4 0 0 0 4 4h36a4 4 0 0 0 4-4V18zM30 2v16h16");
  box.append(svg);
  const ending = endingOf(name);
  if (ending) box.append(el("span", "upload-type-ending", ending));
  return box;
}

/** What a preview tells whoever drew it: what it says of the file beside it, such as how many pages it has, or nothing once it has nothing to say. */
export interface Told {
  said?(words: string): void;
}

/**
 * Draws a preview of `upload` into `into`, as much of it as `place` shows: the same in a note, in the
 * Uploads page's panel and over the app. Text is only ever put in the page as text, and a PDF only
 * as pictures of its pages. Returns what stops it: a PDF being drawn, a player playing.
 */
export function drawPreview(into: HTMLElement, host: PluginHost, upload: Pick<Upload, "id" | "name" | "type" | "size">, place: Place, told: Told = {}): Dispose {
  const preview = previewOf(upload);
  const shows = SHOWS[place];
  const address = host.uploads.address(upload.id);
  into.dataset.shows = preview.shows;
  let stopped = false;
  let stop = () => {};
  const unread = () => !stopped && into.replaceChildren(typeIcon(upload.name));

  switch (preview.shows) {
    case "picture": {
      const img = el("img", "upload-preview-picture");
      img.alt = upload.name;
      img.draggable = false;
      img.decoding = "async";
      img.src = address;
      into.replaceChildren(img);
      break;
    }
    case "player": {
      const player = el(preview.media, `upload-preview-${preview.media}`);
      player.controls = true;
      player.preload = preview.media === "video" ? "metadata" : "none";
      player.src = preview.media === "video" ? `${address}#t=0.001` : address;
      into.replaceChildren(player);
      stop = () => player.pause();
      break;
    }
    case "pages": {
      const pages = el("div", "upload-pages");
      pages.setAttribute("aria-busy", "true");
      into.replaceChildren(pages);
      const failed = () => {
        if (stopped) return;
        told.said?.("");
        into.replaceChildren(typeIcon(upload.name), el("p", "upload-preview-said", "This PDF couldn't be drawn. Download it to read it."));
      };
      // A PDF is never larger than an upload can be.
      Promise.all([host.uploads.bytes(upload.id, 50 * 1024 * 1024), import("./pdf.ts")])
        .then(([bytes, { drawPages }]) => (stopped ? null : drawPages(pages, bytes, shows.pages, shows.pageHeight)))
        .then((drawn) => {
          if (!drawn) return;
          drawn.done.catch(failed);
          if (stopped) return drawn.stop();
          stop = drawn.stop;
          pages.removeAttribute("aria-busy");
          told.said?.(pagesSaid(drawn.count, pagesShown(drawn.count, place)));
        }, failed);
      break;
    }
    case "rows":
    case "lines": {
      host.uploads.bytes(upload.id, shows.bytes).then((bytes) => {
        if (stopped) return;
        const read = textOf(bytes, upload.size);
        if (read.kind === "binary") return unread();
        if (preview.shows === "rows") {
          const table = shownTable(tableOf(read.text, preview.separator, shows.rows + 1), { columns: PREVIEW_COLUMNS, cells: shows.rows * PREVIEW_COLUMNS + PREVIEW_COLUMNS });
          into.replaceChildren(rowsOf(table.rows));
          if (table.rowsCut || read.cut) told.said?.(`the first ${Math.max(0, table.rows.length - 1)} rows`);
        } else {
          const { lines, more } = firstLines(read.text, shows.lines);
          into.replaceChildren(el("pre", "upload-preview-lines", lines.join("\n")));
          if (more || read.cut) told.said?.(`the first ${lines.length} lines`);
        }
      }, unread);
      break;
    }
    case "icon":
      into.replaceChildren(typeIcon(upload.name));
      break;
  }
  return () => {
    stopped = true;
    stop();
  };
}

function rowsOf(rows: string[][]): HTMLElement {
  const table = el("table", "upload-preview-rows");
  const [head, ...body] = rows;
  if (head) {
    const tr = table.appendChild(el("thead", "")).appendChild(el("tr", ""));
    for (const cell of head) tr.append(Object.assign(el("th", "", cell), { scope: "col" }));
  }
  const tbody = table.appendChild(el("tbody", ""));
  for (const row of body) {
    const tr = tbody.appendChild(el("tr", ""));
    for (const cell of row) tr.append(el("td", "", cell));
  }
  return table;
}
