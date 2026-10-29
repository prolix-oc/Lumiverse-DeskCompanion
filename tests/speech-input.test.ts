import { describe, expect, test } from "bun:test";
import type { SpindleFrontendContext, SpindleSTTAPI, SpindleSTTStartOptions, SpindleSTTTranscript } from "lumiverse-spindle-types";
import { listTranscriptionConnections, recognizeQuestion, transcriptionProviders } from "../src/speech-input";
import { deferred, settle } from "./fixtures";

function recognition() {
  const ready = deferred<void>(); const result = deferred<SpindleSTTTranscript>();
  const calls: SpindleSTTStartOptions[] = []; let cancellations = 0;
  const api = { start(options: SpindleSTTStartOptions) {
    calls.push(options);
    return { provider: options.provider, ready: ready.promise, result: result.promise, stop: () => result.promise,
      cancel() { cancellations += 1; } };
  } } as unknown as SpindleSTTAPI;
  return { api, calls, ready, result, cancellations: () => cancellations };
}

describe("Spindle speech sessions", () => {
  test("starts synchronously with silence detection enabled and no connection ID for Whistle", async () => {
    const host = recognition(); const signal = new AbortController().signal;
    const statuses: string[] = [];
    const question = recognizeQuestion("whistle", "stale-id", signal, host.api, (status) => statuses.push(status.phase));
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]).toMatchObject({ provider: "whistle", continuous: false, interimResults: false, signal });
    expect(Object.hasOwn(host.calls[0], "connectionId")).toBe(false);
    host.calls[0].onStatus?.({ phase: "listening" }); host.ready.resolve(); await settle();
    let done = false; void question.then(() => { done = true; }); await settle(); expect(done).toBe(false);
    host.calls[0].onStatus?.({ phase: "processing" }); host.result.resolve({ text: " Hello ", provider: "whistle" });
    expect(await question).toBe("Hello"); expect(statuses).toEqual(["listening", "processing"]);
  });
  test("preserves explicit connection selection and supports Web Speech without a recorder", async () => {
    for (const provider of ["connection", "webspeech"] as const) {
      const host = recognition(); const question = recognizeQuestion(provider, "stt-a", new AbortController().signal, host.api);
      expect(host.calls[0].connectionId).toBe(provider === "connection" ? "stt-a" : undefined);
      host.ready.resolve(); host.result.resolve({ text: "Hello", provider }); expect(await question).toBe("Hello");
    }
  });
  test("cancellation releases the session promptly and suppresses late results/status", async () => {
    const host = recognition(); const controller = new AbortController(); let statuses = 0;
    const question = recognizeQuestion("whistle", "", controller.signal, host.api, () => { statuses += 1; });
    controller.abort(); await expect(question).rejects.toMatchObject({ name: "AbortError" });
    expect(host.cancellations()).toBeGreaterThan(0);
    host.calls[0].onStatus?.({ phase: "listening" });
    host.ready.resolve(); host.result.resolve({ text: "Late", provider: "whistle" }); await settle();
    expect(statuses).toBe(0);
  });
  test("handles startup/result failures and rejects empty or oversized final transcripts", async () => {
    for (const failure of ["ready", "result", "empty", "long"]) {
      const host = recognition(); const question = recognizeQuestion("whistle", "", new AbortController().signal, host.api);
      if (failure === "ready") host.ready.reject(new Error("SECRET")); else host.ready.resolve();
      if (failure === "result") host.result.reject(new Error("SECRET"));
      else host.result.resolve({ text: failure === "long" ? "x".repeat(1201) : "", provider: "whistle" });
      await expect(question).rejects.toThrow(failure === "ready" || failure === "result" ? "Whistle could not transcribe" : "No usable question");
      expect(host.cancellations()).toBeGreaterThan(0);
    }
  });
  test("invalid selection, old hosts, and pre-cancelled input never start recognition", () => {
    const host = recognition(); const controller = new AbortController(); controller.abort();
    expect(() => recognizeQuestion("whistle", "", controller.signal, host.api)).toThrow("Aborted");
    expect(() => recognizeQuestion("connection", "", new AbortController().signal, host.api)).toThrow("Choose an STT provider");
    expect(() => recognizeQuestion("whistle", "", new AbortController().signal)).toThrow("Update Lumiverse");
    expect(host.calls).toHaveLength(0);
  });
  test("discovers all host providers, including live-only Web Speech", () => {
    const providers = [{ id: "webspeech", available: true, supportsAudioTranscription: false }];
    const api = { listProviders: () => providers } as unknown as SpindleSTTAPI;
    expect(transcriptionProviders(api)).toBe(providers);
    expect(transcriptionProviders().every((provider) => !provider.available)).toBe(true);
  });
  test("lists only credential-free STT summaries and gates old connection APIs", async () => {
    const kinds: string[] = [];
    const ctx = { host: { capabilities: { "connection-kinds-v1": 1 } }, connections: { async list({ kind }: { kind: string }) {
      kinds.push(kind); return [{ id: "stt-a", kind: "stt", name: "Dictation", provider: "openai", api_key: "SECRET" }];
    } } } as unknown as SpindleFrontendContext;
    expect(await listTranscriptionConnections(ctx, new AbortController().signal)).toEqual([{ id: "stt-a", name: "Dictation", provider: "openai" }]);
    expect(kinds).toEqual(["stt"]); ctx.host.capabilities["connection-kinds-v1"] = 0;
    await expect(listTranscriptionConnections(ctx, new AbortController().signal)).rejects.toThrow("Update Lumiverse");
    expect(kinds).toHaveLength(1);
  });
});
