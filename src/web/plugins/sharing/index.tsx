import type { Plugin } from "../../plugin-api.ts";
import { AllGrants } from "./AllGrants.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { SHARE_COMMAND, SHARE_OVERLAY } from "./Summary.tsx";
import { itemOf } from "./words.ts";

/**
 * Sharing a note or a folder with people and by link, and making a note private. The dialog is an
 * overlay handed the note or folder to share, so any plugin can open it: `app.toggleOverlay("share", { noteId })`.
 */
export const sharing: Plugin = {
  id: "sharing",
  name: "Sharing",
  description: "Share a note or a folder with people or by a link, and make a note private.",
  icon: "share",
  activate(host) {
    host.commands.register({
      id: SHARE_COMMAND,
      title: "Share this note…",
      run() {
        const app = host.app();
        if (app.noteId) app.toggleOverlay(SHARE_OVERLAY, { noteId: app.noteId });
      },
    });
    host.views.register("overlay", {
      id: SHARE_OVERLAY,
      component({ app, close, state }) {
        const on = itemOf(state);
        return on && <ShareDialog key={JSON.stringify(on)} host={host} app={app} on={on} close={close} />;
      },
    });
    if (host.workspace.role === "admin") {
      host.views.register("page", { id: "sharing", path: "/sharing", label: "Sharing", nav: "menu", component: ({ app }) => <AllGrants host={host} app={app} /> });
    }
  },
};
