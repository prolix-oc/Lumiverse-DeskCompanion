import { MAX_QUESTION } from "./protocol";
import type { VoiceRef } from "./protocol";
export async function prepareShareQuestion(question: string, spoken: Promise<string>, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (question.length > MAX_QUESTION) throw new Error("The written question exceeds 1,200 characters.");
  const transcript = await spoken;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const combined = [question.trim(), transcript.trim()].filter(Boolean).join("\n\n");
  if (combined.length > MAX_QUESTION) throw new Error("The combined written and spoken question exceeds 1,200 characters.");
  return combined;
}

export class AutomaticShareSpeech {
  private pending: { requestId: string; voice: VoiceRef } | null = null;

  arm(requestId: string, voice: VoiceRef | null): void {
    this.pending = voice ? { requestId, voice: { ...voice } } : null;
  }

  take(requestId: string): VoiceRef | null {
    if (this.pending?.requestId !== requestId) return null;
    const voice = this.pending.voice;
    this.pending = null;
    return voice;
  }

  cancel(): void { this.pending = null; }
}
