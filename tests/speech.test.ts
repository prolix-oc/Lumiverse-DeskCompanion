import { describe, expect, test } from "bun:test";
import type { SpindleFrontendContext, SpindleTTSAPI } from "lumiverse-spindle-types";
import { MAX_SPEECH_CHARS, listSpeechConnections, speakReply } from "../src/speech";
import { deferred, settle } from "./fixtures";

describe("Spindle TTS playback", () => {
  test("speaks text through the host with the selected connection", async () => {
    const calls: unknown[] = []; let removed = 0;
    const api = { async speak(input: unknown, options: unknown) { calls.push({ input, options }); },
      subscribe: () => () => { removed += 1; } } as unknown as SpindleTTSAPI;
    await speakReply("Hello from Mira.", "voice-a", new AbortController().signal, api);
    expect(calls).toEqual([{ input: { text: "Hello from Mira." }, options: { connectionId: "voice-a" } }]);
    expect(removed).toBe(1);
  });
  test("projects credential-free TTS summaries and gates old hosts", async () => {
    const kinds: string[] = [];
    const ctx = { host: { capabilities: { "connection-kinds-v1": 1 } }, connections: { async list({ kind }: { kind: string }) {
      kinds.push(kind); return [{ id: "voice-a", kind: "tts", name: "My voice", provider: "google", voice: "warm", api_key: "SECRET" }];
    } } } as unknown as SpindleFrontendContext;
    expect(await listSpeechConnections(ctx, new AbortController().signal)).toEqual([{ id: "voice-a", name: "My voice", provider: "google", voice: "warm" }]);
    expect(kinds).toEqual(["tts"]);
    ctx.host.capabilities["connection-kinds-v1"] = 0;
    await expect(listSpeechConnections(ctx, new AbortController().signal)).rejects.toThrow("Update Lumiverse");
    expect(kinds).toHaveLength(1);
  });
  test("rejects invalid text and pre-cancelled actions before host playback", async () => {
    let calls = 0;
    const api = { speak: async () => { calls += 1; }, subscribe: () => () => {} } as unknown as SpindleTTSAPI;
    for (const text of ["", "x".repeat(MAX_SPEECH_CHARS + 1)]) await expect(speakReply(text, "voice-a", new AbortController().signal, api)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(speakReply("Hello", "voice-a", controller.signal, api)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
  test("cancels host playback and cleans up its subscription", async () => {
    const playback = deferred<void>(); let stopped = 0; let removed = 0;
    const api = { speak: () => playback.promise, stop() { stopped += 1; playback.resolve(); }, subscribe: () => () => { removed += 1; } } as unknown as SpindleTTSAPI;
    const controller = new AbortController();
    const result = speakReply("Hello", "voice-a", controller.signal, api); await settle(); controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(stopped).toBe(1); expect(removed).toBe(1);
  });
  test("sanitizes host failures without retrying playback", async () => {
    let calls = 0;
    const api = { speak: async () => { calls += 1; throw new Error("PRIVATE_PROVIDER_ERROR"); }, subscribe: () => () => {} } as unknown as SpindleTTSAPI;
    await expect(speakReply("Hello", "voice-a", new AbortController().signal, api)).rejects.toThrow("Speech could not play");
    expect(calls).toBe(1);
  });

  test("distinguishes actionable host failures without exposing provider messages", async () => {
    for (const [failure, expected] of [
      [new Error("PERMISSION_DENIED:media:PRIVATE_DETAILS"), "Allow Desk Companion's Media permission"],
      [new Error("TTS_CONNECTION_NOT_FOUND:PRIVATE_DETAILS"), "Choose an available TTS connection"],
      [new Error("TTS_UNAVAILABLE:connectionRequired"), "Choose an available TTS connection"],
      [new Error("TTS_UNAVAILABLE:disabled"), "independently of chat TTS"],
      [new DOMException("PRIVATE_DETAILS", "NotAllowedError"), "Audio playback was blocked"],
    ] as const) {
      const api = { speak: async () => { throw failure; }, subscribe: () => () => {} } as unknown as SpindleTTSAPI;
      let caught: unknown;
      try { await speakReply("Hello", "voice-a", new AbortController().signal, api); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(expected);
      expect((caught as Error).message).not.toContain("PRIVATE_DETAILS");
    }
  });
});
