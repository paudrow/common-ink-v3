import type { IconName } from "./icons.tsx";

interface Mode {
  id: string;
  label: string;
  icon: IconName;
  /** Shown in the folders column; the rest sit under More. */
  primary: boolean;
  /** The issue that builds it; until then the mode is a placeholder. */
  issue: number;
}

export const MODES = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", primary: true, issue: 23 },
  { id: "search", label: "Search", icon: "search", primary: true, issue: 21 },
  { id: "todos", label: "Todos", icon: "todos", primary: true, issue: 18 },
  { id: "calendar", label: "Calendar", icon: "calendar", primary: true, issue: 17 },
  { id: "contacts", label: "Contacts", icon: "contacts", primary: false, issue: 17 },
  { id: "uploads", label: "Uploads", icon: "uploads", primary: false, issue: 22 },
  { id: "history", label: "History", icon: "history", primary: false, issue: 5 },
] as const satisfies readonly Mode[];

export type ModeId = (typeof MODES)[number]["id"];

export const modePath = (id: ModeId) => `/${id}`;
