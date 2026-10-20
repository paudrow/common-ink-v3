import { extractArticle } from "./extract.ts";

export function articleFromDocument(doc: Document, pageUrl = doc.URL): { title: string; html: string } | null {
  return extractArticle(doc, pageUrl || "");
}
