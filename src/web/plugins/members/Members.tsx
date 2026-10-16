import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, useNow, type App, type Invite, type Member, type PluginHost, type Role } from "../../plugin-api.ts";
import { Copyable } from "../lib/Copyable.tsx";

const ROLES: readonly Role[] = ["admin", "editor", "viewer"];
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
const CAN: Record<Role, string> = {
  admin: "Admins write notes and manage members.",
  editor: "Editors write notes.",
  viewer: "Viewers read notes and can't change them.",
};
const LAST_ADMIN = "A workspace needs an admin. Make someone else an admin first.";

const inviteLink = (invite: Invite) => `${location.origin}/invite/${invite.id}`;

/** Something to be sure of before it is done, asked in the row it is about. */
type Asked = { kind: "remove"; member: Member } | { kind: "signOut"; member: Member } | { kind: "leave" } | { kind: "revoke"; invite: Invite } | null;

/** Who is in the workspace. Anyone in it can look, and leave. An admin invites people, sets their roles, signs them out, and removes them. */
export function Members({ host, app }: { host: PluginHost; app: App }) {
  const now = useNow();
  const { workspace, me } = app;
  const admin = workspace.role === "admin";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  /** The invite just made, shown with its link until the admin is done with it. */
  const [fresh, setFresh] = useState<Invite | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, ask] = useState<Asked>(null);

  const load = useCallback(async () => {
    const [everyone, pending] = await Promise.all([host.perform({ type: "member.list" }), admin ? host.members.invites() : []]);
    setMembers(everyone);
    setInvites(pending);
  }, [host, admin]);
  useEffect(() => void load().catch((err: Error) => setError(err.message)), [load]);

  /** Does one thing to the members and reads them again, whether or not it worked: a refusal may mean they have changed. */
  const change = async (doing: () => Promise<string | null>, { mine = false } = {}) => {
    ask(null);
    setError(null);
    setSaid(null);
    try {
      setSaid(await doing());
    } catch (err) {
      setError((err as Error).message);
    }
    // The app is drawn from the member's own role, so a change to it is read by the app, not only this page.
    if (mine) app.reloadWorkspaces();
    await load().catch(() => {});
  };

  const invite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = (data.get("email") as string).trim();
    const as = data.get("role") as Role;
    setFresh(null);
    void change(
      async () => {
        const made = await host.members.invite(email, as);
        form.reset();
        if (made.invite) setFresh(made.invite);
        return made.member ? `${made.member.name} is already a member. Their role is now ${ROLE_LABEL[made.member.role].toLowerCase()}.` : null;
      },
      { mine: email.toLowerCase() === me.email },
    );
  };

  const setRole = (member: Member, as: Role) =>
    change(
      async () => {
        await host.members.setRole(member.personId, as);
        return `${member.name} is now ${as === "viewer" ? "a" : "an"} ${as}.`;
      },
      { mine: member.personId === me.id },
    );

  const remove = (member: Member) =>
    change(async () => {
      await host.members.remove(member.personId);
      return `${member.name} is no longer in ${workspace.name}.`;
    });

  const signOut = (member: Member) =>
    change(async () => {
      await host.members.signOut(member.personId);
      return `${member.name} is signed out everywhere.`;
    });

  const leave = () =>
    change(
      async () => {
        await host.members.leave();
        app.go("/");
        return null;
      },
      { mine: true },
    );

  const revoke = (pending: Invite) =>
    change(async () => {
      await host.members.revoke(pending.id);
      if (fresh?.id === pending.id) setFresh(null);
      return `The invite for ${pending.email} was taken back.`;
    });

  const admins = members?.filter((m) => m.role === "admin").length ?? 0;

  const row = (member: Member) => {
    const self = member.personId === me.id;
    const onlyAdmin = member.role === "admin" && admins === 1;
    return (
      <li key={member.personId} className="agent" aria-label={member.name}>
        <div className="agent-head">
          <span className="agent-name">{member.name}</span>
          {self && <span className="badge">you</span>}
          {member.email && <span className="agent-meta">{member.email}</span>}
          <span className="member-role">
            {admin ? (
              <select aria-label={`Role of ${member.name}`} value={member.role} disabled={onlyAdmin} title={onlyAdmin ? LAST_ADMIN : undefined} onChange={(e) => void setRole(member, e.target.value as Role)}>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="badge">{ROLE_LABEL[member.role]}</span>
            )}
            {self ? (
              <button type="button" className="button small" disabled={onlyAdmin} title={onlyAdmin ? LAST_ADMIN : undefined} onClick={() => ask({ kind: "leave" })}>
                Leave
              </button>
            ) : (
              admin && (
                <>
                  <button type="button" className="button small" aria-label={`Sign out ${member.name}`} onClick={() => ask({ kind: "signOut", member })}>
                    Sign out
                  </button>
                  <button type="button" className="button small" aria-label={`Remove ${member.name}`} onClick={() => ask({ kind: "remove", member })}>
                    Remove
                  </button>
                </>
              )
            )}
          </span>
        </div>
        {asked?.kind === "remove" && asked.member.personId === member.personId && (
          <span className="confirm" role="group" aria-label={`Remove ${member.name}`}>
            <span>
              {member.name} and their agents lose {workspace.name} at once. What they wrote stays, under their name. Their private notes stop being private, and everyone in {workspace.name} can
              then see them as ordinary notes.
            </span>
            <button type="button" className="button small primary" autoFocus onClick={() => void remove(member)}>
              Remove
            </button>
            <button type="button" className="link" onClick={() => ask(null)}>
              Cancel
            </button>
          </span>
        )}
        {asked?.kind === "signOut" && asked.member.personId === member.personId && (
          <span className="confirm" role="group" aria-label={`Sign out ${member.name}`}>
            <span>
              {member.name} is signed out of Common Ink in every browser at once, here and in every other workspace. They stay in {workspace.name} and can sign in again. Their agents keep their
              tokens, which only removing them from {workspace.name} takes from here.
            </span>
            <button type="button" className="button small primary" autoFocus onClick={() => void signOut(member)}>
              Sign out everywhere
            </button>
            <button type="button" className="link" onClick={() => ask(null)}>
              Cancel
            </button>
          </span>
        )}
        {asked?.kind === "leave" && self && (
          <span className="confirm" role="group" aria-label={`Leave ${workspace.name}`}>
            <span>You and your agents lose {workspace.name} at once. What you wrote stays, under your name. Only an admin can bring you back.</span>
            <button type="button" className="button small primary" autoFocus onClick={() => void leave()}>
              Leave {workspace.name}
            </button>
            <button type="button" className="link" onClick={() => ask(null)}>
              Cancel
            </button>
          </span>
        )}
      </li>
    );
  };

  return (
    <section className="agents members" aria-label="Members">
      <h1>Members</h1>
      <p className="lead">
        Everyone in {workspace.name}. {ROLES.map((role) => CAN[role]).join(" ")} {admin ? "" : "An admin invites people and sets what each can do."}
      </p>

      {admin && (
        <form className="connect" aria-label="Invite someone" onSubmit={invite}>
          <h2>Invite someone</h2>
          <label>
            <span>Email</span>
            <input name="email" type="email" required maxLength={254} placeholder="grace@example.com" autoComplete="off" />
          </label>
          <label>
            <span>Role</span>
            <select name="role" defaultValue="editor">
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="button primary">
            Invite
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {said && (
        <p role="status" className="said">
          {said}
        </p>
      )}
      {fresh && (
        <section className="new-token" aria-label="New invite">
          <p>
            <strong>
              {fresh.email} is invited as {fresh.role === "viewer" ? "a" : "an"} {fresh.role}.
            </strong>{" "}
            They are in {workspace.name} the next time they sign in with that email. Common Ink doesn't email them, so tell them, or send this link.
          </p>
          <Copyable label="Invite link" value={inviteLink(fresh)} />
          <p className="hint">The link opens {workspace.name} for {fresh.email} and for nobody else, whoever has it.</p>
          <button type="button" className="button small" onClick={() => setFresh(null)}>
            Done
          </button>
        </section>
      )}

      <h2>In this workspace</h2>
      <ul className="agent-list" aria-label="Members">
        {members?.map(row)}
      </ul>

      {admin && (
        <>
          <h2>Invited</h2>
          {!invites.length && <p className="empty">Nobody is waiting on an invite.</p>}
          <ul className="agent-list" aria-label="Invites">
            {invites.map((pending) => (
              <li key={pending.id} className="agent" aria-label={pending.email}>
                <div className="agent-head">
                  <span className="agent-name">{pending.email}</span>
                  <span className="badge">{ROLE_LABEL[pending.role]}</span>
                  <span className="agent-meta">
                    invited by {pending.invitedBy.name} {ago(pending.createdAt, now)}
                  </span>
                  <span className="member-role">
                    <button type="button" className="button small" aria-label={`Show the link for ${pending.email}`} onClick={() => setFresh(pending)}>
                      Link
                    </button>
                    <button type="button" className="button small" aria-label={`Revoke the invite for ${pending.email}`} onClick={() => ask({ kind: "revoke", invite: pending })}>
                      Revoke
                    </button>
                  </span>
                </div>
                {asked?.kind === "revoke" && asked.invite.id === pending.id && (
                  <span className="confirm" role="group" aria-label={`Revoke the invite for ${pending.email}`}>
                    <span>{pending.email} won't be let in, and the link stops working.</span>
                    <button type="button" className="button small primary" autoFocus onClick={() => void revoke(pending)}>
                      Revoke
                    </button>
                    <button type="button" className="link" onClick={() => ask(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
