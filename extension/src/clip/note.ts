import { notePath } from "../../../src/core/slug.ts";

export function noteUrl(host: string, note: { id: string; slug: string }): string {
  return `${new URL(host).origin}${notePath(note)}`;
}
