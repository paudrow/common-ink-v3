import { useId, useState } from "react";
import { chordLabel } from "./keybindings.ts";
import type { Setting, SettingValue } from "./plugin-api.ts";
import { readSetting, type Declared, type Problem } from "./settings.ts";

const describe = (setting: Setting, value: SettingValue, mac: boolean) => {
  if (setting.type === "boolean") return value ? "on" : "off";
  if (setting.type === "chords") return (value as readonly string[]).map((chord) => chordLabel(chord, mac)).join(", ") || "no key";
  if (setting.type === "list") return (value as readonly string[]).join(", ") || "none";
  return String(value);
};

interface RowProps {
  declared: Declared;
  value: SettingValue;
  /** Whether the member's document has this key, valid or not. */
  modified: boolean;
  problems: readonly Problem[];
  mac: boolean;
  onSet: (value: SettingValue | undefined) => void;
}

/** One setting as a member changes it: the control its schema asks for, what it is for, its default, why a value was refused, and a way back to the default. Settings draws every setting with it, and a plugin's own page that plugin's. */
export function SettingRow({ declared: { key, setting, active }, value, modified, problems, mac, onSet }: RowProps) {
  const id = useId();
  const [refused, setRefused] = useState<string | null>(null);
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
        ) : setting.type === "list" ? (
          // Words chosen elsewhere, such as calendars unticked on the Calendar page: shown here, and put back with Reset.
          <output {...control}>{describe(setting, value, mac)}</output>
        ) : (
          <Typed key={JSON.stringify(value)} control={control} setting={setting} value={value} onSet={set} />
        )}
        <span id={`${id}-about`} className="setting-default">
          {setting.type === "chords" && `${describe(setting, value, mac)}. `}Default: {describe(setting, setting.default, mac)}
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

