export type ClipMode = "page" | "selection" | "link" | "image" | "element";

export type Day = string;

export interface ClipSource {
  pageTitle: string;
  pageUrl: string;
  clippedOn: Day;
}

export interface HtmlTree {
  tag: string;
  attrs: Readonly<Record<string, string>>;
  children: readonly HtmlTree[];
  text: string;
}

export interface Capture {
  mode: ClipMode;
  title: string;
  source: ClipSource;
  tree: HtmlTree;
}

export type Inline =
  | { type: "text"; text: string }
  | { type: "link"; href: string; inlines: readonly Inline[] }
  | { type: "code"; text: string }
  | { type: "strong"; inlines: readonly Inline[] }
  | { type: "em"; inlines: readonly Inline[] }
  | { type: "strike"; inlines: readonly Inline[] };

export interface ListItem {
  checked: boolean | null;
  blocks: readonly Block[];
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: readonly Inline[] }
  | { type: "paragraph"; inlines: readonly Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: readonly ListItem[] }
  | { type: "quote"; blocks: readonly Block[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "table"; rows: readonly (readonly (readonly Inline[])[])[] }
  | { type: "image"; image: ClipImage }
  | { type: "rule" };

export type ImageMissReason = "unfetched" | "not-image" | "too-big" | "unsafe" | "inline-too-big" | "unreadable";

export type ClipImage = {
  key: string;
  alt: string;
  width: number | null;
  height: number | null;
  source: { kind: "remote"; url: string } | { kind: "inline"; mediaType: string; base64: string } | { kind: "skip"; reason: ImageMissReason };
};

export interface ClipFile {
  name: string;
  url: string;
}

export interface Clip {
  mode: ClipMode;
  title: string;
  source: ClipSource;
  blocks: readonly Block[];
  file?: ClipFile;
}

export interface PlacedUpload {
  id: string;
  width: number | null;
  height: number | null;
}

export type PlacedMap = Readonly<Record<string, PlacedUpload>>;

export interface Miss {
  key: string;
  reason: ImageMissReason;
}

export interface Draft {
  title: string;
  workspaceId: string | null;
  folderId: string | null;
}

export interface ChosenDraft {
  title: string;
  workspaceId: string;
  folderId: string;
}

export interface SavedNote {
  id: string;
  slug: string;
  title: string;
  url: string;
}

export interface CreatedId {
  id: string;
  slug: string;
  title: string;
}
