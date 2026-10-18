import { filterFolders } from "./clip/folders.ts";
import { blockImages, excerpt } from "./clip/render.ts";
import type { ExtensionState } from "./store.ts";

const root = document.querySelector("main");
if (!root) throw new Error("missing root");

let state: ExtensionState | null = null;

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "session" || area === "local") void refresh();
});

void send({ type: "wake" });

async function refresh(): Promise<void> {
  const next = (await chrome.runtime.sendMessage({ type: "status" })) as ExtensionState;
  if (next?.auth) {
    state = next;
    paint();
  }
}

async function send(message: unknown): Promise<void> {
  const next = (await chrome.runtime.sendMessage(message)) as ExtensionState;
  if (next?.auth) {
    state = next;
    paint();
  }
}

function paint(): void {
  if (!state) return;
  const focus = document.activeElement instanceof HTMLInputElement ? document.activeElement.id : "";
  const caret = document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null;
  root!.replaceChildren(view(state));
  const input = focus ? document.getElementById(focus) : null;
  if (input instanceof HTMLInputElement) {
    input.focus();
    if (caret != null) input.setSelectionRange(caret, caret);
  }
}

function view(current: ExtensionState): HTMLElement {
  const wrap = el("div");
  wrap.append(el("h1", "Common Ink"));
  if (current.notice) wrap.append(el("p", current.notice, "notice"));
  if (current.auth.status !== "ready") {
    wrap.append(connect(current));
    if (current.session.status === "review" || current.session.status === "failed") wrap.append(el("p", "The clip is waiting. Sign in, then choose a folder.", "muted"));
    if (current.session.status === "saved") wrap.append(saved(current));
    return wrap;
  }
  const who = current.auth.personName ? `Signed in as ${current.auth.personName}` : "Signed in";
  wrap.append(el("p", current.auth.readOnly ? `${who}. This account can only read.` : who, "muted"));
  const disconnect = el("button", "Sign out", "quiet") as HTMLButtonElement;
  disconnect.type = "button";
  disconnect.addEventListener("click", () => void send({ type: "disconnect" }));
  wrap.append(disconnect);
  if (current.session.status === "clipping") {
    wrap.append(el("p", "Clipping…"));
    return wrap;
  }
  if (current.session.status === "saved") {
    wrap.append(saved(current));
    return wrap;
  }
  if (current.session.status === "review" || current.session.status === "failed" || current.session.status === "saving") {
    wrap.append(editor(current));
    return wrap;
  }
  wrap.append(idle());
  return wrap;
}

function connect(current: ExtensionState): HTMLElement {
  const form = el("div");
  form.append(el("p", "Sign in and allow the clipper to save notes as you.", "muted"));
  const host = field("host", "Host", current.auth.host);
  form.append(host.label, host.input);
  const row = el("div", "", "row");
  const button = el("button", "Sign in") as HTMLButtonElement;
  button.addEventListener("click", () => void send({ type: "signIn", host: host.input.value }));
  row.append(button);
  form.append(row);
  const paste = document.createElement("details");
  paste.className = "paste";
  const summary = document.createElement("summary");
  summary.textContent = "Paste a token";
  const token = field("token", "Token", "", "password");
  token.input.placeholder = "cink_…";
  const tokenRow = el("div", "", "row");
  const use = el("button", "Use token", "quiet") as HTMLButtonElement;
  use.addEventListener("click", () => void send({ type: "connect", host: host.input.value, token: token.input.value }));
  tokenRow.append(use);
  paste.append(summary, token.label, token.input, tokenRow);
  form.append(paste);
  return form;
}

function idle(): HTMLElement {
  const block = el("div");
  block.append(el("p", "Clip the page you are reading, or the selection.", "muted"));
  const row = el("div", "", "row");
  const page = el("button", "Clip page") as HTMLButtonElement;
  const selection = el("button", "Clip selection", "quiet") as HTMLButtonElement;
  page.addEventListener("click", () => void send({ type: "capture", mode: "page" }));
  selection.addEventListener("click", () => void send({ type: "capture", mode: "selection" }));
  row.append(page, selection);
  block.append(row);
  return block;
}

function editor(current: ExtensionState): HTMLElement {
  const session = current.session;
  if (session.status !== "review" && session.status !== "failed" && session.status !== "saving") return el("div");
  const saving = session.status === "saving";
  const block = el("div");
  if (session.status === "failed") block.append(el("p", session.message, "notice"));
  const title = field("title", "Title", session.draft.title);
  title.input.disabled = saving;
  title.input.addEventListener("input", () => void send({ type: "setDraft", patch: { title: title.input.value } }));
  block.append(title.label, title.input);
  if (current.auth.workspaces.length > 1) {
    const label = el("label", "Workspace") as HTMLLabelElement;
    label.htmlFor = "workspace";
    const select = document.createElement("select");
    select.id = "workspace";
    select.disabled = saving;
    for (const workspace of current.auth.workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = workspace.name;
      option.selected = workspace.id === session.draft.workspaceId;
      select.append(option);
    }
    select.addEventListener("change", () => void send({ type: "setDraft", patch: { workspaceId: select.value } }));
    block.append(label, select);
  }
  block.append(folderSelect(current, saving));
  if (session.clip.file && session.status !== "saving") block.append(el("p", `Saves the file ${session.clip.file.name}.`, "muted"));
  else if (session.status !== "saving") block.append(el("p", excerpt(session.clip, 180), "excerpt"));
  const images = session.status === "saving" ? 0 : countImages(session);
  if (images) block.append(el("p", images === 1 ? "1 image will be saved with the note." : `${images} images will be saved with the note.`, "muted"));
  const row = el("div", "", "row");
  const save = el("button", saving ? "Saving…" : "Save") as HTMLButtonElement;
  save.disabled = saving || current.auth.readOnly || !session.draft.folderId;
  save.addEventListener("click", () => void send({ type: "save" }));
  const dismiss = el("button", "Dismiss", "quiet") as HTMLButtonElement;
  dismiss.disabled = saving;
  dismiss.addEventListener("click", () => void send({ type: "dismiss" }));
  row.append(save, dismiss);
  block.append(row);
  return block;
}

function folderSelect(current: ExtensionState, saving: boolean): HTMLElement {
  const wrap = el("div");
  const session = current.session;
  if (session.status !== "review" && session.status !== "failed" && session.status !== "saving") return wrap;
  const label = el("label", "Folder") as HTMLLabelElement;
  label.htmlFor = "folder";
  const select = document.createElement("select");
  select.id = "folder";
  select.disabled = saving || current.folders.status !== "ready";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = current.folders.status === "loading" ? "Loading folders…" : current.folders.status === "error" ? "Could not load folders" : "Choose a folder";
  select.append(placeholder);
  if (current.folders.status === "ready") {
    for (const folder of filterFolders(current.folders.list, "")) {
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = folder.path;
      option.selected = folder.id === session.draft.folderId;
      select.append(option);
    }
  }
  if (session.draft.folderId) select.value = session.draft.folderId;
  select.addEventListener("change", () => void send({ type: "setDraft", patch: { folderId: select.value || null } }));
  wrap.append(label, select);
  if (current.folders.status === "error") wrap.append(el("p", current.folders.message, "notice"));
  return wrap;
}

function saved(current: ExtensionState): HTMLElement {
  if (current.session.status !== "saved") return el("div");
  const block = el("div");
  block.append(el("p", "Saved."));
  const link = document.createElement("a");
  link.href = current.session.note.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = current.session.note.title || "Open note";
  block.append(link);
  const missed = current.session.missed.length;
  if (missed) block.append(el("p", missed === 1 ? "1 image was kept as a link." : `${missed} images were kept as links.`, "muted"));
  const again = el("button", "Clip another", "quiet") as HTMLButtonElement;
  again.addEventListener("click", () => void send({ type: "dismiss" }));
  const row = el("div", "", "row");
  row.append(again);
  block.append(row);
  return block;
}

function countImages(session: Extract<ExtensionState["session"], { status: "review" | "failed" }>): number {
  return blockImages(session.clip).filter((image) => image.source.kind !== "skip").length;
}

function field(id: string, name: string, value: string, type = "text"): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = el("label", name) as HTMLLabelElement;
  label.htmlFor = id;
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.value = value;
  return { label, input };
}

function el(tag: string, text = "", className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
