import { describe, expect, it, vi } from "vitest";
import type { App, OpInput, PluginHost } from "../../src/web/plugin-api.ts";
import { createPluginHost } from "../../src/web/pluginHost.ts";
import { email } from "../../src/web/plugins/email/index.tsx";
import { BUILT_INS } from "../../src/web/plugins/index.ts";
import { labelledReferences } from "../../src/web/plugins/lib/references.tsx";

// The frame focus guard and the editor read the page from the moment they are loaded, and there is no page here.
vi.hoisted(() => vi.stubGlobal("document", { addEventListener() {}, documentElement: { style: {} } }));

/** The host the app makes, with the Email plugin in it, and every operation it asks for. */
function started(plugins = [email]) {
  const asked: OpInput[] = [];
  const host = createPluginHost({
    plugins,
    mac: true,
    settings: {},
    write: () => false,
    provide: () => ({ workspace: { id: "w1", name: "Acme", role: "editor" }, app: () => ({}) as App, perform: (async (op: OpInput) => void asked.push(op)) as PluginHost["perform"] }) as never,
  });
  return { host, asked };
}

describe("the Email plugin", () => {
  it("comes with the app, after Contacts", () => {
    const ids = BUILT_INS.map((p) => p.id);
    expect(ids).toContain("email");
    expect(ids.indexOf("email")).toBe(ids.indexOf("contacts") + 1);
  });

  it("adds the Email page, its section of Settings, and the reference a note writes, and nothing else", () => {
    const { host } = started();
    const added = host.contributions();
    expect(added.views.page.map((p) => [p.id, p.path, p.label])).toEqual([["email", "/email", "Email"]]);
    expect(added.views.settings.map((s) => [s.id, s.label])).toEqual([["email", "Email"]]);
    const embed = added.embeds.find((e) => e.name === "email");
    expect(embed).toMatchObject({ title: "Email", menu: false });
    expect(added.commands.map((c) => c.id)).toEqual(["go.email", "plugins.toggle.email"]);
    expect(added.plugins.find((p) => p.id === "email")).toMatchObject({ name: "Email", enabled: true });
    host.dispose();
  });

  it("takes everything out when the member turns it off", () => {
    const { host } = started();
    host.settingsChanged({ "email.enabled": false });
    const added = host.contributions();
    expect(added.plugins.find((p) => p.id === "email")).toMatchObject({ enabled: false });
    expect(added.views.page).toEqual([]);
    expect(added.views.settings).toEqual([]);
    expect(added.embeds.filter((e) => e.name === "email")).toEqual([]);
    host.dispose();
  });

  it("draws a reference on a link's page as its label, asking nothing", () => {
    const { host, asked } = started([labelledReferences]);
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["email"]);
    expect(asked).toEqual([]);
    host.dispose();
  });
});
