import type { SpindleFrontendContext, SpindleSTTAPI, SpindleSTTProvider, SpindleSTTProviderOption, SpindleSTTSession, SpindleSTTStatus } from "lumiverse-spindle-types";
import { identifier, MAX_QUESTION, record, safeLabel } from "./protocol";

export interface TranscriptionConnection { id: string; name: string; provider: string }
export type TranscriptionProvider = SpindleSTTProvider;
const aborted = () => new DOMException("Aborted", "AbortError");

export function speechInputAPI(ctx: SpindleFrontendContext): SpindleSTTAPI | undefined {
  return (ctx.host.capabilities["speech-to-text-v1"] ?? 0) >= 1 && ctx.stt
    && typeof ctx.stt.listProviders === "function" && typeof ctx.stt.start === "function" ? ctx.stt : undefined;
}

export function transcriptionProviders(api?: SpindleSTTAPI): SpindleSTTProviderOption[] {
  if (!api) return ["whistle", "connection", "webspeech"].map((id) => ({
    id: id as TranscriptionProvider, name: id === "whistle" ? "Whistle (on this device)" : id === "webspeech" ? "Web Speech" : "STT connection",
    onDevice: id === "whistle", available: false, unavailableReason: "hostUpdate", supportsAudioTranscription: false,
  }));
  return api.listProviders();
}

export async function listTranscriptionConnections(ctx: SpindleFrontendContext, signal: AbortSignal): Promise<TranscriptionConnection[]> {
  if (signal.aborted) throw aborted();
  if ((ctx.host.capabilities["connection-kinds-v1"] ?? 0) < 1 || !ctx.connections) throw new Error("Update Lumiverse to list STT connections through Spindle.");
  const rows = await ctx.connections.list({ kind: "stt" });
  if (signal.aborted) throw aborted();
  return rows.filter((entry) => entry.kind === "stt" && identifier(entry.id)).slice(0, 100)
    .map((entry) => ({ id: entry.id, name: safeLabel(entry.name), provider: safeLabel(entry.provider) }));
}

function recognitionError(error: unknown, provider: TranscriptionProvider, signal: AbortSignal): Error {
  if (signal.aborted || error instanceof Error && error.name === "AbortError") return aborted();
  if (error instanceof Error && error.message.startsWith("PERMISSION_DENIED")) return new Error("Grant the extension's Media permission before using voice input.");
  if (error instanceof Error && error.name === "NotAllowedError") return new Error("Microphone access was declined or is unavailable in this window.");
  return new Error(provider === "whistle" ? "Whistle could not transcribe your question. Check its availability in Voice & Speech settings."
    : "Speech recognition could not finish. Check microphone access and the selected provider in Voice & Speech settings.");
}

/** Starts synchronously so a button action preserves the host's microphone user gesture. */
export function recognizeQuestion(provider: TranscriptionProvider, connectionId: string, signal: AbortSignal,
  api?: SpindleSTTAPI, onStatus?: (status: SpindleSTTStatus) => void): Promise<string> {
  if (signal.aborted) throw aborted();
  if (!["whistle", "connection", "webspeech"].includes(provider) || provider === "connection" && !identifier(connectionId)) throw new Error("Choose an STT provider and, when required, an STT connection.");
  if (!api) throw new Error("Update Lumiverse to use voice input through Spindle.");
  let session: SpindleSTTSession;
  try {
    session = api.start({ provider, signal, continuous: false, interimResults: false,
      onStatus: (status) => { if (!signal.aborted) onStatus?.(status); },
      ...(provider === "connection" ? { connectionId } : {}) });
  } catch (error) { throw recognitionError(error, provider, signal); }
  return finishQuestion(session, provider, signal);
}

async function finishQuestion(session: SpindleSTTSession, provider: TranscriptionProvider, signal: AbortSignal): Promise<string> {
  let cancelled = false;
  const cancelSession = () => {
    if (cancelled) return;
    cancelled = true;
    try { session.cancel(); } catch {}
  };
  const cancel = () => { cancelSession(); rejectCancellation(aborted()); };
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const completed = Promise.all([session.ready, session.result]);
    if (signal.aborted) cancel();
    const [, transcript] = await Promise.race([completed, cancellation]);
    if (signal.aborted) throw aborted();
    if (!record(transcript) || typeof transcript.text !== "string" || !transcript.text.trim() || transcript.text.length > MAX_QUESTION) {
      throw new Error("No usable question was recognized, or it exceeded 1,200 characters. Try a shorter voice input.");
    }
    return transcript.text.trim();
  } catch (error) {
    cancelSession();
    if (error instanceof Error && error.message.startsWith("No usable question")) throw error;
    throw recognitionError(error, provider, signal);
  } finally { signal.removeEventListener("abort", cancel); }
}
