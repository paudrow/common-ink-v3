import { uploadIn, type BelowDrawn, type BelowEmbedded, type Dispose, type Embed, type PluginHost, type ReferredTo, type Upload, type UploadEmbed } from "../../plugin-api.ts";
import { sizeHandle } from "./handle.ts";
import { filePath, openingOf, openUpload, previewUpload } from "./opening.ts";
import { previewOf } from "./previewing.ts";
import { drawPreview } from "./previews.ts";
import { boxFor, cardHeight, formatBytes, KIND_LABEL } from "./sizing.ts";

export const UNAVAILABLE = "This file isn't available";
export const IN_TRASH = "This file is in Trash";

/** What a note that refers to an upload is told of it, out of all there is to say of one. */
export const toldOf = ({ name, type, kind, size, width, height, state }: Upload): NonNullable<ReferredTo> => ({ name, type, kind, size, width, height, state });

/** Everything of an upload that a drawing of it shows, so one is drawn again only when some of that is different. */
const said = (info: ReferredTo | undefined) => (info === undefined ? "?" : info === null ? "" : [info.name, info.type, info.kind, info.size, info.state].join("\n"));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/** In place of an upload that can't be shown. For one the reader can't see it says nothing of the file: not its name, its type or its size. */
function missing(words: string, name?: string) {
  const box = el("div", "upload-missing");
  box.append(el("span", "upload-missing-words", words));
  if (name) box.append(el("span", "upload-missing-name", name));
  return box;
}

function paperclip() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "1em", height: "1em", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path")).setAttribute("d", "M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6zM9 2.5V6h3.5");
  return svg;
}

const TITLE: Record<UploadEmbed, string> = KIND_LABEL;

/** What a picture, a video or a recording says of itself on hover: its name, then its kind, its size if it has one, and how much it holds. */
const detailsOf = ({ name, kind, width, height, size }: NonNullable<ReferredTo>) => `${name}\n${[KIND_LABEL[kind], width && height ? `${width} × ${height}` : null, formatBytes(size)].filter(Boolean).join(" · ")}`;

/**
 * The embeds that show an upload where a note refers to one: `::image{id 640x480 medium}`, `::video{id 640x360}`,
 * `::audio{id}` and `::file{id}`. A picture, a video and a recording are all below their line, and
 * nothing of them is in it. What each knows of its upload is what the host was told by the read
 * of the note, and its bytes come from the address the host gives, so on a link's page they come by the link.
 * `pick` is how a menu sends a file into a note, where one can be sent.
 */
export function uploadEmbeds(host: PluginHost, pick?: Embed["pick"]): { embeds: Embed[]; stop: Dispose } {
  const drawn = new Set<() => void>();
  const asked = new Set<string>();
  const stop = host.uploads.onReferred(() => {
    for (const again of [...drawn]) again();
  });

  /** Whether there is an app here to preview a file over, which a link's page hasn't. */
  const previews = () => typeof host.app().toggleOverlay === "function";

  /**
   * A link that opens a file as its kind of file opens: text in the app, and a picture, a video, a
   * recording or a PDF in a preview, where there is an app to show them in, and anything else is
   * saved under its name.
   */
  const opener = (link: HTMLAnchorElement, id: string, info: NonNullable<ReferredTo>) => {
    const address = host.uploads.address(id);
    const how = openingOf(info);
    if ((how === "app" && typeof host.app().go === "function") || (how === "preview" && previews())) {
      link.href = how === "app" ? filePath(id) : address;
      link.title = `Open ${info.name}`;
      link.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openUpload(host, { id, name: info.name, type: info.type });
      });
    } else {
      link.href = address;
      link.download = info.name;
      link.title = `Download ${info.name}`;
    }
    return link;
  };

  /** A file as a chip among words: its name and its size, which opens it. */
  const chip = (id: string, info: NonNullable<ReferredTo>) => {
    const link = opener(el("a", "file-chip"), id, info);
    link.append(paperclip(), el("span", "file-chip-name", info.name), el("span", "file-chip-size", formatBytes(info.size)));
    return link;
  };

  /** An upload nothing was said of, as one typed or pasted into a note since it was read, is asked about once. */
  const known = (id: string) => {
    const info = host.uploads.referred(id);
    if (info !== undefined || asked.has(id)) return info;
    asked.add(id);
    host.perform({ type: "upload.read", id }).then(
      (upload) => host.uploads.learn([{ id, upload: toldOf(upload) }]),
      (err: unknown) => (err instanceof Error && "code" in err && err.code === "not_found" ? host.uploads.learn([{ id, upload: null }]) : void asked.delete(id)),
    );
    return info;
  };

  /** Draws with what is known of an upload now, and again each time that is different, and never otherwise. */
  const live = (id: string, draw: (info: ReferredTo | undefined) => void): Dispose => {
    let was = said(known(id));
    draw(host.uploads.referred(id));
    const again = () => {
      const info = host.uploads.referred(id);
      if (said(info) === was) return;
      was = said(info);
      draw(info);
    };
    drawn.add(again);
    return () => void drawn.delete(again);
  };

  function media(embed: Exclude<UploadEmbed, "file">, id: string, info: ReferredTo | undefined): Node[] {
    if (info === undefined) return [];
    if (info === null) return [missing(UNAVAILABLE)];
    if (info.state === "trashed") return [missing(IN_TRASH, info.name)];
    // Written as one kind and uploaded as another: it is offered as the file it is.
    if (info.kind !== embed) {
      const box = el("div", "upload-missing");
      box.append(chip(id, info));
      return [box];
    }
    const address = host.uploads.address(id);
    if (embed === "image") {
      const img = el("img", "upload-image");
      img.alt = info.name;
      img.title = detailsOf(info);
      img.draggable = false;
      img.decoding = "async";
      // Hidden from the member since the note was read, or gone: the same words either way.
      img.addEventListener("error", () => img.parentElement?.replaceChildren(missing(UNAVAILABLE)));
      img.src = address;
      return [img];
    }
    const player = el(embed, `upload-${embed}`);
    player.controls = true;
    player.preload = embed === "video" ? "metadata" : "none";
    player.title = detailsOf(info);
    // A video shows its first frame before it is played: a browser that shows nothing until then is asked for the frame at its start.
    player.src = embed === "video" ? `${address}#t=0.001` : address;
    return [player];
  }

  /** A picture, a video or a recording, drawn below its line, with a handle to size a picture or a video for a member who can change the note. */
  function below(embed: Exclude<UploadEmbed, "file">, into: HTMLElement, first: BelowEmbedded): BelowDrawn {
    let now = first;
    let retell = () => {};
    let stop: Dispose | undefined;
    const start = () => {
      const id = uploadIn(now.config);
      if (!id) return;
      stop = live(id, (info) => {
        const nodes = media(embed, id, info);
        if (embed !== "audio" && !now.readOnly && info && info.state !== "trashed" && info.kind === embed) {
          const sized = sizeHandle(into, info.name, () => now, embed);
          retell = sized.said;
          nodes.push(sized.handle);
        }
        into.replaceChildren(...nodes);
      });
    };
    start();
    return {
      // A change of width leaves what is drawn as it is, so a video playing goes on playing at its new size, and the handle keeps the keyboard.
      update(next) {
        const was = uploadIn(now.config);
        now = next;
        if (uploadIn(next.config) === was) return retell();
        stop?.();
        into.replaceChildren();
        start();
      },
      stop: () => stop?.(),
    };
  }

  const shown = (embed: Exclude<UploadEmbed, "file">): Embed => ({
    name: embed,
    title: TITLE[embed],
    // A note comes to refer to an upload by a file being pasted, dropped or picked, or by its embed being copied from the Uploads page.
    menu: false,
    below: {
      box: ({ config }) => (uploadIn(config) ? boxFor(embed, config) : null),
      render: (into, handed) => below(embed, into, handed),
    },
  });

  /**
   * A file on a line of its own: a card below the line, with a head of its name, what it is and
   * Download, over a preview of it, which shows it larger over the app when pressed. The card is as
   * tall as its preview, known from what the note was told of the file before any of it is read.
   */
  function card(into: HTMLElement, first: BelowEmbedded): BelowDrawn {
    let now = first;
    let stop: Dispose | undefined;
    let unpreview: Dispose | undefined;
    const start = () => {
      const id = uploadIn(now.config);
      if (!id) return;
      stop = live(id, (info) => {
        unpreview?.();
        unpreview = undefined;
        const head = el("div", "upload-card-head");
        const body = el("div", "upload-card-body upload-preview-body upload-preview-note");
        const shown = info && info.state !== "trashed" ? info : null;
        if (info === undefined) head.append(el("span", "upload-card-said", TITLE.file));
        else if (!shown) head.append(el("span", "upload-card-said", info === null ? UNAVAILABLE : IN_TRASH), ...(info ? [el("span", "upload-card-meta", info.name)] : []));
        else {
          const meta = el("span", "upload-card-meta", formatBytes(shown.size));
          const name = opener(el("a", "upload-card-name"), id, shown);
          name.append(paperclip(), el("span", "", shown.name));
          const save = el("a", "upload-card-download");
          save.href = host.uploads.address(id);
          save.download = shown.name;
          save.title = `Download ${shown.name}`;
          save.setAttribute("aria-label", save.title);
          head.append(name, meta, save);
          const preview = previewOf(shown);
          body.style.height = `${cardHeight(preview) - cardHeight(null)}px`;
          const upload = { id, name: shown.name, type: shown.type, size: shown.size };
          // A file with nothing to preview is its head alone in a note: its icon is for the Uploads page.
          if (preview.shows !== "icon") unpreview = drawPreview(body, host, upload, "note", {
            said: (words) => (meta.textContent = words ? `${formatBytes(shown.size)} · ${words}` : formatBytes(shown.size)),
          });
          // A player is pressed to play: the card's name opens it larger.
          if (preview.shows !== "player" && preview.shows !== "icon" && previews()) {
            body.classList.add("upload-card-opens");
            body.tabIndex = 0;
            body.setAttribute("role", "button");
            body.setAttribute("aria-label", `Preview ${shown.name}`);
            const open = () => previewUpload(host, upload);
            body.addEventListener("click", open);
            body.addEventListener("keydown", (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              open();
            });
          }
        }
        into.replaceChildren(head, body);
        const height = cardHeight(shown ? previewOf(shown) : null);
        if (info !== undefined && height !== boxOfFile(now.config)?.height) now.resize(height);
      });
    };
    start();
    return {
      update(next) {
        const was = uploadIn(now.config);
        now = next;
        if (uploadIn(next.config) === was) return;
        unpreview?.();
        stop?.();
        into.replaceChildren();
        start();
      },
      stop: () => {
        unpreview?.();
        stop?.();
      },
    };
  }

  /** The room a file's card keeps below its line, from what the note was told of the file. */
  const boxOfFile = (config: string): { height: number } | null => {
    const id = uploadIn(config);
    if (!id) return null;
    const info = host.uploads.referred(id);
    return { height: cardHeight(info && info.state !== "trashed" ? previewOf(info) : null) };
  };

  const file: Embed = {
    name: "file",
    title: TITLE.file,
    // Offered in a menu only where a file can be sent, as the way to send one.
    menu: !!pick,
    pick,
    below: { alone: true, box: ({ config }) => boxOfFile(config), render: (into, handed) => card(into, handed) },
    render(into, embedded) {
      const id = uploadIn(embedded.config);
      if (!id) return void into.append(el("span", "embed-unread", "File: paste or drop a file here, or copy its embed from the Uploads page"));
      return live(id, (info) => {
        if (info === undefined) into.replaceChildren(el("span", "file-chip gone", TITLE.file));
        else if (info === null) into.replaceChildren(el("span", "file-chip gone", UNAVAILABLE));
        else if (info.state === "trashed") into.replaceChildren(el("span", "file-chip gone", `${info.name} · in Trash`));
        else into.replaceChildren(chip(id, info));
      });
    },
  };

  return { embeds: [shown("image"), shown("video"), shown("audio"), file], stop };
}
