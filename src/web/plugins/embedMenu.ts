import type { CompletionItem, EmbedInfo, Plugin } from "../plugin-api.ts";
import { starting } from "./lib/match.ts";

/** How a new embed is written, with its config left selected when there is one to type over. */
function itemFor({ name, title, block, starts }: EmbedInfo): CompletionItem {
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
      picksAfter: 2,
      items: (typed) => starting(host.embeds.list(), typed, (e) => `${e.title} ${e.name}`).map(itemFor),
    });
  },
};
