import { z } from "zod";

export const MAX_NOTE_LENGTH = 500_000;

export const Id = z.string().regex(/^[a-z0-9]{12}$/, "not an id");
const Revision = z.number().int().min(0);
const NoteText = z.string().max(MAX_NOTE_LENGTH);
const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\p{Cc}]*$/u, "can't contain / or control characters");

export const Op = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note.list"), folderId: Id.optional() }),
  z.object({ type: z.literal("note.create"), text: NoteText.default(""), folderId: Id.optional() }),
  z.object({ type: z.literal("note.read"), id: Id, revision: Revision.optional() }),
  z.object({
    type: z.literal("note.write"),
    id: Id,
    baseRevision: Revision,
    text: NoteText,
    /** Chosen by the writer; a write sent again with the same id is recorded once. */
    writeId: z.string().min(1).max(64).optional(),
  }),
  z.object({ type: z.literal("note.history"), id: Id }),
  z.object({ type: z.literal("note.move"), id: Id, folderId: Id }),
  z.object({ type: z.literal("folder.list") }),
  z.object({ type: z.literal("folder.create"), name: FolderName, parentId: Id.optional() }),
  z.object({ type: z.literal("folder.rename"), id: Id, name: FolderName }),
  z.object({ type: z.literal("folder.delete"), id: Id }),
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
  createdAt: number;
  updatedAt: number;
  /** Who changed the text last, or who created the note when it was never written. */
  updatedBy: Author;
  snippet: string;
  openTodos: number;
}

export interface Note extends NoteSummary {
  text: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ListedFolder extends Folder {
  /** Notes directly in this folder, not in its children. */
  noteCount: number;
}

export type Author =
  | { kind: "member"; personId: string; name: string }
  /** A connected agent, named as its member named it; `onBehalfOf` is that member. */
  | { kind: "agent"; agentId: string; name: string; onBehalfOf: string };

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
  "note.move": Note;
  "folder.list": { unsortedId: string; folders: ListedFolder[] };
  "folder.create": Folder;
  "folder.rename": Folder;
  "folder.delete": { id: string };
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
