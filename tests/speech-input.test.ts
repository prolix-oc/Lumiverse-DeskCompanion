import { describe, expect, test } from "bun:test";
import { MAX_VOICE_BYTES, listTranscriptionConnections, recordQuestion, transcribeQuestion } from "../src/speech-input";
import type { RecordingEnvironment } from "../src/speech-input";
import { deferred, settle } from "./fixtures";

function microphone() {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop() { stopped += 1; } }] } as unknown as MediaStream;
  let constraints: MediaStreamConstraints | undefined;
  let options: MediaRecorderOptions | undefined;
  const recorder = { state: "inactive", mimeType: "audio/mp4", ondataavailable: null as ((event: BlobEvent) => void) | null,
    onstop: null as (() => void) | null, onerror: null as (() => void) | null,
    start() { this.state = "recording"; }, stop() { this.state = "inactive"; this.onstop?.(); } };
  const environment: RecordingEnvironment = {
    async getUserMedia(input) { constraints = input; return stream; },
    createRecorder(_stream, input) { options = input; return recorder as unknown as MediaRecorder; },
    supports: (mime) => mime === "audio/mp4",
  };
  return { stream, environment, recorder, stopped: () => stopped, constraints: () => constraints, options: () => options,
    chunk(size = 4) { recorder.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) } as BlobEvent); } };
}

describe("bounded opt-in microphone recording", () => {
  test("records audio only in memory with a supported format and closes the microphone", async () => {
    const host = microphone(); expect(host.constraints()).toBeUndefined();
    const pending = recordQuestion(5, new AbortController().signal, host.environment); await settle();
    expect(host.constraints()).toEqual({ video: false, audio: { echoCancellation: true, noiseSuppression: true } });
    expect(host.options()).toEqual({ mimeType: "audio/mp4", audioBitsPerSecond: 64000 });
    host.chunk(); host.recorder.stop(); const result = await pending;
    expect(result.audio.size).toBe(4); expect(result.audio.type).toBe("audio/mp4"); expect(result.fileName).toBe("question.mp4");
    expect(host.stopped()).toBeGreaterThan(0);
  });
  test("automatically stops after the configured duration without another button", async () => {
    const host = microphone(); const pending = recordQuestion(1, new AbortController().signal, host.environment);
    await settle(); host.chunk(); const result = await pending;
    expect(result.audio.size).toBe(4); expect(host.recorder.state).toBe("inactive"); expect(host.stopped()).toBeGreaterThan(0);
  });
  test("rejects unbounded duration and pre-cancelled input before requesting a microphone", async () => {
    const host = microphone();
    for (const seconds of [0, 16, 1.5]) await expect(recordQuestion(seconds, new AbortController().signal, host.environment)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(recordQuestion(5, controller.signal, host.environment)).rejects.toMatchObject({ name: "AbortError" });
    expect(host.constraints()).toBeUndefined();
  });
  test("cancellation while a permission prompt is pending closes any late stream", async () => {
    const host = microphone(); const permission = deferred<MediaStream>(); const controller = new AbortController();
    host.environment.getUserMedia = async () => permission.promise;
    const recording = recordQuestion(5, controller.signal, host.environment); await settle(); controller.abort();
    await expect(recording).rejects.toMatchObject({ name: "AbortError" });
    permission.resolve(host.stream); await settle(); expect(host.stopped()).toBeGreaterThan(0);
  });
  test("cancellation and recording failures stop tracks without yielding audio", async () => {
    for (const cause of ["cancel", "size", "empty", "error", "constructor"]) {
      const host = microphone(); const controller = new AbortController();
      if (cause === "constructor") host.environment.createRecorder = () => { throw new Error("Unavailable"); };
      const recording = recordQuestion(5, controller.signal, host.environment);
      const outcome = recording.then(() => null, (error: unknown) => error); await settle();
      if (cause === "cancel") controller.abort();
      else if (cause === "size") host.chunk(MAX_VOICE_BYTES + 1);
      else if (cause === "empty") host.recorder.stop();
      else if (cause === "error") host.recorder.onerror?.();
      expect(await outcome).toBeInstanceOf(Error); expect(host.stopped()).toBeGreaterThan(0);
    }
  });
});

describe("existing authenticated STT adapter", () => {
  const recording = { audio: new Blob(["voice"], { type: "audio/webm" }), fileName: "question.webm" };
  test("uses same-origin multipart STT without API keys or capture handles", async () => {
    let received: { url: string; options?: RequestInit } | null = null;
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      received = { url: String(url), options }; return Response.json({ text: " What do you think? " });
    }) as typeof fetch;
    expect(await transcribeQuestion(recording, "stt-a", new AbortController().signal, request)).toBe("What do you think?");
    const call = received! as { url: string; options?: RequestInit };
    expect(call.url).toBe("/api/v1/stt/transcribe"); expect(call.options?.credentials).toBe("same-origin"); expect(call.options?.redirect).toBe("error");
    expect(call.options?.headers).toBeUndefined();
    const form = call.options?.body as FormData;
    expect(form.get("connectionId")).toBe("stt-a"); expect((form.get("audio") as File).size).toBe(5);
    expect((form.get("audio") as File).name).toBe("question.webm"); expect(Array.from(form.keys())).toEqual(["audio", "connectionId"]);
  });
  test("lists only safe owned connection fields", async () => {
    const request = (async () => Response.json({ data: [{ id: "stt-a", name: "Dictation", provider: "openai", api_key: "SECRET", metadata: { key: "SECRET" } }] })) as typeof fetch;
    expect(await listTranscriptionConnections(new AbortController().signal, request)).toEqual([{ id: "stt-a", name: "Dictation", provider: "openai" }]);
  });
  test("rejects invalid audio and cancelled input before a provider request", async () => {
    let calls = 0; const request = (async () => { calls += 1; return Response.json({ text: "Hello" }); }) as typeof fetch;
    const controller = new AbortController(); controller.abort();
    await expect(transcribeQuestion(recording, "stt-a", controller.signal, request)).rejects.toMatchObject({ name: "AbortError" });
    for (const audio of [new Blob(), new Blob([new Uint8Array(MAX_VOICE_BYTES + 1)], { type: "audio/webm" }), new Blob(["not audio"], { type: "text/plain" })]) {
      await expect(transcribeQuestion({ ...recording, audio }, "stt-a", new AbortController().signal, request)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  test("rejects provider errors, malformed or oversized replies without disclosing error bodies", async () => {
    for (const response of [new Response("SECRET_AUDIO", { status: 502 }), new Response("SECRET_AUDIO"),
      Response.json({ text: " " }), Response.json({ text: "x".repeat(1201) }), new Response("x".repeat(32769))]) {
      const request = (async () => response) as typeof fetch;
      try { await transcribeQuestion(recording, "stt-a", new AbortController().signal, request); throw new Error("Expected rejection"); }
      catch (error) { expect(String(error)).not.toContain("SECRET_AUDIO"); expect(String(error)).not.toContain("Expected rejection"); }
    }
  });
});
