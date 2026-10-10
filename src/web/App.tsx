import { useCallback, useEffect, useState } from "react";
import type { Me, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { notePath } from "../core/slug.ts";
import { ApiError, getMe, perform, signOut } from "./api.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { useRoute } from "./router.ts";

type Session = { kind: "loading" } | { kind: "signed-out"; devSignIn: boolean } | { kind: "signed-in"; me: Me } | { kind: "error"; message: string };

export function App() {
  const [session, setSession] = useState<Session>({ kind: "loading" });
  useEffect(() => {
    getMe().then(
      (me) => setSession({ kind: "signed-in", me }),
      (err) =>
        setSession(err instanceof ApiError && err.status === 401 ? { kind: "signed-out", devSignIn: err.devSignIn } : { kind: "error", message: String(err.message ?? err) }),
    );
  }, []);

  switch (session.kind) {
    case "loading":
      return null;
    case "error":
      return <p className="notice">Common Ink couldn't load: {session.message}</p>;
    case "signed-out":
      return <SignIn devSignIn={session.devSignIn} />;
    case "signed-in": {
      const workspace = session.me.workspaces[0];
      return workspace ? <Workspace me={session.me} workspace={workspace} /> : <p className="notice">You aren't in a workspace.</p>;
    }
  }
}

function SignIn({ devSignIn }: { devSignIn: boolean }) {
  const next = encodeURIComponent(location.pathname);
  return (
    <main className="sign-in">
      <img src="/favicon.svg" alt="" width={56} height={56} />
      <h1>Common Ink</h1>
      <p>Notes for you, your team, and your agents.</p>
      <a className="button primary" href={`/auth/google?next=${next}`}>
        Sign in with Google
      </a>
      {devSignIn && (
        <a className="button" href={`/auth/dev?next=${next}`}>
          Sign in as a dev user
        </a>
      )}
    </main>
  );
}

const byRecent = (a: NoteSummary, b: NoteSummary) => b.updatedAt - a.updatedAt;

function Workspace({ me, workspace }: { me: Me; workspace: WorkspaceSummary }) {
  const [route, navigate] = useRoute();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);

  useEffect(() => {
    perform(workspace.id, { type: "note.list" }).then(setNotes);
  }, [workspace.id]);

  const remember = useCallback((note: Note) => {
    const { text: _, ...summary } = note;
    setNotes((list) => [summary, ...(list ?? []).filter((n) => n.id !== note.id)].sort(byRecent));
    if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
  }, [navigate]);

  const createNote = async () => {
    const note = await perform(workspace.id, { type: "note.create" });
    remember(note);
    navigate(notePath(note));
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>Common Ink</span>
        </header>
        <div className="workspace-name">{workspace.name}</div>
        <button type="button" className="button primary" onClick={createNote}>
          New note
        </button>
        <nav aria-label="Notes">
          <ul>
            {notes?.map((note) => (
              <li key={note.id}>
                <a
                  href={notePath(note)}
                  aria-current={route.kind === "note" && route.id === note.id ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(notePath(note));
                  }}
                >
                  {note.title || "Untitled"}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <footer className="person">
          <span>{me.person.name}</span>
          <button type="button" className="link" onClick={() => signOut().then(() => location.assign("/"))}>
            Sign out
          </button>
        </footer>
      </aside>
      <main className="main">
        {route.kind === "note" && <NoteEditor key={route.id} workspaceId={workspace.id} noteId={route.id} onLoaded={remember} onSaved={remember} />}
        {route.kind === "home" && <p className="notice">{notes?.length ? "Pick a note, or start a new one." : "Start your first note."}</p>}
        {route.kind === "missing" && <p className="notice">There's nothing at this address.</p>}
      </main>
    </div>
  );
}
