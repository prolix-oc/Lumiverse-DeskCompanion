import { identifier, record, safeLabel } from "./protocol";
import type { VoiceRef } from "./protocol";

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_SPEECH_CHARS = 2400;

export interface SpeechConnection {
  id: string;
  name: string;
  provider: string;
  voice: string;
}

export async function boundedBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) {
    await response.body?.cancel().catch(() => {});
    throw new DOMException("Aborted", "AbortError");
  }
  if (Number(response.headers.get("content-length")) > maximum || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Response exceeds the demo's memory limit.");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error("Response exceeds the demo's memory limit.");
      chunks.push(next.value);
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => {});
  if (response.status === 401) throw new Error("Sign in to Lumiverse in this widget before using speech.");
  if (response.status === 403) throw new Error("This account cannot access the selected TTS connection.");
  throw new Error("The TTS request failed. Check the selected connection in Voice settings.");
}

export async function listSpeechConnections(signal: AbortSignal, request: typeof fetch = fetch): Promise<SpeechConnection[]> {
  const response = await request("/api/v1/tts-connections?limit=100&offset=0", { credentials: "same-origin", redirect: "error", signal });
  await checkResponse(response);
  const data: unknown = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1024 * 1024, signal)));
  if (!record(data) || !Array.isArray(data.data)) throw new Error("Unexpected TTS connection response.");
  return data.data.filter((entry): entry is Record<string, unknown> => record(entry) && identifier(entry.id)
    && typeof entry.name === "string" && typeof entry.provider === "string" && typeof entry.voice === "string")
    .slice(0, 100).map((entry) => ({ id: String(entry.id), name: safeLabel(String(entry.name)),
      provider: safeLabel(String(entry.provider)), voice: String(entry.voice).slice(0, 256) }));
}

export async function synthesizeReply(text: string, voice: VoiceRef, signal: AbortSignal, request: typeof fetch = fetch): Promise<Blob> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (!text.trim() || text.length > MAX_SPEECH_CHARS || !identifier(voice.connectionId)
    || voice.voice.length > 256 || (voice.speed !== undefined && (!Number.isFinite(voice.speed) || voice.speed < 0.25 || voice.speed > 4))) {
    throw new Error("Speech requires a valid connection and a reply of at most 2,400 characters.");
  }
  const response = await request("/api/v1/tts/synthesize", { method: "POST", credentials: "same-origin", redirect: "error", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: voice.connectionId, text,
      voice: voice.voice || undefined, ...(voice.speed === undefined ? {} : { parameters: { speed: voice.speed } }) }) });
  await checkResponse(response);
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!mime.startsWith("audio/")) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The TTS provider did not return playable audio.");
  }
  const bytes = await boundedBytes(response, MAX_AUDIO_BYTES, signal);
  if (!bytes.length) throw new Error("The TTS provider returned no audio.");
  return new Blob([bytes], { type: mime });
}
