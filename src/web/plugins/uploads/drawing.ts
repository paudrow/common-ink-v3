import { uploadIn, type Dispose, type Embed, type Embedded, type PluginHost, type ReferredTo, type Upload, type UploadEmbed } from "../../plugin-api.ts";
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

/** What stands in the line for an upload that is shown below it, which takes the cursor to it as written. */
function named(into: HTMLElement, embed: Embedded, text: string) {
  const name = into.appendChild(el("span", "media-name", text));
  name.title = "Click to edit";
  name.addEventListener("mousedown", (event) => {
    event.preventDefault();
    embed.edit();
  });
  return name;
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

/** A file to download: its name and its size, which a click saves under that name. */
function download(address: string, info: NonNullable<ReferredTo>, className: string) {
  const link = el("a", className);
  link.href = address;
  link.download = info.name;
  link.title = `Download ${info.name}`;
  link.append(paperclip(), el("span", "file-chip-name", info.name), el("span", "file-chip-size", formatBytes(info.size)));
  return link;
}

const TITLE: Record<UploadEmbed, string> = KIND_LABEL;

/**
 * The embeds that show an upload where a note refers to one: `::image{id 640x480}`, `::video{id 640x360}`,
 * `::audio{id}` and `::file{id}`. What each knows of its upload is what the host was told by the read
 * of the note, and its bytes come from the address the host gives, so on a link's page they come by the link.
 * `pick` is how a menu sends a file into a note, where one can be sent.
 */
export function uploadEmbeds(host: PluginHost, pick?: Embed["pick"]): { embeds: Embed[]; stop: Dispose } {
  const drawn = new Set<() => void>();
  const asked = new Set<string>();
  const stop = host.uploads.onReferred(() => {
    for (const again of [...drawn]) again();
  });

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
    const address = host.uploads.address(id);
    // Written as one kind and uploaded as another: it is offered as the file it is.
    if (info.kind !== embed) {
      const box = el("div", "upload-missing");
      box.append(download(address, info, "file-chip"));
      return [box];
    }
    if (embed === "image") {
      const img = el("img", "upload-image");
      img.alt = info.name;
      img.draggable = false;
      img.decoding = "async";
      // Hidden from the member since the note was read, or gone: the same words either way.
      img.addEventListener("error", () => img.replaceWith(missing(UNAVAILABLE)));
      img.src = address;
      return [img];
    }
    const player = el(embed, `upload-${embed}`);
    player.controls = true;
    player.preload = embed === "video" ? "metadata" : "none";
    player.title = info.name;
    player.src = address;
    return [player];
  }

  const shown = (embed: Exclude<UploadEmbed, "file">): Embed => ({
    name: embed,
    title: TITLE[embed],
    // A note comes to refer to an upload by a file being pasted, dropped or picked, or by its embed being copied from the Uploads page.
    menu: false,
    render(into, embedded) {
      const id = uploadIn(embedded.config);
      if (!id) return void into.append(el("span", "embed-unread", `${TITLE[embed]}: paste or drop a file here, or copy its embed from the Uploads page`));
      const name = named(into, embedded, TITLE[embed]);
      return live(id, (info) => void (name.textContent = info?.name ?? TITLE[embed]));
    },
    below: {
      box: ({ config }) => (uploadIn(config) ? boxFor(embed, config) : null),
      render(into, { config }) {
        const id = uploadIn(config);
        if (id) return live(id, (info) => into.replaceChildren(...media(embed, id, info)));
      },
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
        else into.replaceChildren(download(host.uploads.address(id), info, "file-chip"));
      });
    },
  };

  return { embeds: [shown("image"), shown("video"), shown("audio"), file], stop };
}
