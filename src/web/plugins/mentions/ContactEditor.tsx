import { useRef, useState, type ReactNode } from "react";
import { Icon, type ContactCard, type ContactChange, type PluginHost, type Source } from "../../plugin-api.ts";
import { MONTH_NAMES, changeOf, draftOf, fieldsOf, type Draft, type ListKey } from "./fields.ts";

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

const LIST_WORDS: Record<ListKey, { label: string; one: string; type: string }> = {
  emails: { label: "Email", one: "email", type: "email" },
  phones: { label: "Phone", one: "phone", type: "tel" },
  addresses: { label: "Address", one: "address", type: "text" },
  urls: { label: "Website", one: "website", type: "url" },
};

/** One of a contact's lists as lines to edit, each with a way to take it off, and a way to add one. */
function Lines({ field, values, onChange }: { field: ListKey; values: string[]; onChange: (values: string[]) => void }) {
  const words = LIST_WORDS[field];
  return (
    <div className="contact-form-row" role="group" aria-label={words.label}>
      <span className="contact-form-label">{words.label}</span>
      <div className="contact-form-lines">
        {values.map((value, i) => (
          <div key={i} className="contact-form-line">
            <input type={words.type} aria-label={`${words.label} ${i + 1}`} value={value} onChange={(e) => onChange(values.map((v, at) => (at === i ? e.target.value : v)))} />
            <button type="button" className="icon-button" aria-label={`Remove ${words.one} ${value || i + 1}`} title={`Remove ${words.one}`} onClick={() => onChange(values.filter((_, at) => at !== i))}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <button type="button" className="button small contact-form-add" onClick={() => onChange([...values, ""])}>
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
      <Lines field="emails" values={draft.emails} onChange={(v) => set("emails", v)} />
      <Lines field="phones" values={draft.phones} onChange={(v) => set("phones", v)} />
      <Row label="Organization">
        <input value={draft.organization} onChange={(e) => set("organization", e.target.value)} />
      </Row>
      <Row label="Title">
        <input value={draft.title} onChange={(e) => set("title", e.target.value)} />
      </Row>
      <Lines field="addresses" values={draft.addresses} onChange={(v) => set("addresses", v)} />
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
      <Lines field="urls" values={draft.urls} onChange={(v) => set("urls", v)} />
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
}

/**
 * One of the asker's contacts that is this person: all it holds, which the asker alone is shown. Edit
 * opens it as a form where its data source takes changes; where it would once the member agreed to
 * more, it says so and offers to connect it again.
 */
export function ContactSection({ host, card, source, onSaved, onConnect }: Props) {
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
        <p className="person-whose">From your contacts. Only you see this.</p>
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
        {fieldsOf(card).map((field) => (
          <div key={field.key} className="person-field" data-field={field.key}>
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
