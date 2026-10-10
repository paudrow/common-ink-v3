import { z } from "zod";

export const MAX_NOTE_LENGTH = 500_000;

export const Id = z.string().regex(/^[a-z0-9]{12}$/, "not an id");
const Revision = z.number().int().min(0);
const NoteText = z.string().max(MAX_NOTE_LENGTH);

export const Op = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note.list") }),
  z.object({ type: z.literal("note.create"), text: NoteText.default("") }),
  z.object({ type: z.literal("note.read"), id: Id, revision: Revision.optional() }),
  z.object({ type: z.literal("note.write"), id: Id, baseRevision: Revision, text: NoteText }),
  z.object({ type: z.literal("note.history"), id: Id }),
]);
export type Op = z.output<typeof Op>;
export type OpInput = z.input<typeof Op>;
export type OpType = Op["type"];

export type Role = "admin" | "editor" | "viewer";

export interface NoteSummary {
  id: string;
  title: string;
  slug: string;
  folderId: string;
  revision: number;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  text: string;
}

export type Author = { kind: "member"; personId: string; name: string };

export interface ChangeEntry {
  revision: number;
  baseRevision: number;
  author: Author;
  createdAt: number;
}

export interface Results {
  "note.list": NoteSummary[];
  "note.create": Note;
  "note.read": Note;
  "note.write": Note;
  "note.history": ChangeEntry[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  person: { id: string; email: string; name: string };
  workspaces: WorkspaceSummary[];
}

export type OpErrorCode = "invalid" | "not_found" | "forbidden";

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}
