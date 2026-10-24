import { describe, expect, it, vi } from "vitest";
import type { App, PluginHost } from "../../src/web/plugin-api.ts";
import { createPluginHost } from "../../src/web/pluginHost.ts";
import { createInstaller } from "../../src/web/pluginRuntime.ts";
import type { SettingsDocument } from "../../src/web/settings.ts";

// The frame focus guard and the editor read the page from the moment they are loaded, and there is no page here.
vi.hoisted(() => vi.stubGlobal("document", { addEventListener() {}, documentElement: { style: {} } }));

/** Which of the app's own sandboxed plugins are on for a member with these settings, as the app makes and runs them. */
function onFor(dev: boolean, settings: SettingsDocument = {}) {
  const installer = createInstaller({ workspaceId: "w1", dev, record: () => null, drafts: () => [], reread() {}, changed() {}, ended() {} });
  const host = createPluginHost({
    plugins: [],
    mac: true,
    settings,
    write: () => false,
    provide: () => ({ workspace: { id: "w1", name: "Acme", role: "editor" }, app: () => ({}) as App, perform: (async () => null) as PluginHost["perform"] }) as never,
  });
  host.setInstalled(installer.list());
  const on = host.contributions().plugins.map((p) => [p.name, p.enabled]);
  host.dispose();
  return on;
}

describe("the demo plugins that come with the app", () => {
  it("are off in production, and the rest of the app's own are on", () => {
    expect(onFor(false)).toEqual([
      ["Word count", true],
      ["Quick timer", true],
      ["Weather", false],
      ["Sample calendar", false],
      ["Coin", false],
      ["Dice", false],
    ]);
  });

  it("are on on a development server or a Preview, with the rest", () => {
    expect(onFor(true)).toEqual([
      ["Word count", true],
      ["Quick timer", true],
      ["Weather", true],
      ["Sample calendar", true],
      ["Coin", true],
      ["Dice", true],
    ]);
  });

  it("follow what a member turned on or off, wherever they are", () => {
    const chose = { "dice.enabled": true, "word-count.enabled": false };
    for (const dev of [false, true]) {
      expect(onFor(dev, chose), dev ? "on a Preview" : "in production").toEqual([
        ["Word count", false],
        ["Quick timer", true],
        ["Weather", dev],
        ["Sample calendar", dev],
        ["Coin", dev],
        ["Dice", true],
      ]);
    }
    expect(onFor(true, { "coin.enabled": false }).find(([name]) => name === "Coin")).toEqual(["Coin", false]);
  });
});
