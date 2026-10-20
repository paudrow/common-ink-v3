import { useEffect, useId, useState } from "react";
import { nameKey } from "../core/folder-names.ts";
import { Id } from "../core/protocol.ts";
import { chordLabel } from "./keybindings.ts";
import type { Folders, Setting, SettingValue } from "./plugin-api.ts";
import { readSetting, type Declared, type Problem } from "./settings.ts";

const describe = (setting: Setting, value: SettingValue, mac: boolean, folders: Folders | null) => {
  if (setting.type === "boolean") return value ? "on" : "off";
  if (setting.type === "folder") return value === "" ? setting.defaultFolder : folderLabel(folders, value as string, setting.defaultFolder);
  if (setting.type === "chords") return (value as readonly string[]).map((chord) => chordLabel(chord, mac)).join(", ") || "no key";
  if (setting.type === "list") return (value as readonly string[]).join(", ") || "none";
  if (setting.type === "string" && setting.remembered && !value) return "none";
  return value === "" ? "empty" : String(value);
};

interface RowProps {
  declared: Declared;
  value: SettingValue;
  /** Whether the member's document has this key, valid or not. */
  modified: boolean;
  problems: readonly Problem[];
  mac: boolean;
  /** The workspace's folders, which a folder setting is picked from, or null while they are read. */
  folders: Folders | null;
  onSet: (value: SettingValue | undefined) => void;
}

/** One setting as a member changes it: the control its schema asks for, what it is for, its default, why a value was refused, and a way back to the default. Settings draws every setting with it, and a plugin's own page that plugin's. */
export function SettingRow({ declared: { key, setting, active }, value, modified, problems, mac, folders, onSet }: RowProps) {
  const id = useId();
  const [refused, setRefused] = useState<string | null>(null);
  // A refusal is of what was typed here: a value set since, here or anywhere else, takes its place.
  const valueKey = JSON.stringify(value);
  useEffect(() => setRefused(null), [valueKey]);
  const set = (next: unknown) => {
    const read = readSetting(setting, next);
    setRefused("reason" in read ? read.reason : null);
    if ("value" in read) onSet(read.value);
  };
  const control = { id, "aria-invalid": refused !== null || problems.some((p) => p.kind === "invalid") || undefined, "aria-describedby": `${id}-about` };

  return (
    <div className="setting" data-row data-modified={modified || undefined} data-inactive={!active || undefined}>
      <div className="setting-head">
        <label htmlFor={id}>{setting.title}</label>
        <code>{key}</code>
      </div>
      {setting.description && <p className="setting-about">{setting.description}</p>}
      <div className="setting-control">
        {setting.type === "boolean" ? (
          <input type="checkbox" {...control} checked={value as boolean} onChange={(e) => set(e.target.checked)} />
        ) : setting.type === "string" && setting.enum ? (
          <select {...control} value={value as string} onChange={(e) => set(e.target.value)}>
            {setting.enum.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : setting.type === "folder" ? (
          <select {...control} value={value as string} onChange={(e) => set(e.target.value)}>
            <option value="">{setting.defaultFolder}</option>
            {editable(folders, value as string).map((option) => (
              <option key={option.id} value={option.id}>
                {describe(setting, option.id, mac, folders)}
              </option>
            ))}
          </select>
        ) : setting.type === "list" || (setting.type === "string" && setting.remembered) ? (
          // Words chosen elsewhere, such as calendars unticked or the default calendar picked on the Calendar page: shown here, and put back with Reset.
          <output {...control}>{describe(setting, value, mac, folders)}</output>
        ) : (
          <Typed key={JSON.stringify(value)} control={control} setting={setting} value={value} onSet={set} />
        )}
        <span id={`${id}-about`} className="setting-default">
          {setting.type === "chords" && `${describe(setting, value, mac, folders)}. `}Default: {(setting.type === "number" || setting.type === "integer") && setting.follows ? `your ${setting.follows.title}` : describe(setting, setting.default, mac, folders)}
        </span>
        {modified && (
          <button type="button" className="button small" aria-label={`Reset ${setting.title}`} onClick={() => (setRefused(null), onSet(undefined))}>
            Reset
          </button>
        )}
      </div>
      {refused && <p className="error">{refused}. Nothing was changed.</p>}
      {problems.map((p, i) => (
        <p key={i} className="error">
          {p.reason}
        </p>
      ))}
    </div>
  );
}

/**
 * How a folder setting's value reads, as the server takes it: the path of a folder the member can edit,
 * or a name the setting held before it was picked from a list, as written. An id of neither is a folder
 * gone or not theirs to edit, and blank until the folders are read so it doesn't show as the id.
 */
function folderLabel(folders: Folders | null, value: string, defaultFolder: string): string {
  if (folders?.byId.get(value)?.access === "edit") return folders.pathName(value);
  if (!Id.safeParse(value).success || folders?.childrenOf(null).some((f) => nameKey(f.name) === nameKey(value))) return value;
  return folders ? `A folder that's gone or not yours to edit (${defaultFolder} is used)` : "";
}

/** The folders a folder setting may pick, by their paths, and the one it holds now when it is none of them. */
function editable(folders: Folders | null, value: string): { id: string }[] {
  const picked = folders ? [...folders.byId.values()].filter((f) => f.access === "edit").sort((a, b) => folders.pathName(a.id).localeCompare(folders.pathName(b.id))) : [];
  return value === "" || picked.some((f) => f.id === value) ? picked : [{ id: value }, ...picked];
}

/** A setting that is typed: it is set when the member presses Enter or leaves the field, not on each key. */
function Typed({ control, setting, value, onSet }: { control: object; setting: Setting; value: SettingValue; onSet: (value: unknown) => void }) {
  const written = setting.type === "chords" ? (value as readonly string[]).join(", ") : String(value);
  const [typed, setTyped] = useState(written);
  const numeric = setting.type === "number" || setting.type === "integer";
  const commit = () => {
    if (typed === written) return;
    if (setting.type === "chords") onSet(typed.split(",").map((chord) => chord.trim()).filter(Boolean));
    else onSet(numeric ? (typed.trim() === "" ? null : Number(typed)) : typed);
  };
  return (
    <input
      {...control}
      type={numeric ? "number" : "text"}
      min={numeric ? setting.minimum : undefined}
      max={numeric ? setting.maximum : undefined}
      placeholder={setting.type === "chords" ? "mod+shift+k" : undefined}
      value={typed}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

