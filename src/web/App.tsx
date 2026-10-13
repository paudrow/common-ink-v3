import { useEffect, useState } from "react";
import type { Me } from "../core/protocol.ts";
import { ApiError, getMe } from "./api.ts";
import { useRoute } from "./router.ts";
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

function SignedIn({ me }: { me: Me }) {
  const [place, navigate] = useRoute();
  const [chosenId, choose] = useStored("ink.workspace", isString, me.workspaces[0]!.id);
  const workspace = me.workspaces.find((w) => w.id === chosenId) ?? me.workspaces[0]!;
  return (
    <Workspace
      key={workspace.id}
      me={me}
      workspace={workspace}
      place={place}
      navigate={navigate}
      onSwitch={(id) => {
        choose(id);
        navigate("/");
      }}
    />
  );
}
