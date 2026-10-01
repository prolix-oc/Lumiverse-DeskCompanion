import { describe, expect, test } from "bun:test";
import { MAX_SPEECH_CHARS, boundedBytes, listSpeechConnections, synthesizeReply } from "../src/speech";

describe("authenticated TTS adapter", () => {
  test("uses the existing same-origin TTS API with no tokens or capture handles", async () => {
    let captured: { url: string; options?: RequestInit } | null = null;
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
      captured = { url: String(url), options };
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } });
    }) as typeof fetch;
    const blob = await synthesizeReply("Hello from Mira.", { connectionId: "voice-a", voice: "warm", speed: 1.1 }, new AbortController().signal, request);
    const call = captured! as { url: string; options?: RequestInit };
    expect(call.url).toBe("/api/v1/tts/synthesize"); expect(call.options?.credentials).toBe("same-origin"); expect(call.options?.redirect).toBe("error");
    expect(JSON.parse(String(call.options?.body))).toEqual({ connectionId: "voice-a", text: "Hello from Mira.", voice: "warm", parameters: { speed: 1.1 } });
    expect(blob.type).toBe("audio/wav"); expect(blob.size).toBe(3);
    expect(JSON.stringify(call)).not.toContain("assetId"); expect(JSON.stringify(call)).not.toContain("Authorization");
  });
  test("projects a safe connection list without provider metadata or keys", async () => {
    const request = (async () => Response.json({ data: [{ id: "voice-a", name: "My voice", provider: "google", voice: "warm", api_key: "SECRET", metadata: { secret: "SECRET" } }] })) as typeof fetch;
    const connections = await listSpeechConnections(new AbortController().signal, request);
    expect(connections).toEqual([{ id: "voice-a", name: "My voice", provider: "google", voice: "warm" }]);
    expect(JSON.stringify(connections)).not.toContain("SECRET");
  });
  test("rejects overlong text before making a billable request", async () => {
    let calls = 0; const request = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    await expect(synthesizeReply("x".repeat(MAX_SPEECH_CHARS + 1), { connectionId: "voice-a", voice: "" }, new AbortController().signal, request)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("does not render provider error bodies and rejects non-audio responses", async () => {
    for (const response of [new Response("SECRET", { status: 502 }), new Response("<script>evil</script>", { headers: { "Content-Type": "text/html" } })]) {
      const request = (async () => response) as typeof fetch;
      try { await synthesizeReply("Hello", { connectionId: "voice-a", voice: "" }, new AbortController().signal, request); throw new Error("expected failure"); }
      catch (error) { expect(String(error)).not.toContain("SECRET"); expect(String(error)).not.toContain("evil"); }
    }
  });
  test("enforces advertised and streamed byte bounds", async () => {
    await expect(boundedBytes(new Response("12345", { headers: { "Content-Length": "5" } }), 4, new AbortController().signal)).rejects.toThrow();
    await expect(boundedBytes(new Response("12345"), 4, new AbortController().signal)).rejects.toThrow();
    expect(await boundedBytes(new Response("1234"), 4, new AbortController().signal)).toEqual(new TextEncoder().encode("1234"));
  });
  test("cancelled speech does not expose an audio buffer", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(boundedBytes(new Response("123"), 4, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  test("cancels advertised oversized response bodies before reading them", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(boundedBytes(new Response(body, { headers: { "Content-Length": "5" } }), 4, new AbortController().signal)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  test("aborting a pending reader cancels the underlying stream", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const reading = boundedBytes(new Response(body), 4, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
  test("a pre-cancelled speech action never makes a provider request", async () => {
    let calls = 0;
    const controller = new AbortController(); controller.abort();
    const request = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    await expect(synthesizeReply("Hello", { connectionId: "voice-a", voice: "" }, controller.signal, request)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});
