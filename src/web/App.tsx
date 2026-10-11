import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Me } from "../core/protocol.ts";
import { ApiError, getMe, perform } from "./api.ts";
import { useRoute } from "./router.ts";
import { createSettingsStore, type SettingsStore } from "./settingsStore.ts";
import { isString, useStored } from "./stored.ts";
import { Workspace } from "./Workspace.tsx";

type Session = { kind: "loading" } | { kind: "signed-out" } | { kind: "signed-in"; me: Me } | { kind: "error"; message: string };

export function App() {
  const [session, setSession] = useState<Session>({ kind: "loading" });
  useEffect(() => {
    getMe().then(
      (me) => setSession({ kind: "signed-in", me }),
      (err) =>
        setSession(err instanceof ApiError && err.status === 401 ? { kind: "signed-out" } : { kind: "error", message: String(err.message ?? err) }),
    );
  }, []);

  switch (session.kind) {
    case "loading":
      return null;
    case "error":
      return <p className="notice">Common Ink couldn't load: {session.message}</p>;
    case "signed-out":
      return <SignIn />;
    case "signed-in":
      return session.me.workspaces.length ? <SignedIn me={session.me} /> : <p className="notice">You aren't in a workspace.</p>;
  }
}

function SignIn() {
  const next = encodeURIComponent(location.pathname);
  return (
    <main className="sign-in">
      <img src="/favicon.svg" alt="" width={56} height={56} />
      <h1>Common Ink</h1>
      <p>Notes for you, your team, and your agents.</p>
      <a className="button primary" href={`/auth/google?next=${next}`}>
        Sign in with Google
      </a>
    </main>
  );
}

/** How long the workspace waits for the member's settings before it is drawn with the defaults. */
const SETTINGS_WAIT_MS = 1500;

function SignedIn({ me }: { me: Me }) {
  const [place, navigate] = useRoute();
  const [chosenId, choose] = useStored("ink.workspace", isString, me.workspaces[0]!.id);
  const workspace = me.workspaces.find((w) => w.id === chosenId) ?? me.workspaces[0]!;
  const { store, status, waited } = useSettings(workspace.id);
  // Drawing before the settings are read would flash the plugins that are off and the wrong theme, so it waits a little.
  if (status.kind === "loading" && !waited) return null;
  return (
    <>
      <Workspace
        key={workspace.id}
        me={me}
        workspace={workspace}
        settings={store}
        place={place}
        navigate={navigate}
        onSwitch={(id) => {
          choose(id);
          navigate("/");
        }}
      />
      {status.kind === "loading" && (
        <p role="status" className="settings-banner">
          Loading your settings. The defaults are in use until they arrive.
        </p>
      )}
      {status.kind === "unread" && (
        <p role="alert" className="settings-banner">
          Your settings couldn't be loaded, so the defaults are in use and changes to them aren't kept. ({status.message})
          <button type="button" className="button small" onClick={() => void store.load()}>
            Try again
          </button>
        </p>
      )}
    </>
  );
}

/** The member's settings in a workspace, and whether they have been waited for long enough to go on without them. */
function useSettings(workspaceId: string) {
  const store = useMemo(
    () =>
      createSettingsStore({
        read: () => perform(workspaceId, { type: "settings.read" }),
        write: (text, on) => perform(workspaceId, { type: "settings.write", text, ...on }),
      }),
    [workspaceId],
  );
  const status = useSyncExternalStore(store.subscribe, store.status);
  const [waitedFor, setWaitedFor] = useState<SettingsStore | null>(null);
  useEffect(() => {
    void store.load();
    const timer = setTimeout(() => setWaitedFor(store), SETTINGS_WAIT_MS);
    const refresh = () => document.visibilityState === "visible" && void store.refresh();
    addEventListener("focus", refresh);
    addEventListener("pageshow", refresh);
    addEventListener("pagehide", store.flush);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      removeEventListener("focus", refresh);
      removeEventListener("pageshow", refresh);
      removeEventListener("pagehide", store.flush);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [store]);
  return { store, status, waited: waitedFor === store };
}
