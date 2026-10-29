import type { SpindleFrontendContext, SpindleTTSAPI } from "lumiverse-spindle-types";
import { identifier, safeLabel } from "./protocol";

export const MAX_SPEECH_CHARS = 2400;

export interface SpeechConnection {
  id: string;
  name: string;
  provider: string;
  voice: string;
}

export function speechAPI(ctx: SpindleFrontendContext): SpindleTTSAPI | undefined {
  return (ctx.host.capabilities["text-to-speech-v1"] ?? 0) >= 1 && ctx.tts ? ctx.tts : undefined;
}

export async function listSpeechConnections(ctx: SpindleFrontendContext, signal: AbortSignal): Promise<SpeechConnection[]> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if ((ctx.host.capabilities["connection-kinds-v1"] ?? 0) < 1 || !ctx.connections) throw new Error("Update Lumiverse to list speech connections through Spindle.");
  const rows = await ctx.connections.list({ kind: "tts" });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return rows.filter((entry) => entry.kind === "tts" && identifier(entry.id)).slice(0, 100)
    .map((entry) => ({ id: entry.id, name: safeLabel(entry.name), provider: safeLabel(entry.provider), voice: (entry.voice ?? "").slice(0, 256) }));
}

export async function speakReply(text: string, connectionId: string, signal: AbortSignal, api?: SpindleTTSAPI,
  onSpeaking?: (speaking: boolean) => void): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (!text.trim() || text.length > MAX_SPEECH_CHARS || !identifier(connectionId)) {
    throw new Error("Speech requires a valid connection and a reply of at most 2,400 characters.");
  }
  if (!api) throw new Error("Update Lumiverse to use speech playback through Spindle.");
  const cancel = () => { try { api.stop(); } catch {} };
  const unsubscribe = api.subscribe((speaking) => { if (!signal.aborted) onSpeaking?.(speaking); });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await api.speak({ text }, { connectionId });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  } catch (error) {
    if (signal.aborted || error instanceof Error && error.name === "AbortError") throw new DOMException("Aborted", "AbortError");
    throw new Error("Speech could not play. Check Media permission, enable TTS in Voice & Speech, and check the selected connection.");
  } finally {
    signal.removeEventListener("abort", cancel);
    unsubscribe();
  }
}
