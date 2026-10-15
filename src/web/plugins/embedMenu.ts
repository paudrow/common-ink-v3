import type { CompletionItem, EmbedInfo, EmbedPick, Plugin } from "../plugin-api.ts";
import { starting } from "./lib/match.ts";

/** One entry in the menu: an embed it writes, or one of the things an embed's `pick` does. */
interface Entry {
  embed: EmbedInfo;
  pick?: EmbedPick;
}

const entriesOf = (embed: EmbedInfo): Entry[] => (embed.pick === undefined ? [{ embed }] : ("run" in embed.pick ? [embed.pick] : embed.pick).map((pick) => ({ embed, pick })));

/** How a new embed is written, with its config left selected when there is one to type over. */
function itemFor({ embed: { name, title, block, starts }, pick }: Entry): CompletionItem {
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
      prose: true,
      // The embeds the menu writes come first, then what it can only ask for, such as a file to upload.
      items: (typed) =>
        starting(
          host.embeds
            .list()
            .flatMap(entriesOf)
            .toSorted((a, b) => Number(!!a.pick) - Number(!!b.pick)),
          typed,
          // An entry is found by its words, not by "a" or "an" in "Upload a file", so `N /A` is still just words.
          (e) => `${e.pick?.title ?? e.embed.title} ${e.embed.name}`.replace(/\b(?:a|an|the)\b/gi, " "),
        ).map(itemFor),
    });
  },
};
