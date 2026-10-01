import { identifier, MAX_QUESTION, record, safeLabel } from "./protocol";
import { boundedBytes } from "./speech";

export const MAX_VOICE_SECONDS = 15;
export const MAX_VOICE_BYTES = 4 * 1024 * 1024;

export interface TranscriptionConnection {
  id: string;
  name: string;
  provider: string;
}

export interface RecordedQuestion {
  audio: Blob;
  fileName: string;
}

export interface RecordingEnvironment {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  supports: (mimeType: string) => boolean;
}

function aborted(): DOMException { return new DOMException("Aborted", "AbortError"); }

export function supportsVoiceInput(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof MediaRecorder !== "undefined"
    && typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

function acquireMicrophone(signal: AbortSignal, environment: RecordingEnvironment): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const cancel = () => reject(aborted());
    signal.addEventListener("abort", cancel, { once: true });
    void Promise.resolve().then(() => environment.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true } })).then((stream) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) { for (const track of stream.getTracks()) track.stop(); reject(aborted()); }
      else resolve(stream);
    }, () => {
      signal.removeEventListener("abort", cancel);
      reject(new Error("Microphone access was declined or is unavailable in this window."));
    });
  });
}

export async function recordQuestion(seconds: number, signal: AbortSignal, environment?: RecordingEnvironment): Promise<RecordedQuestion> {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_VOICE_SECONDS) throw new Error("Voice input must be between 1 and 15 seconds.");
  if (signal.aborted) throw aborted();
  if (!environment && !supportsVoiceInput()) throw new Error("Microphone recording requires a supported, secure browser or desktop window.");
  const source = environment ?? {
    getUserMedia: (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream: MediaStream, options: MediaRecorderOptions) => new MediaRecorder(stream, options),
    supports: (mimeType: string) => MediaRecorder.isTypeSupported(mimeType),
  };
  const stream = await acquireMicrophone(signal, source);
  try {
    if (signal.aborted) throw aborted();
    const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((candidate) => source.supports(candidate));
    const recorder = source.createRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
    return await new Promise<RecordedQuestion>((resolve, reject) => {
      const chunks: Blob[] = [];
      let length = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
        try { if (recorder.state !== "inactive") recorder.stop(); } catch {}
        for (const track of stream.getTracks()) track.stop();
        if (error) { chunks.length = 0; reject(error); return; }
        const format = recorder.mimeType || mimeType || "audio/webm";
        const audio = new Blob(chunks, { type: format }); chunks.length = 0;
        if (!audio.size) { reject(new Error("The microphone recording was empty.")); return; }
        resolve({ audio, fileName: format.includes("mp4") ? "question.mp4" : format.includes("ogg") ? "question.ogg" : "question.webm" });
      };
      const cancel = () => finish(aborted());
      signal.addEventListener("abort", cancel, { once: true });
      recorder.ondataavailable = (event) => {
        if (settled) return;
        length += event.data.size;
        if (length > MAX_VOICE_BYTES) finish(new Error("Voice recording exceeds the demo's 4 MiB memory limit."));
        else if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => finish(new Error("Microphone recording failed."));
      recorder.onstop = () => finish(signal.aborted ? aborted() : undefined);
      try {
        if (signal.aborted) { cancel(); return; }
        recorder.start(250);
        if (!settled) timer = setTimeout(() => {
          try { recorder.stop(); } catch { finish(new Error("Microphone recording could not finish.")); }
          for (const track of stream.getTracks()) track.stop();
        }, seconds * 1000);
      } catch { finish(new Error("This window could not start microphone recording.")); }
    });
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => {});
  throw new Error(response.status === 401 ? "Sign in to Lumiverse before using voice input."
    : response.status === 403 ? "This account cannot access the selected STT connection." : "Transcription failed. Check the selected STT connection in Voice settings.");
}

export async function listTranscriptionConnections(signal: AbortSignal, request: typeof fetch = fetch): Promise<TranscriptionConnection[]> {
  const response = await request("/api/v1/stt-connections?limit=100&offset=0", { credentials: "same-origin", redirect: "error", signal });
  await checkResponse(response);
  const data: unknown = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1024 * 1024, signal)));
  if (!record(data) || !Array.isArray(data.data)) throw new Error("Unexpected STT connection response.");
  return data.data.filter((entry): entry is Record<string, unknown> => record(entry) && identifier(entry.id)
    && typeof entry.name === "string" && typeof entry.provider === "string").slice(0, 100)
    .map((entry) => ({ id: String(entry.id), name: safeLabel(String(entry.name)), provider: safeLabel(String(entry.provider)) }));
}

export async function transcribeQuestion(recording: RecordedQuestion, connectionId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  if (signal.aborted) throw aborted();
  if (!identifier(connectionId) || !recording.audio.size || recording.audio.size > MAX_VOICE_BYTES || !recording.audio.type.startsWith("audio/")) {
    throw new Error("Choose an STT connection and a nonempty audio recording of at most 4 MiB.");
  }
  const form = new FormData();
  form.append("audio", recording.audio, recording.fileName); form.append("connectionId", connectionId);
  const response = await request("/api/v1/stt/transcribe", { method: "POST", credentials: "same-origin", redirect: "error", signal, body: form });
  await checkResponse(response);
  const bytes = await boundedBytes(response, 32768, signal);
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Unexpected transcription response."); }
  if (!record(data) || typeof data.text !== "string" || !data.text.trim() || data.text.length > MAX_QUESTION) {
    throw new Error("No usable question was recognized, or it exceeded 1,200 characters. Try a shorter voice input.");
  }
  return data.text.trim();
}
