import { useSyncExternalStore } from "react";
import type { Plugin } from "../../plugin-api.ts";
import { uploadEmbeds } from "./drawing.ts";
import { FilePage } from "./FilePage.tsx";
import { UPLOADS_PATH } from "./finding.ts";
import { inserter } from "./inserting.tsx";
import { FILE_PATH, PREVIEW } from "./opening.ts";
import { uploadsAt } from "./pointing.ts";
import { outline, panel, sketch, words } from "../lib/sketch.ts";
import { Preview } from "./Preview.tsx";
import { sender, type Sender } from "./sending.ts";
import { UploadsPage } from "./UploadsPage.tsx";

/** The files on their way, in the bottom bar, which keeps its height: nothing in a note moves while one is sent. */
function SendingStatus({ sender }: { sender: Sender }) {
  const sending = useSyncExternalStore(sender.subscribe, sender.sending);
  const first = sending[0];
  if (!first) return null;
  return (
    <span className="bar-item" role="status" aria-label="Uploading">
      Uploading {first.name} {Math.round((100 * first.sent) / first.size)}%{sending.length > 1 ? `, and ${sending.length - 1} more` : ""}
    </span>
  );
}

/**
 * The embeds of uploads alone, for a page that only reads a note, as a link's page does: a picture,
 * a video, a recording, and a file to download. There is no way to send a file from it.
 */
export const uploadDrawing: Plugin = {
  id: "upload-drawing",
  name: "Upload embeds",
  activate(host) {
    const { embeds, stop } = uploadEmbeds(host);
    for (const embed of embeds) host.embeds.register(embed);
    return stop;
  },
};

/** A picture in a frame: hills and a sun. */
const framed = (x: number, y: number, width: number, height: number) =>
  panel(x, y, width, height) + `<path d="M${x + 8} ${y + height - 8} l${width * 0.3} ${-height * 0.45} l${width * 0.2} ${height * 0.25} l${width * 0.12} ${-height * 0.12} l${width * 0.26} ${height * 0.32} Z" opacity="0.55"/><circle cx="${x + width * 0.75}" cy="${y + height * 0.28}" r="${height * 0.1}" opacity="0.55"/>`;

/**
 * What the insert menu offers to send a file of each kind into a note, with the file picker's
 * `accept` for it: a picture, a video, a recording, or any file, each written as its own kind is
 * whichever entry sent it. A recording and not "audio", so `N /A` stays words and opens no menu.
 */
const SENDS: readonly { title: string; accept?: string; description: string; picture: string }[] = [
  { title: "Upload an image", accept: "image/*", description: "A picture from your computer, shown in the note", picture: sketch(framed(50, 8, 100, 68)) },
  { title: "Upload a video", accept: "video/*", description: "A video from your computer, played in the note", picture: sketch(panel(40, 8, 120, 68) + `<path d="M92 30 v24 l20 -12 Z"/>` + words(48, 66, 104, 3)) },
  { title: "Upload a recording", accept: "audio/*", description: "Sound from your computer, played in the note", picture: sketch(panel(16, 26, 168, 32, 16) + `<path d="M32 34 v16 l13 -8 Z"/>` + words(56, 39, 96) + `<circle cx="164" cy="42" r="5"/>`) },
  { title: "Upload a file", description: "Any file from your computer, shown as what it is", picture: sketch(outline(30, 10, 140, 64, 6) + panel(30, 10, 140, 22, 6) + words(40, 18, 70) + words(124, 18, 36) + words(40, 44, 120) + words(40, 56, 90)) },
];

/** Pictures in a row, as the insert menu pictures uploads to choose from. */
const INSERT_PICTURE = sketch([20, 76, 132].map((x) => framed(x, 18, 48, 48)).join(""));

/**
 * Uploads: files in a workspace that a note shows by `::image{id 640x480}`, `::video{id 640x360}`,
 * `::audio{id}` or `::file{id}`. A file pasted, dropped or picked into a note is sent and written
 * there, `@` finds one already uploaded among everything else it lists, and the Uploads page lists
 * every one the member can see. A file opens as its kind does
 * (`openUpload`): a picture, a video or a recording in a preview, a PDF in a tab, and text on its own
 * page at `/file/<id>`, read and not changed.
 */
export const uploads: Plugin = {
  id: "uploads",
  name: "Uploads",
  description: "Keeps files in the workspace. A picture, a video or a recording pasted or dropped into a note shows there, any other file is a chip that downloads, and the Uploads page lists them all.",
  icon: "uploads",
  activate(host) {
    const sending = sender(host);
    const inserting = inserter(host);
    const { embeds, stop } = uploadEmbeds(
      host,
      [
        ...SENDS.map(({ title, accept, description, picture }) => ({ title, description, preview: { image: picture }, insert: sending.pickInto(accept) })),
        { title: "Insert an upload", description: "A file already uploaded to the workspace", preview: { image: INSERT_PICTURE }, insert: inserting.ask },
      ],
      { of: sending.of, subscribe: sending.subscribe },
    );
    for (const embed of embeds) host.embeds.register(embed);
    host.editorExtensions.register({ id: "uploads", extension: sending.extension });
    host.editorExtensions.register({ id: "upload-inserting", extension: inserting.extension });
    host.completions.register({ id: "uploads.at", trigger: "@", spaces: true, items: uploadsAt(host) });
    host.views.register("bar", { id: "uploads", live: true, component: () => <SendingStatus sender={sending} /> });
    host.views.register("page", { id: "uploads", path: UPLOADS_PATH, label: "Uploads", icon: "uploads", nav: "more", component: (props) => <UploadsPage host={host} sender={sending} {...props} /> });
    host.views.register("page", { id: "file", path: FILE_PATH, label: "File", icon: "text", component: (props) => <FilePage key={props.app.path} host={host} {...props} /> });
    host.views.register("overlay", { id: PREVIEW, component: (props) => <Preview host={host} {...props} /> });
    return stop;
  },
};
