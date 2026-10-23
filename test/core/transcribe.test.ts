import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { NO_LISTENER, promptOf, type Listener } from "../../src/core/transcripts.ts";
import type { Files } from "../../src/core/uploads.ts";
import { addMember, newMember } from "./members.ts";
import { PNG, upload } from "./uploading.ts";

const refusal = async (work: Promise<unknown>) => work.then(() => "done", (err: { code: string; message: string }) => `${err.code}: ${err.message}`);

/** A second of silence as 8-bit PCM in a WAV, and `extra` bytes of it more. */
function wav(extra = 0): Uint8Array {
  const data = 8000 + extra;
  const bytes = new Uint8Array(44 + data).fill(128);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((ch, i) => (bytes[at + i] = ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  return bytes;
}

/** A listener that says `said` and keeps what it was handed. */
function hearing(said: string) {
  const heard: { bytes: number; prompt: string | undefined }[] = [];
  const listen: Listener = async (audio, prompt) => (heard.push({ bytes: audio.byteLength, prompt }), said);
  return { heard, files: { bucket: env.FILES, listen } satisfies Files };
}

const transcribe = (actor: Actor, id: string, files: Files) => perform(env.DB, actor, { type: "upload.transcribe", id }, Date.now(), undefined, files);

describe("the vocabulary recordings are transcribed with", () => {
  it("is Whisper's prompt: each word once, in the order written, whether on lines or between commas", () => {
    expect(promptOf("Common Ink\njj, Audrow\n\n  jj  ,Cloudflare\n")).toBe("Common Ink, jj, Audrow, Cloudflare.");
    expect(promptOf(" \n , ")).toBeUndefined();
  });

  it("is the workspace's: empty until written, written by an admin or an editor, read by every member and by no guest or agent", async () => {
    const ada = await newMember();
    const editor = await addMember(ada, "editor", "Ed");
    const viewer = await addMember(ada, "viewer", "Vera");
    expect(await perform(env.DB, ada, { type: "vocabulary.read" })).toEqual({ words: "" });
    expect(await perform(env.DB, editor, { type: "vocabulary.write", words: "Common Ink\njj" })).toEqual({ words: "Common Ink\njj" });
    expect(await perform(env.DB, viewer, { type: "vocabulary.read" })).toEqual({ words: "Common Ink\njj" });
    expect(await refusal(perform(env.DB, viewer, { type: "vocabulary.write", words: "mine" }))).toMatch(/^forbidden: /);
    const { agent } = await connectAgent(env.DB, ada.personId, "Helper");
    expect(await refusal(perform(env.DB, { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId }, { type: "vocabulary.read" }))).toBe("forbidden: An agent can't vocabulary.read");
    expect(await refusal(perform(env.DB, ada, { type: "vocabulary.write", words: "x".repeat(601) }))).toMatch(/^invalid: /);
    expect((await perform(env.DB, ada, { type: "vocabulary.read" })).words).toBe("Common Ink\njj");
  });
});

describe("transcribing a recording", () => {
  it("hands Whisper the recording's bytes with the workspace's vocabulary, and answers what it heard, trimmed", async () => {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "vocabulary.write", words: "Common Ink\njj" });
    const clip = await upload(ada, "standup.wav", wav());
    const { heard, files } = hearing("  We shipped Common Ink with jj.\n");
    expect(await transcribe(ada, clip.id, files)).toEqual({ text: "We shipped Common Ink with jj." });
    expect(heard).toEqual([{ bytes: 8044, prompt: "Common Ink, jj." }]);
  });

  it("tells Whisper no prompt for a workspace with no vocabulary", async () => {
    const ada = await newMember();
    const clip = await upload(ada, "quiet.wav", wav());
    const { heard, files } = hearing("");
    expect(await transcribe(ada, clip.id, files)).toEqual({ text: "" });
    expect(heard).toEqual([{ bytes: 8044, prompt: undefined }]);
  });

  it("is refused for what isn't a recording, for one too long to pay for, and for one in Trash, before Whisper is asked", async () => {
    const ada = await newMember();
    const { heard, files } = hearing("never");
    const picture = await upload(ada, "dot.png", PNG);
    expect(await refusal(transcribe(ada, picture.id, files))).toBe("invalid: dot.png isn't a recording, so it can't be transcribed");
    const long = await upload(ada, "long.wav", wav(8 * 1024 * 1024));
    expect(await refusal(transcribe(ada, long.id, files))).toBe("invalid: long.wav is too long to transcribe: a recording can be at most 8 MB");
    const trashed = await upload(ada, "gone.wav", wav());
    await perform(env.DB, ada, { type: "upload.trash", id: trashed.id });
    expect(await refusal(transcribe(ada, trashed.id, files))).toBe("conflict: This upload is in Trash. Restore it to change it.");
    expect(heard).toEqual([]);
  });

  it("is for someone who can change something, in the app: not a viewer, and not an agent", async () => {
    const ada = await newMember();
    const viewer = await addMember(ada, "viewer", "Vera");
    const clip = await upload(ada, "standup.wav", wav());
    const { files } = hearing("words");
    expect(await refusal(transcribe(viewer, clip.id, files))).toMatch(/^forbidden: /);
    const { agent } = await connectAgent(env.DB, ada.personId, "Helper");
    expect(await refusal(transcribe({ kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId }, clip.id, files))).toBe("forbidden: An agent can't upload.transcribe");
  });

  it("says how to turn it on where there is no Workers AI, and that it couldn't be done when Whisper fails", async () => {
    const ada = await newMember();
    const clip = await upload(ada, "standup.wav", wav());
    expect(await refusal(transcribe(ada, clip.id, { bucket: env.FILES }))).toBe(`unavailable: ${NO_LISTENER}`);
    const failing: Listener = () => Promise.reject(new Error("3040: capacity"));
    expect(await refusal(transcribe(ada, clip.id, { bucket: env.FILES, listen: failing }))).toBe("unavailable: standup.wav couldn't be transcribed just now. Try again in a moment.");
  });
});
