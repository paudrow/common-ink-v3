import { uploadIn, type BelowDrawn, type BelowEmbedded, type Dispose, type Embed, type PluginHost, type ReferredTo, type Upload, type UploadEmbed } from "../../plugin-api.ts";
import { sizeHandle } from "./handle.ts";
import { filePath, openingOf, openUpload } from "./opening.ts";
import { boxFor, formatBytes, KIND_LABEL } from "./sizing.ts";

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

  /**
   * A file as a chip: its name and its size. A press opens it as its kind of file opens: a PDF in a
   * tab where there is a site kept for files and otherwise saved, text in the app and a picture, video or recording in a preview where there is an app to show
   * them in, and anything else is saved under its name.
   */
  const chip = (id: string, info: NonNullable<ReferredTo>) => {
    const link = el("a", "file-chip");
    const address = host.uploads.address(id);
    const tab = host.uploads.tabAddress(id);
    const how = openingOf(info, tab !== null);
    if (how === "tab") {
      link.href = tab!;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = `Open ${info.name} in a new tab`;
    } else if ((how === "app" && typeof host.app().go === "function") || (how === "preview" && typeof host.app().toggleOverlay === "function")) {
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

  const file: Embed = {
    name: "file",
    title: TITLE.file,
    // Offered in a menu only where a file can be sent, as the way to send one.
    menu: !!pick,
    pick,
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
