import { cropIn, sizeIn, themeNow, uploadIn, withCrop, withUpload, type BelowDrawn, type BelowEmbedded, type Dispose, type Embed, type PluginHost, type ReferredTo, type Upload, type UploadEmbed } from "../../plugin-api.ts";
import { cropPicture } from "./cropper.ts";
import { placed } from "./cropping.ts";
import { reasonOf } from "../lib/FoundNote.tsx";
import { sketch } from "../lib/sketch.ts";
import { excalidraw, imageOf, sceneOf } from "./drawings.ts";
import { sizeHandle } from "./handle.ts";
import { filePath, openingOf, openUpload, previewUpload } from "./opening.ts";
import { previewOf } from "./previewing.ts";
import { drawPreview } from "./previews.ts";
import { SCENE_BYTES, SCENE_NAME, withPreview, type Scene } from "./scenes.ts";
import { boxFor, cardHeight, EMPTY_DRAWING, formatBytes, KIND_LABEL } from "./sizing.ts";

export const UNAVAILABLE = "This file isn't available";
export const IN_TRASH = "This file is in Trash";
export const UNREADABLE = "This drawing can't be read";

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

/** A file still on its way, as the uploads plugin's sender says of it. */
export interface Going {
  name: string;
  size: number;
  sent: number;
}

/** What says how far the files on their way have got: the one that will be an upload, by its id, and a call each time any of them gets further. */
export interface OnTheWay {
  of(uploadId: string): Going | undefined;
  subscribe(listener: () => void): Dispose;
}

const percent = ({ sent, size }: Going) => Math.min(100, Math.floor((100 * sent) / size));

/** In the room an upload's line keeps while its file is on its way: its name, how far it has got, and a bar. */
function onItsWay(going: Going) {
  const box = el("div", "upload-sending");
  box.setAttribute("role", "status");
  box.append(el("span", "upload-sending-words", `Uploading ${going.name} · ${percent(going)}%`));
  const bar = el("progress", "upload-sending-bar");
  bar.max = going.size;
  bar.value = going.sent;
  bar.setAttribute("aria-label", `${going.name} uploaded`);
  box.append(bar);
  return box;
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

/** The icon of a button on a picture: a path drawn in its colour on a square 16 pixels across. */
function buttonIcon(path: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path")).setAttribute("d", path);
  return svg;
}

const CROP_ICON = "M4.5 1.5v10h10M1.5 4.5h10v10";
const PENCIL_ICON = "M10.5 2.5l3 3-8 8H2.5v-3zM9 4l3 3";

/** Draws a picture so that what its embed crops of it fills its room, or all of it where it crops nothing. */
function framed(img: HTMLImageElement, config: string) {
  const crop = cropIn(config);
  const size = sizeIn(config);
  img.classList.toggle("cropped", !!crop);
  Object.assign(img.style, crop && size ? placed(crop, size) : { left: "", top: "", width: "", height: "" });
}

/** A drawing, as the insert menu pictures it: a box and a circle drawn by hand, and an arrow from one to the other. */
const DRAWING_PICTURE = sketch(
  `<g fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M34 22 C60 19 78 21 90 23 C92 38 91 52 89 62 C66 64 48 63 33 61 C31 47 32 34 34 22 Z"/><path d="M150 18 C168 18 178 30 177 42 C176 56 163 66 149 65 C134 64 123 53 124 41 C125 28 136 18 150 18 Z"/><path d="M93 42 C104 40 112 41 120 42 M112 35 L121 42 L112 49"/></g>`,
);

const TITLE: Record<UploadEmbed, string> = { ...KIND_LABEL, drawing: "Drawing" };

/** What a picture, a video or a recording says of itself on hover: its name, then its kind, its size if it has one, and how much it holds. */
const detailsOf = ({ name, kind, width, height, size }: NonNullable<ReferredTo>) => `${name}\n${[KIND_LABEL[kind], width && height ? `${width} × ${height}` : null, formatBytes(size)].filter(Boolean).join(" · ")}`;

/**
 * The embeds that show an upload where a note refers to one: `::image{id 640x480 medium}`, `::video{id 640x360 42%}`,
 * `::audio{id}` and `::file{id}`. A picture, a video and a recording are all below their line, and
 * nothing of them is in it. What each knows of its upload is what the host was told by the read
 * of the note, and its bytes come from the address the host gives, so on a link's page they come by the link.
 * `pick` is how a menu sends a file into a note, where one can be sent.
 */
export function uploadEmbeds(host: PluginHost, pick?: Embed["pick"], onTheWay?: OnTheWay): { embeds: Embed[]; stop: Dispose } {
  const drawn = new Set<() => void>();
  const asked = new Set<string>();
  const everyAgain = () => {
    for (const again of [...drawn]) again();
  };
  const stopReferred = host.uploads.onReferred(everyAgain);
  const stopGoing = onTheWay?.subscribe(everyAgain);
  const stop = () => {
    stopReferred();
    stopGoing?.();
  };

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

  /**
   * Draws with what is known of an upload now, and again each time that is different, and never
   * otherwise. While its file is on its way from this browser, that is how far it has got: the server
   * is asked nothing of it, since it is no upload to anyone until it is all there.
   */
  const live = (id: string, draw: (info: ReferredTo | undefined, going: Going | undefined) => void): Dispose => {
    const now = () => {
      const going = onTheWay?.of(id);
      const info = going ? host.uploads.referred(id) : known(id);
      return { info, going, said: `${said(info)}\n${going ? percent(going) : ""}` };
    };
    let was = now();
    draw(was.info, was.going);
    const again = () => {
      const is = now();
      if (is.said === was.said) return;
      was = is;
      draw(is.info, is.going);
    };
    drawn.add(again);
    return () => void drawn.delete(again);
  };

  function media(embed: Exclude<UploadEmbed, "file">, id: string, info: ReferredTo | undefined): Node[] {
    if (info === undefined) return [];
    if (info === null) return [missing(UNAVAILABLE)];
    if (info.state === "trashed") return [missing(IN_TRASH, info.name)];
    // A drawing's upload is a scene, whatever its name says it is, and its picture is drawn once the scene is read.
    if (embed === "drawing") {
      const picture = el("div", "upload-picture");
      const img = picture.appendChild(el("img", "upload-image upload-drawing"));
      img.title = detailsOf(info);
      img.draggable = false;
      return [picture];
    }
    // Written as one kind and uploaded as another: it is offered as the file it is.
    if (info.kind !== embed) {
      const box = el("div", "upload-missing");
      box.append(chip(id, info));
      return [box];
    }
    const address = host.uploads.address(id);
    if (embed === "image") {
      const picture = el("div", "upload-picture");
      const img = picture.appendChild(el("img", "upload-image"));
      img.alt = info.name;
      img.title = detailsOf(info);
      img.draggable = false;
      img.decoding = "async";
      // Hidden from the member since the note was read, or gone: the same words either way.
      img.addEventListener("error", () => picture.parentElement?.replaceChildren(missing(UNAVAILABLE)));
      img.src = address;
      return [picture];
    }
    const player = el(embed, `upload-${embed}`);
    player.controls = true;
    player.preload = embed === "video" ? "metadata" : "none";
    player.title = detailsOf(info);
    // A video shows its first frame before it is played: a browser that shows nothing until then is asked for the frame at its start.
    player.src = embed === "video" ? `${address}#t=0.001` : address;
    return [player];
  }

  /**
   * What crops a picture: a button seen with its size handle, which opens the picture to crop it, and
   * writes the crop into its embed. `closing` is given what closes the crop open from it.
   */
  const cropButton = (id: string, name: string, now: () => BelowEmbedded, closing: (close: Dispose) => void) => {
    const button = el("button", "upload-crop");
    button.type = "button";
    button.title = "Crop";
    button.setAttribute("aria-label", `Crop ${name}`);
    button.append(buttonIcon(CROP_ICON));
    button.addEventListener("click", () => {
      const size = sizeIn(now().config);
      if (!size) return;
      closing(cropPicture({
        name,
        address: host.uploads.address(id),
        size,
        crop: cropIn(now().config),
        back: button,
        done: (crop) => {
          const { config, update } = now();
          const next = withCrop(config, crop);
          if (next !== config) update({ config: next });
        },
      }));
    });
    return button;
  };

  /**
   * Keeps a drawing as a new upload, in the note's folder and private where the note is, and puts it
   * in the embed in place of the one it was, so undo in the note brings back the drawing before.
   * Null once the embed names it, or words that say why it doesn't.
   */
  const keep = async (now: () => BelowEmbedded, json: string, picture: { image: string; width: number; height: number }): Promise<string | null> => {
    if (now().readOnly) return "You can read this note, and not change it.";
    const note = host.app().notes?.find((n) => n.id === now().noteId);
    let upload: Upload;
    try {
      const file = new Blob([withPreview(json, picture.image)], { type: "application/json" });
      upload = await host.uploads.send(file, { name: SCENE_NAME, folderId: note?.folderId ?? undefined, private: note?.private || undefined });
    } catch (err) {
      return `The drawing wasn't saved. ${reasonOf(err)}`;
    }
    host.uploads.learn([{ id: upload.id, upload: toldOf(upload) }]);
    const { config, update } = now();
    update({ config: withUpload(config, upload.id, picture) });
    return uploadIn(now().config) === upload.id ? null : "The note changed while the drawing was saved. Save again to put it in the note.";
  };

  /**
   * Has `button` open a drawing in Excalidraw, with what `scene` reads, null for one not drawn yet,
   * and keep what is saved there. `closing` is given what closes the editor open from it.
   */
  const editing = (button: HTMLButtonElement, scene: () => Promise<Scene | null>, now: () => BelowEmbedded, closing: (close: Dispose) => void) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      Promise.all([scene(), excalidraw()]).then(
        ([was, { editScene }]) => {
          button.disabled = false;
          // A drawing drawn again or gone while Excalidraw loaded is no longer the one asked for.
          if (!button.isConnected) return;
          closing(editScene({ name: TITLE.drawing, scene: was, theme: themeNow(), back: button, save: (json, picture) => keep(now, json, picture) }));
        },
        (err: unknown) => {
          button.disabled = false;
          host.app().notify({ message: `The drawing couldn't be opened. ${reasonOf(err)}` });
        },
      );
    });
    return button;
  };

  const editButton = () => {
    const button = el("button", "upload-edit");
    button.type = "button";
    button.title = "Edit drawing";
    button.setAttribute("aria-label", "Edit drawing");
    button.append(buttonIcon(PENCIL_ICON));
    return button;
  };

  /** In the room of a drawing not drawn yet: words that say so, and a button to draw it for a member who can change the note. */
  const emptyDrawing = (now: () => BelowEmbedded, closing: (close: Dispose) => void) => {
    const box = el("div", "upload-drawing-empty");
    if (now().readOnly) box.append(el("span", "upload-missing-words", "An empty drawing"));
    else box.append(editing(el("button", "button", "Edit drawing"), () => Promise.resolve(null), now, closing));
    return box;
  };

  /** Draws a drawing's picture in `picture` once its scene is read, or says in its room, in place of it and its controls, that it can't be read. */
  const drawScene = (scene: Promise<Scene>, picture: HTMLElement): Dispose => {
    const img = picture.querySelector("img")!;
    let stopped = false;
    scene.then(imageOf).then(
      (image) => {
        if (stopped) return;
        img.alt = TITLE.drawing;
        img.src = image;
      },
      () => void (stopped || picture.parentElement?.replaceChildren(missing(UNREADABLE))),
    );
    return () => void (stopped = true);
  };

  /**
   * A picture, a video, a recording or a drawing, drawn below its line, with a handle to size a
   * picture, a video or a drawing for a member who can change the note, a button to crop a picture,
   * and a button to edit a drawing. A video is not cropped.
   */
  function below(embed: Exclude<UploadEmbed, "file">, into: HTMLElement, first: BelowEmbedded): BelowDrawn {
    let now = first;
    let retell = () => {};
    let stop: Dispose | undefined;
    let closeDialog: Dispose = () => {};
    let unpicture: Dispose = () => {};
    const frame = () => {
      const img = into.querySelector<HTMLImageElement>(".upload-image");
      if (img) framed(img, now.config);
    };
    const start = () => {
      const id = uploadIn(now.config);
      if (!id) {
        if (embed === "drawing") into.replaceChildren(emptyDrawing(() => now, (close) => (closeDialog = close)));
        return;
      }
      stop = live(id, (info, going) => {
        unpicture();
        unpicture = () => {};
        if (going) return void into.replaceChildren(onItsWay(going));
        const nodes = media(embed, id, info);
        const scene = embed === "drawing" && info && info.state !== "trashed" ? (info.size <= SCENE_BYTES ? sceneOf(host, id) : Promise.reject(new Error(UNREADABLE))) : null;
        if (scene) unpicture = drawScene(scene, nodes[0] as HTMLElement);
        if (embed !== "audio" && !now.readOnly && info && info.state !== "trashed" && (info.kind === embed || scene)) {
          const sized = sizeHandle(into, info.name, () => now, embed);
          retell = sized.said;
          nodes.push(sized.handle);
          if (embed === "image" && sizeIn(now.config)) nodes.push(cropButton(id, info.name, () => now, (close) => (closeDialog = close)));
          if (scene) nodes.push(editing(editButton(), () => scene, () => now, (close) => (closeDialog = close)));
        }
        into.replaceChildren(...nodes);
        frame();
      });
    };
    start();
    return {
      // A change of width or crop leaves what is drawn as it is, so a video playing goes on playing at its new size, and the handle keeps the keyboard.
      update(next) {
        const was = uploadIn(now.config);
        now = next;
        if (uploadIn(next.config) === was) {
          frame();
          return retell();
        }
        closeDialog();
        unpicture();
        stop?.();
        into.replaceChildren();
        start();
      },
      stop: () => {
        closeDialog();
        unpicture();
        stop?.();
      },
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

  /** A drawing is written empty by a menu, where a file can be sent, among the ways into an upload, and drawn from there. */
  const drawing: Embed = {
    ...shown("drawing"),
    menu: !!pick,
    pick: pick && { title: TITLE.drawing, description: "Shapes, arrows and words drawn by hand in Excalidraw", preview: { image: DRAWING_PICTURE }, insert: () => Promise.resolve("::drawing{}") },
    below: {
      box: ({ config }) => (uploadIn(config) ? boxFor("drawing", config) : { height: EMPTY_DRAWING }),
      render: (into, handed) => below("drawing", into, handed),
    },
  };

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
      stop = live(id, (info, going) => {
        unpreview?.();
        unpreview = undefined;
        if (going) return void into.replaceChildren(onItsWay(going));
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
      return live(id, (info, going) => {
        if (going) into.replaceChildren(el("span", "file-chip gone", `${going.name} · ${percent(going)}%`));
        else if (info === undefined) into.replaceChildren(el("span", "file-chip gone", TITLE.file));
        else if (info === null) into.replaceChildren(el("span", "file-chip gone", UNAVAILABLE));
        else if (info.state === "trashed") into.replaceChildren(el("span", "file-chip gone", `${info.name} · in Trash`));
        else into.replaceChildren(chip(id, info));
      });
    },
  };

  return { embeds: [shown("image"), shown("video"), shown("audio"), drawing, file], stop };
}
