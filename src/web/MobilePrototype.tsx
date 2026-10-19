// PROTOTYPE, throwaway: three phone layouts for the app shell, switched with ?mobile=A|B|C.
// Lives on prototype/mobile-layout only. The chosen one is rebuilt properly.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./icons.tsx";

export const VARIANTS = {
  A: "Stack: one screen at a time, back goes up",
  B: "Tab bar: modes along the bottom",
  C: "Drawers: sidebar and inspector slide over",
} as const;
export type Variant = keyof typeof VARIANTS;
const KEY = "proto.mobile";
let faked = false;

function read(): Variant | null {
  const asked = new URLSearchParams(location.search).get("mobile");
  if (asked && asked in VARIANTS) sessionStorage.setItem(KEY, asked);
  if (asked === "off") sessionStorage.removeItem(KEY);
  const kept = sessionStorage.getItem(KEY);
  return kept && kept in VARIANTS ? (kept as Variant) : null;
}
const listeners = new Set<() => void>();
export function setVariant(v: Variant) {
  sessionStorage.setItem(KEY, v);
  const url = new URL(location.href);
  url.searchParams.set("mobile", v);
  history.replaceState(history.state, "", url);
  listeners.forEach((l) => l());
}
/** Plugins the prototype turns off on a phone: splits and tabs make no sense one screen wide. */
export const offOnPhone = (id: string) => !!read() && matchMedia("(max-width: 700px)").matches && ["tabs", "vim", "lineNumbers"].includes(id);
export const useVariant = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    read,
  );

/** How tall the on-screen keyboard is: the layout viewport less the visual one. `window.protoKeyboard(h)` fakes it for screenshots. */
export function useKeyboardHeight() {
  const [h, setH] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setH(vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    (window as unknown as { protoKeyboard: (h: number) => void }).protoKeyboard = (h) => {
      faked = true;
      setH(h);
    };
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, []);
  return h > 120 ? h : 0;
}

interface ChromeProps {
  variant: Variant;
  title: string;
  /** Where back goes, or null at the top of the stack. */
  up: { label: string; go: () => void } | null;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  inspectorOpen: boolean;
  toggleInspector: () => void;
  noteTools: React.ReactNode;
  go: (path: string) => void;
  path: string;
  createNote: () => void;
  keyboard: number;
}

export function PhoneChrome(p: ChromeProps) {
  const { variant } = p;
  const left =
    variant === "A" ? (
      p.up && !p.sidebarOpen ? (
        <button type="button" className="m-back" data-proto="nav" onClick={p.up.go}>
          <Icon name="back" />
          <span>{p.up.label}</span>
        </button>
      ) : null
    ) : variant === "C" ? (
      <button type="button" className="icon-button" data-proto="nav" aria-label="Open sidebar" onClick={() => p.setSidebarOpen(!p.sidebarOpen)}>
        <Icon name="sidebar" />
      </button>
    ) : p.up && p.up.label !== "Folders" ? (
      <button type="button" className="m-back" onClick={p.up.go}>
        <Icon name="back" />
      </button>
    ) : null;
  return (
    <>
      {!(variant === "A" && p.sidebarOpen) && (
        <header className="m-top">
          <div className="m-top-left">{left}</div>
          <h1 className="m-title">{p.title}</h1>
          <div className="m-top-right">
            {p.noteTools}
            <button type="button" className="icon-button" data-proto="info" aria-label="Inspector" aria-pressed={p.inspectorOpen} onClick={p.toggleInspector}>
              <Icon name="info" />
            </button>
          </div>
        </header>
      )}
      {variant === "A" && !p.sidebarOpen && !p.keyboard && (
        <button type="button" className="m-fab" aria-label="New note" onClick={p.createNote}>
          <Icon name="edit" />
        </button>
      )}
      {variant === "B" && !p.keyboard && <TabBar {...p} />}
      {variant === "C" && p.sidebarOpen && <div className="m-scrim" onClick={() => p.setSidebarOpen(false)} />}
      {p.keyboard > 0 && <KeyBar bottom={p.keyboard} />}
      {p.keyboard > 0 && faked && (
        <div className="m-fake-keyboard" style={{ height: p.keyboard }}>
          on-screen keyboard
        </div>
      )}
      {variant === "B" && p.inspectorOpen && (
        <button type="button" className="m-sheet-done" onClick={p.toggleInspector}>
          Done
        </button>
      )}
    </>
  );
}

function TabBar(p: ChromeProps) {
  const tabs = [
    { icon: "dashboard", label: "Home", path: "/" },
    { icon: "folders", label: "Notes", path: null },
    { icon: "plus", label: "New", path: "new" },
    { icon: "search", label: "Search", path: "/search" },
    { icon: "todos", label: "Todos", path: "/todos" },
  ] as const;
  return (
    <div className="m-tabs" role="navigation" aria-label="Tabs">
      {tabs.map((t) => {
        const on = t.path === null ? p.sidebarOpen : !p.sidebarOpen && t.path === p.path;
        return (
          <button
            key={t.label}
            type="button"
            className="m-tab"
            data-new={t.path === "new" || undefined}
            data-proto={t.path === null ? "nav" : undefined}
            aria-current={on || undefined}
            onClick={() => {
              if (t.path === null) return p.setSidebarOpen(!p.sidebarOpen);
              p.setSidebarOpen(false);
              if (t.path === "new") p.createNote();
              else p.go(t.path);
            }}
          >
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Above the on-screen keyboard: what a phone has no keys for. */
function KeyBar({ bottom }: { bottom: number }) {
  const put = (text: string) => () => document.execCommand("insertText", false, text);
  const keys: { label: string; icon?: string; run: () => void }[] = [
    { label: "Undo", icon: "restore", run: () => document.execCommand("undo") },
    { label: "Heading", run: put("# ") },
    { label: "Todo", icon: "check", run: put("- [ ] ") },
    { label: "List", icon: "list", run: put("- ") },
    { label: "Link", icon: "link", run: put("[[") },
    { label: "Mention", icon: "at", run: put("@") },
    { label: "Tag", icon: "tag", run: put("#") },
    { label: "Embed", icon: "slash", run: put("/") },
  ];
  return (
    <div className="m-keys" style={{ bottom }} onPointerDown={(e) => e.preventDefault()}>
      <div className="m-keys-row">
        {keys.map((k) => (
          <button key={k.label} type="button" aria-label={k.label} onClick={k.run}>
            {k.icon ? <Icon name={k.icon as "check"} /> : <b>#</b>}
          </button>
        ))}
      </div>
      <button type="button" aria-label="Hide keyboard" className="m-keys-done" onClick={() => (document.activeElement as HTMLElement | null)?.blur()}>
        <Icon name="keyboard" />
      </button>
    </div>
  );
}

export function Switcher({ current }: { current: Variant }) {
  const keys = Object.keys(VARIANTS) as Variant[];
  const step = (by: number) => setVariant(keys[(keys.indexOf(current) + by + keys.length) % keys.length]!);
  return (
    <div className="proto-switcher" role="group" aria-label="Prototype variant">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ‹
      </button>
      <span>
        <b>{current}</b> {VARIANTS[current].split(":")[0]}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        ›
      </button>
    </div>
  );
}
