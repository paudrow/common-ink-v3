import type { Listener } from "../core/transcripts.ts";

/** Whisper on Workers AI: the large model's turbo, which is quick and costs little a minute, and takes a prompt. */
const WHISPER = "@cf/openai/whisper-large-v3-turbo";

/** Bytes as base64, a part at a time, since a whole recording is too many arguments for one call. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** What hears recordings here: Whisper through the AI binding, or nothing where there is no binding, as on the dev server unless it was asked for. */
export function listenerOf(env: Env): Listener | undefined {
  const ai: Ai | undefined = env.AI;
  if (!ai) return undefined;
  return async (audio, prompt) => {
    const heard = await ai.run(WHISPER, { audio: base64(audio), vad_filter: true, ...(prompt ? { initial_prompt: prompt } : {}) });
    return heard.text ?? "";
  };
}
