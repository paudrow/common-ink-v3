import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Me, MeHere } from "../core/protocol.ts";
import { ApiError, getMe, onRefused, perform, session, signOut, workspaceOfInvite, workspaceOfNote } from "./api.ts";
import { showing, targetOf, type Target } from "./leads.ts";
import { useRoute, type Place } from "./router.ts";
import { createSettingsStore, type SettingsStore } from "./settingsStore.ts";
import { isString, useStored } from "./stored.ts";
import { Connect } from "./Connect.tsx";
import { Workspace } from "./Workspace.tsx";

type Session = { kind: "loading" } | { kind: "signed-out" } | { kind: "signed-in"; me: MeHere } | { kind: "error"; message: string };

const same = (a: Me, b: Me) => JSON.stringify(a) === JSON.stringify(b);

export function App() {
  const [session, setSession] = useState<Session>({ kind: "loading" });
  const reading = useRef<Promise<void> | null>(null);
  /** Reads who the person is and which workspaces they are in. A reading that fails leaves a signed-in person as they were. */
  const load = useCallback(() => {
    reading.current ??= getMe()
      .then(
        (me) => setSession((was) => (was.kind === "signed-in" && same(was.me, me) ? was : { kind: "signed-in", me })),
        (err) =>
          setSession((was) => {
            if (err instanceof ApiError && err.status === 401) return { kind: "signed-out" };
            return was.kind === "signed-in" ? was : { kind: "error", message: String(err.message ?? err) };
          }),
      )
      .finally(() => (reading.current = null));
    return reading.current;
  }, []);
  useEffect(() => {
    void load();
    // A role changed or a member removed by an admin shows the next time the member comes back, or is refused something.
    const again = () => document.visibilityState === "visible" && void load();
    addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    const stop = onRefused(() => void load());
    return () => {
      removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
      stop();
    };
  }, [load]);

  switch (session.kind) {
    case "loading":
      return null;
    case "error":
      return <p className="notice">Common Ink couldn't load: {session.message}</p>;
    case "signed-out":
      return <SignIn />;
    case "signed-in":
      if (location.pathname === "/connect") return <Connect me={session.me} />;
      return session.me.workspaces.length ? <SignedIn me={session.me} reload={load} /> : <p className="notice">You aren't in a workspace.</p>;
  }
}

function SignIn() {
  const next = encodeURIComponent(location.pathname + location.search);
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

/** What an invite's link shows anyone it doesn't let in. It says nothing of the invite, not even whether there is one. */
function NotInvited({ email, onContinue }: { email: string; onContinue: () => void }) {
  return (
    <main className="sign-in">
      <img src="/favicon.svg" alt="" width={56} height={56} />
      <h1>This invite doesn't let you in</h1>
      <p>
        You are signed in as {email}. An invite lets in only the email it was made for, and only until it is taken back. If it was made for another email of yours, sign out and sign in with that
        one. Otherwise ask whoever sent the link to invite {email}.
      </p>
      <button type="button" className="button primary" onClick={onContinue}>
        Go to my notes
      </button>
      <button type="button" className="link" onClick={() => void signOut().then(() => location.assign(location.pathname))}>
        Sign out
      </button>
    </main>
  );
}

/** How long the workspace waits for the member's settings before it is drawn with the defaults. */
const SETTINGS_WAIT_MS = 1500;

function SignedIn({ me, reload }: { me: MeHere; reload: () => Promise<void> }) {
  const [place, navigate] = useRoute();
  const [chosenId, choose] = useStored("ink.workspace", isString, me.workspaces[0]!.id);
  const { found, noteIsHere } = useFound(me, targetOf(place), chosenId);
  const shown = showing(place, found, me.workspaces, chosenId);
  const workspaceId = shown.kind === "asking" || shown.kind === "not-invited" ? null : shown.workspace.id;
  useEffect(() => {
    if (workspaceId) choose(workspaceId);
    if (shown.kind === "joined") navigate("/", { replace: true });
  }, [workspaceId, shown.kind, choose, navigate]);
  /** The last address whose workspace was known, which stays up while the next one's is asked for. */
  const settled = useRef<Extract<typeof shown, { kind: "workspace" }> | null>(null);
  if (shown.kind === "workspace") settled.current = shown;

  if (shown.kind === "not-invited") return <NotInvited email={me.person.email} onContinue={() => navigate("/", { replace: true })} />;
  const showingNow = settled.current;
  if (shown.kind === "joined" || !showingNow) return null;
  return <InWorkspace me={me} at={showingNow} navigate={navigate} choose={choose} noteIsHere={noteIsHere} reload={reload} />;
}

/**
 * Where the addresses that name a note or an invite lead, asked of the server once each. What it is
 * told is good while the person's workspaces stay the same.
 */
function useFound(me: Me, target: Target | null, chosenId: string) {
  const memberships = me.workspaces.map((w) => w.id).join();
  const kept = useRef({ memberships, found: new Map<string, string | null>() });
  if (kept.current.memberships !== memberships) kept.current = { memberships, found: new Map() };
  const { found } = kept.current;
  const [, redraw] = useState(0);
  const key = target?.key;
  const unknown = target && !found.has(target.key) ? target : null;
  useEffect(() => {
    if (!unknown) return;
    let live = true;
    (unknown.kind === "note" ? workspaceOfNote : workspaceOfInvite)(unknown.id)
      // With no answer, the chosen workspace is left to show what it can.
      .catch(() => (unknown.kind === "note" ? chosenId : null))
      .then((workspaceId) => {
        if (!live) return;
        found.set(unknown.key, workspaceId);
        redraw((n) => n + 1);
      });
    return () => {
      live = false;
    };
    // Asked once for each address: `unknown` is a new object on every render.
  }, [key, found]);
  /** A note the workspace has just listed, loaded, or made is known without asking. It is recorded at once, so going to it next waits for nothing. */
  const noteIsHere = useCallback((noteId: string, workspaceId: string) => void kept.current.found.set(noteId, workspaceId), []);
  return { found, noteIsHere };
}

interface InWorkspaceProps {
  me: MeHere;
  at: { workspace: Me["workspaces"][number]; place: Place };
  navigate: ReturnType<typeof useRoute>[1];
  choose: (workspaceId: string) => void;
  noteIsHere: (noteId: string, workspaceId: string) => void;
  reload: () => Promise<void>;
}

function InWorkspace({ me, at: { workspace, place }, navigate, choose, noteIsHere, reload }: InWorkspaceProps) {
  const { store, status, waited } = useSettings(workspace.id);
  const signedOut = useSignedOut(store);
  // Drawing before the settings are read would flash the plugins that are off and the wrong theme, so it waits a little.
  if (status.kind === "loading" && !waited) return null;
  return (
    <>
      <Workspace
        // A role is what the app is drawn from, so a member whose role changed gets the app again.
        key={`${workspace.id} ${workspace.role}`}
        me={me}
        workspace={workspace}
        settings={store}
        place={place}
        navigate={navigate}
        onSwitch={(id) => {
          choose(id);
          navigate("/");
        }}
        noteIsHere={noteIsHere}
        reloadWorkspaces={reload}
      />
      {signedOut && (
        <p role="alert" className="settings-banner signed-out">
          You're signed out, so nothing is being saved. What you typed stays in this tab: sign in, then come back to it.
          <a className="button small" href={`/auth/google?next=${encodeURIComponent(place.path)}`} target="_blank" rel="noreferrer">
            Sign in
          </a>
          <button type="button" className="button small" onClick={() => void getMe().catch(() => {})}>
            Try again
          </button>
        </p>
      )}
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

/**
 * Whether the session has ended under this page. While it has, coming back to the tab asks the
 * server who this is, and an answer says the member is signed in again: what was typed is then sent
 * by whatever kept it, and the settings by this.
 */
function useSignedOut(store: SettingsStore) {
  const signedOut = useSyncExternalStore(session.subscribe, session.signedOut);
  const was = useRef(signedOut);
  useEffect(() => {
    const back = was.current && !signedOut;
    was.current = signedOut;
    if (back) void store.refresh();
    if (!signedOut) return;
    const check = () => document.visibilityState === "visible" && void getMe().catch(() => {});
    addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [signedOut, store]);
  return signedOut;
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
