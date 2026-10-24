import { useEffect, useId, useState, type FormEvent } from "react";
import { asksAnything, type App, type MailRule, type MailRuleFields, type MailThread, type PluginHost } from "../../plugin-api.ts";
import { sender } from "./linking.tsx";

/** Where Settings shows the Email plugin's section. */
const SETTINGS_PATH = "/settings/email";
/** How long typing in a rule rests before what it matches is asked again. */
const PAUSE_MS = 300;

const EMPTY: MailRuleFields = { from: "", to: "", subject: "", hasWords: "", doesntHave: "", list: "", hasAttachment: false };

/** A rule "Skip mail like this" started, which Settings opens with. */
let started: MailRuleFields | null = null;

/** Opens Settings at the skip rules with a new rule filled in, for the member to look at and save. */
export function skipLike(app: App, rule: MailRuleFields): void {
  started = rule;
  app.go(SETTINGS_PATH);
}

const FIELDS: readonly { key: Exclude<keyof MailRuleFields, "hasAttachment">; label: string; hint: string }[] = [
  { key: "from", label: "From", hint: "An address or a domain, such as news@shop.example or shop.example" },
  { key: "to", label: "To", hint: "An address or a domain it was sent or copied to" },
  { key: "subject", label: "Subject has", hint: "Words in the subject" },
  { key: "hasWords", label: "Has the words", hint: 'Words, or "a phrase", anywhere in it' },
  { key: "doesntHave", label: "Doesn't have", hint: "Words it holds none of" },
  { key: "list", label: "Mailing list", hint: "The list it came through, as its List-Id names it" },
];

/** A rule in words, as the list of rules says it. */
export function described(rule: MailRuleFields): string {
  const parts = [
    rule.from && `from ${rule.from}`,
    rule.to && `to ${rule.to}`,
    rule.subject && `with “${rule.subject}” in the subject`,
    rule.hasWords && `with ${rule.hasWords}`,
    rule.doesntHave && `without ${rule.doesntHave}`,
    rule.list && `on the list ${rule.list}`,
    rule.hasAttachment && "with attachments",
  ].filter(Boolean);
  return `Mail ${parts.join(", ")}`;
}

type Matched = { count: number; messages: number; threads: MailThread[] } | null;

/**
 * The member's skip rules, under Email in Settings: mail any of them matches isn't kept, dropped as
 * it arrives as mail from someone else is. Each is a mail app's filter, "don't keep mail where…",
 * and while one is written it says how many threads already kept it matches. Saving one that
 * matches some asks whether to remove them too.
 */
export function SkipRules({ host }: { host: PluginHost }) {
  const [rules, setRules] = useState<readonly MailRule[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // The rule being written: a new one, or one of the list's by its id.
  const [editing, setEditing] = useState<{ id?: string; rule: MailRuleFields } | null>(() => {
    const rule = started;
    started = null;
    return rule && { rule };
  });

  useEffect(() => {
    let live = true;
    host.perform({ type: "email.rules" }).then(
      (answer) => live && setRules(answer.rules),
      (err: Error) => live && setProblem(err.message),
    );
    return () => {
      live = false;
    };
  }, [host]);

  const remove = async (rule: MailRule) => {
    setProblem(null);
    try {
      setRules((await host.perform({ type: "email.removeRule", id: rule.id })).rules);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <section className="sources email-rules" aria-label="Skip rules">
      <h2>Skip rules</h2>
      <p className="sources-none">Mail a rule matches isn't kept: it is dropped as it arrives, as mail from anyone else is. A forwarded message is read as its sender wrote it.</p>
      {rules && rules.length > 0 && (
        <ul className="source-list" aria-label="Rules">
          {rules.map((rule) => (
            <li key={rule.id} aria-label={described(rule)}>
              <span className="source-what">
                <strong>{described(rule)}</strong>
              </span>
              <button type="button" className="link" onClick={() => setEditing({ id: rule.id, rule })}>
                Edit
              </button>
              <button type="button" className="link" onClick={() => void remove(rule)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {said && (
        <p role="status" className="sources-none">
          {said}
        </p>
      )}
      {editing ? (
        <RuleForm
          key={editing.id ?? "new"}
          host={host}
          id={editing.id}
          start={editing.rule}
          onCancel={() => setEditing(null)}
          onSaved={(next, removed) => {
            setRules(next);
            setEditing(null);
            setSaid(removed ? `Saved, and removed ${removed} ${removed === 1 ? "message" : "messages"} already kept.` : "Saved.");
          }}
        />
      ) : (
        <button
          type="button"
          className="button"
          onClick={() => {
            setSaid(null);
            setEditing({ rule: EMPTY });
          }}
        >
          Add a rule
        </button>
      )}
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
    </section>
  );
}

function RuleForm({ host, id, start, onCancel, onSaved }: { host: PluginHost; id: string | undefined; start: MailRuleFields; onCancel: () => void; onSaved: (rules: MailRule[], removed: number) => void }) {
  const [rule, setRule] = useState<MailRuleFields>(start);
  const [matched, setMatched] = useState<Matched>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = useId();
  const any = asksAnything(rule);

  useEffect(() => {
    setAsking(false);
    if (!any) return setMatched(null);
    let live = true;
    const wait = setTimeout(() => {
      host.perform({ type: "email.matchRule", rule }).then(
        (answer) => live && setMatched(answer),
        () => live && setMatched(null),
      );
    }, PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [host, rule, any]);

  const save = async (removeKept: boolean) => {
    setProblem(null);
    setBusy(true);
    try {
      const answer = await host.perform({ type: "email.saveRule", ...(id && { id }), rule, removeKept });
      onSaved(answer.rules, answer.removed);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!any || busy) return;
    // A rule that matches mail already kept asks first whether that goes too.
    if (matched?.count) setAsking(true);
    else void save(false);
  };
  const threads = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

  return (
    <form className="email-rule-form" aria-label={id ? "Edit rule" : "New rule"} onSubmit={submit}>
      <p className="email-rule-lead">Don't keep mail where…</p>
      {FIELDS.map((field) => (
        <label key={field.key} className="email-rule-row">
          <span>{field.label}</span>
          <input value={rule[field.key]} placeholder={field.hint} maxLength={500} onChange={(e) => setRule((was) => ({ ...was, [field.key]: e.target.value }))} />
        </label>
      ))}
      <label className="email-rule-row email-rule-check">
        <input type="checkbox" name={`${name}-files`} checked={rule.hasAttachment} onChange={(e) => setRule((was) => ({ ...was, hasAttachment: e.target.checked }))} />
        <span>Has attachment</span>
      </label>
      <div className="email-rule-preview" role="status" aria-label="Matches">
        {!any ? (
          <p className="sources-none">Fill in at least one.</p>
        ) : matched === null ? (
          <p className="sources-none">Looking at the mail kept…</p>
        ) : matched.count === 0 ? (
          <p className="sources-none">Matches no thread kept so far.</p>
        ) : (
          <>
            <p>Matches {threads(matched.count)} kept so far:</p>
            <ul aria-label="Matching threads">
              {matched.threads.map((t) => (
                <li key={t.id}>
                  <strong>{t.subject}</strong> <span className="email-address">{sender(t)}</span>
                </li>
              ))}
              {matched.count > matched.threads.length && <li className="email-address">and {threads(matched.count - matched.threads.length)} more</li>}
            </ul>
          </>
        )}
      </div>
      {asking && matched ? (
        <div className="email-rule-ask" role="group" aria-label="Already kept">
          <p>
            Also remove the {threads(matched.count)} already kept{matched.messages !== matched.count ? ` (${matched.messages} messages)` : ""}? This can't be undone.
          </p>
          <div className="email-rule-foot">
            <button type="button" className="button danger" disabled={busy} onClick={() => void save(true)}>
              Remove the {matched.count}
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={() => void save(false)}>
              Keep them
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setAsking(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="email-rule-foot">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!any || busy}>
            Save rule
          </button>
        </div>
      )}
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
    </form>
  );
}
