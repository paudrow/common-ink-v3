import { ago, type CompletionItem, type PluginHost } from "../../plugin-api.ts";
import { AT_ALONE, pointed } from "../lib/pointing.ts";
import { reask } from "../lib/reasking.ts";
import { placedIn, type Listed } from "./inserting.tsx";
import { formatBytes, KIND_LABEL } from "./sizing.ts";

/** How many uploads `@` offers at most, among the other kinds of thing it lists. */
const MOST_OFFERED = 8;
/** How many of the latest uploads `@` finds among: as many as one listing gives. */
const READ = 500;
/** How long uploads just read are taken to be what there is: the list asked again for something else that arrived asks for them too. */
const FRESH_MS = 5_000;

/**
 * What `@` offers of the uploads the member can see: those whose name has a word starting with each
 * word typed, among the latest, and the latest few for nothing typed. They are read again each time
 * `@` is typed alone, unless they were read a moment ago, and kept in this browser's memory for what
 * is typed after it, so nothing typed is sent anywhere. The list doesn't wait for a reading: it is offered at once, and an open one is
 * asked again when the uploads arrive. Picking one places
 * it in the note and writes it as "Insert an upload" does: a picture, a video or a recording on a line
 * of its own, a file as a chip among the words.
 */
export function uploadsAt(host: PluginHost): (typed: string) => CompletionItem[] {
  let uploads: readonly Listed[] | null = null;
  let reading: Promise<unknown> | null = null;
  let readAt = 0;
  const read = () =>
    (reading ??= host
      .perform({ type: "upload.list", limit: READ })
      .then(
        (answer) => {
          uploads = answer.uploads;
          readAt = Date.now();
          reask();
        },
        // A reading that failed leaves what was read, or none, until `@` is typed alone again.
        () => (uploads ??= []),
      )
      .finally(() => (reading = null)));

  const itemFor = (upload: Listed): CompletionItem => ({
    kind: "upload",
    label: upload.name,
    description: `${KIND_LABEL[upload.kind]} · ${formatBytes(upload.size)}`,
    preview: { ...(upload.kind === "image" && { image: host.uploads.address(upload.id) }), facts: [["Uploaded", `${ago(upload.createdAt, Date.now())} by ${upload.uploadedBy.name}`]] },
    block: upload.kind !== "file",
    insert: ({ noteId }) => placedIn(host, noteId, upload),
  });

  return (typed) => {
    if (uploads === null || (!typed && Date.now() - readAt > FRESH_MS)) void read();
    const found = typed ? pointed(uploads ?? [], typed, (u) => u.name).slice(0, MOST_OFFERED) : (uploads ?? []).toSorted((a, b) => b.createdAt - a.createdAt).slice(0, AT_ALONE.upload);
    return found.map(itemFor);
  };
}
