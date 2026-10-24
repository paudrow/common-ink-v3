import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type ContactCard, type ContactChange, type ContactLine, type LabelledField, type PluginHost, type Source } from "../../plugin-api.ts";
import { MONTH_NAMES, changeOf, draftOf, fieldsOf, labelChoices, typeOf, writtenLabel, type Draft } from "./fields.ts";

/** The longest side of a picture as it is sent: enough for any place a contact's picture is drawn. */
const PICTURE_SIDE = 512;

/** A picture the member picked, made small and sent as a JPEG in base64. A file that isn't a picture is refused here. */
async function pictureOf(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't a picture");
  }
  const scale = Math.min(1, PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.88).slice("data:image/jpeg;base64,".length);
}

/** What the server said of a field it refused, as a sentence: its first line, without the field's path. */
const said = (message: string) => message.split("\n")[0]!.replace(/^✖\s*/, "").replace(/\s*→ at .*$/, "");

const LIST_WORDS: Record<LabelledField, { label: string; one: string; type: string }> = {
  emails: { label: "Email", one: "email", type: "email" },
  phones: { label: "Phone", one: "phone", type: "tel" },
  addresses: { label: "Address", one: "address", type: "text" },
  urls: { label: "Website", one: "website", type: "url" },
};

/** The menu entry that turns a line's label into a box to write one in. */
const CUSTOM = "custom";

/**
 * A line's label: a small menu of none, Google's own labels and the line's own, and Custom…, which
 * puts a box in its place to write a label in. Enter or leaving the box keeps what was written, and
 * Escape goes back to the label it had.
 */
function LabelMenu({ field, type, name, onChange }: { field: LabelledField; type: string | null; name: string; onChange: (type: string | null) => void }) {
  const [writing, setWriting] = useState<string | null>(null);
  const menu = useRef<HTMLSelectElement>(null);
  // Done with the keys, the keyboard goes back to the menu; done by leaving the box, it stays where it went.
  const backToMenu = useRef(false);
  useEffect(() => {
    if (writing === null && backToMenu.current) menu.current?.focus();
    backToMenu.current = false;
  }, [writing]);
  const choices = labelChoices(field, type);
  if (writing !== null) {
    const done = (keep: boolean, keys: boolean) => {
      // A browser that blurs the box as it is taken away would otherwise end it twice, keeping what Escape dropped.
      if (backToMenu.current) return;
      if (keep) onChange(typeOf(field, writing));
      backToMenu.current = keys;
      setWriting(null);
    };
    return (
      <input
        className="contact-form-type"
        aria-label={name}
        placeholder="Label"
        maxLength={100}
        autoFocus
        value={writing}
        onChange={(e) => setWriting(e.target.value)}
        onBlur={() => done(true, false)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return;
          // Neither sends the form nor closes it: each is for the label alone.
          e.preventDefault();
          e.stopPropagation();
          done(e.key === "Enter", true);
        }}
      />
    );
  }
  return (
    <select
      ref={menu}
      className="contact-form-type"
      aria-label={name}
      value={String(choices.findIndex((choice) => choice.type === type))}
      onChange={(e) => (e.target.value === CUSTOM ? setWriting(writtenLabel(field, type) ?? "") : onChange(choices[Number(e.target.value)]!.type))}
    >
      {choices.map((choice, i) => (
        <option key={i} value={String(i)}>
          {choice.words}
        </option>
      ))}
      <option value={CUSTOM}>Custom…</option>
    </select>
  );
}

/** One of a contact's lists as lines to edit, each with its label, a way to take it off, and a way to add one. */
function Lines({ field, lines, onChange }: { field: LabelledField; lines: ContactLine[]; onChange: (lines: ContactLine[]) => void }) {
  const words = LIST_WORDS[field];
  const change = (i: number, line: Partial<ContactLine>) => onChange(lines.map((was, at) => (at === i ? { ...was, ...line } : was)));
  return (
    <div className="contact-form-row" role="group" aria-label={words.label}>
      <span className="contact-form-label">{words.label}</span>
      <div className="contact-form-lines">
        {lines.map((line, i) => (
          <div key={i} className="contact-form-line">
            <LabelMenu field={field} type={line.type} name={`${words.label} label ${i + 1}`} onChange={(type) => change(i, { type })} />
            <span className="contact-form-value">
              <input type={words.type} aria-label={`${words.label} ${i + 1}`} value={line.value} onChange={(e) => change(i, { value: e.target.value })} />
              <button type="button" className="icon-button" aria-label={`Remove ${words.one} ${line.value || i + 1}`} title={`Remove ${words.one}`} onClick={() => onChange(lines.filter((_, at) => at !== i))}>
                <Icon name="close" />
              </button>
            </span>
          </div>
        ))}
        <button type="button" className="button small contact-form-add" onClick={() => onChange([...lines, { value: "", type: null }])}>
          <Icon name="plus" />
          Add {words.one}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="contact-form-row">
      <span className="contact-form-label">{label}</span>
      {children}
    </label>
  );
}

interface FormProps {
  host: PluginHost;
  card: ContactCard;
  onSaved: (card: ContactCard, change: ContactChange) => void;
  onCancel: () => void;
}

/** A contact as a form, the way a contacts app edits one: every field, Save sending what changed, and a picture put on or taken off at once. */
function ContactForm({ host, card, onSaved, onCancel }: FormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(card));
  const [photo, setPhoto] = useState(card.photo);
  // A picture put on or taken off moves the contact's etag on, and a Save after it is made to the contact as it is then.
  const [etag, setEtag] = useState(card.etag);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const run = async (doing: () => Promise<void>) => {
    setProblem(null);
    setBusy(true);
    try {
      await doing();
    } catch (err) {
      setProblem(err instanceof Error ? said(err.message) : "The contact couldn't be changed.");
    }
    setBusy(false);
  };
  const picture = (chosen: File | null) =>
    run(async () => {
      const made = await host.perform({ type: "contact.photo", sourceId: card.sourceId, id: card.id, photo: chosen ? await pictureOf(chosen) : null });
      setPhoto(made.photo);
      setEtag(made.etag);
    });
  const save = () =>
    !busy &&
    run(async () => {
      const made = changeOf(card, draft);
      if ("problem" in made) throw new Error(made.problem);
      const saved = Object.keys(made.change).length ? await host.perform({ type: "contact.update", sourceId: card.sourceId, id: card.id, etag, ...made.change }) : { ...card, photo, etag };
      onSaved(saved, made.change);
    });

  return (
    <form
      className="contact-form"
      aria-label={`Edit ${card.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
      }}
    >
      <div className="contact-form-photo">
        {photo ? <img className="person-photo" src={photo} alt={`Picture of ${card.name}`} referrerPolicy="no-referrer" /> : <span className="person-photo" aria-hidden="true" />}
        <input ref={file} type="file" accept="image/*" hidden aria-label="Picture file" onChange={(e) => void picture(e.target.files?.[0] ?? null).finally(() => (e.target.value = ""))} />
        <button type="button" className="button small" aria-disabled={busy || undefined} onClick={() => !busy && file.current?.click()}>
          {photo ? "Change photo" : "Add photo"}
        </button>
        {photo && (
          <button type="button" className="button small" aria-disabled={busy || undefined} onClick={() => !busy && void picture(null)}>
            Remove photo
          </button>
        )}
      </div>
      <Row label="Name">
        <input value={draft.name} autoFocus onChange={(e) => set("name", e.target.value)} />
      </Row>
      <Lines field="emails" lines={draft.emails} onChange={(v) => set("emails", v)} />
      <Lines field="phones" lines={draft.phones} onChange={(v) => set("phones", v)} />
      <Row label="Organization">
        <input value={draft.organization} onChange={(e) => set("organization", e.target.value)} />
      </Row>
      <Row label="Title">
        <input value={draft.title} onChange={(e) => set("title", e.target.value)} />
      </Row>
      <Lines field="addresses" lines={draft.addresses} onChange={(v) => set("addresses", v)} />
      <div className="contact-form-row" role="group" aria-label="Birthday">
        <span className="contact-form-label">Birthday</span>
        <div className="contact-form-birthday">
          <input aria-label="Day" inputMode="numeric" placeholder="Day" maxLength={2} value={draft.birthday.day} onChange={(e) => set("birthday", { ...draft.birthday, day: e.target.value })} />
          <select aria-label="Month" value={draft.birthday.month} onChange={(e) => set("birthday", { ...draft.birthday, month: e.target.value })}>
            <option value="">Month</option>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={String(i + 1)}>
                {name}
              </option>
            ))}
          </select>
          <input aria-label="Year" inputMode="numeric" placeholder="Year" maxLength={4} value={draft.birthday.year} onChange={(e) => set("birthday", { ...draft.birthday, year: e.target.value })} />
        </div>
      </div>
      <Lines field="urls" lines={draft.urls} onChange={(v) => set("urls", v)} />
      <Row label="Notes">
        <textarea rows={3} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
      </Row>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      <div className="contact-form-foot">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" aria-disabled={busy || undefined}>
          Save
        </button>
      </div>
    </form>
  );
}

interface Props {
  host: PluginHost;
  card: ContactCard;
  /** The data source the contact is in, as the member's source list says it, once that is read. */
  source: Source | undefined;
  /** After a change is made: the contact as it is now kept, and what changed. */
  onSaved: (card: ContactCard, change: ContactChange) => void;
  /** Connects the data source again, asking to change it too. */
  onConnect: (source: Source) => void;
  /** Whether the page is of this contact by another name: a member's, or a contact merged into this one. */
  otherName?: boolean;
}

/**
 * One of the asker's contacts that is this person: all it holds, which the asker alone is shown. Edit
 * opens it as a form where its data source takes changes; where it would once the member agreed to
 * more, it says so and offers to connect it again.
 */
export function ContactSection({ host, card, source, onSaved, onConnect, otherName = false }: Props) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <section className="person-contact" aria-label={`Your contact ${card.name}`}>
        <ContactForm
          host={host}
          card={card}
          onCancel={() => setEditing(false)}
          onSaved={(saved, change) => {
            setEditing(false);
            onSaved(saved, change);
          }}
        />
      </section>
    );
  return (
    <section className="person-contact" aria-label={`Your contact ${card.name}`}>
      <div className="person-contact-head">
        <p className="person-whose">{otherName ? `${card.name}, from your contacts.` : "From your contacts."} Only you see this.</p>
        {source?.writable && (
          <button type="button" className="button small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {source?.reconnectToWrite && (
          <button type="button" className="button small" onClick={() => onConnect(source)}>
            Connect again to edit contacts
          </button>
        )}
      </div>
      {source?.reconnectToWrite && <p className="person-whose">{source.name} is connected for reading only, so these can't be changed here yet.</p>}
      <dl className="person-fields">
        {fieldsOf(card).map((field, i) => (
          <div key={i} className="person-field" data-field={field.key}>
            <dt>{field.label}</dt>
            <dd>
              {field.values.map((value) => (
                <div key={value}>{field.href ? <a href={field.href(value)} {...(field.key === "urls" && { target: "_blank", rel: "noopener noreferrer" })}>{value}</a> : value}</div>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {card.url && /^https:\/\//.test(card.url) && (
        <a className="person-source" href={card.url} target="_blank" rel="noopener noreferrer">
          Open in {source?.provider ?? "its contacts"}
        </a>
      )}
    </section>
  );
}
