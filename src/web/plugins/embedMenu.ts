import type { CompletionItem, EmbedInfo, Plugin } from "../plugin-api.ts";
import { matching } from "./lib/match.ts";

/** How a new embed is written, with its config left selected when there is one to type over. */
function itemFor({ name, title, block, starts, pick }: EmbedInfo): CompletionItem {
  if (pick) return { label: pick.title, detail: pick.detail, insert: "", run: pick.run };
  const config = starts?.config ?? "";
  const opening = `${block ? ":::" : "::"}${name}{`;
  const written = `${opening}${config}}`;
  if (!block) return { label: title, detail: written, insert: written, select: config ? [opening.length, opening.length + config.length] : undefined };
  const body = starts?.body ?? "";
  return { label: title, detail: written, insert: `${written}\n${body && !body.endsWith("\n") ? `${body}\n` : body}:::`, block: true };
}

/** The embed menu: `/` in a note lists every embed a plugin has added, and picking one writes it. */
export const embedMenu: Plugin = {
  id: "embed-menu",
  name: "Embed menu",
  description: "Type / in a note to pick something to embed from a list.",
  icon: "slash",
  activate(host) {
    host.completions.register({
      id: "embeds",
      trigger: "/",
      // The embeds the menu writes come first, then what it can only ask for, such as a file to upload.
      items: (typed) =>
        matching(
          host.embeds.list().toSorted((a, b) => Number(!!a.pick) - Number(!!b.pick)),
          typed,
          (e) => `${e.pick?.title ?? e.title} ${e.name}`,
        ).map(itemFor),
    });
  },
};
