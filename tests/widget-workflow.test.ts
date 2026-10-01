import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { mountView } from "../src/companion-view";
import { installCompanion } from "../src/worker";
import { deferred, fixture, settle } from "./fixtures";

async function widget(options: { stt?: Promise<Response>; tts?: Promise<Response>; autoplayBlocked?: boolean; microphoneDenied?: boolean } = {}) {
  const host = fixture();
  const approval = deferred<typeof host.capture>();
  const dom = new JSDOM("<main></main>", { url: "https://lumiverse.test/" });
  const globals = ["window", "document", "navigator", "Option", "MediaRecorder", "fetch"];
  const previous = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests: Array<{ url: string; input?: RequestInit }> = [];
  const outgoing: any[] = [];
  const events = new Map<string, (payload: unknown) => void>();
  let microphoneRequests = 0;
  let tracksStopped = 0;
  let playback = 0;
  let backendMessage: (payload: unknown) => void = () => {};
  const stream = { getTracks: () => [{ stop() { tracksStopped += 1; } }] } as unknown as MediaStream;
  class Recorder {
    state = "inactive";
    mimeType = "audio/mp4";
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    static isTypeSupported(mime: string) { return mime === "audio/mp4"; }
    start() {
      this.state = "recording";
      queueMicrotask(() => {
        if (this.state === "inactive") return;
        this.ondataavailable?.({ data: new Blob(["voice"]) } as BlobEvent);
        this.stop();
      });
    }
    stop() { this.state = "inactive"; this.onstop?.(); }
  }
  Object.defineProperty(dom.window, "isSecureContext", { value: true });
  Object.defineProperty(dom.window.navigator, "mediaDevices", { value: { async getUserMedia() {
    microphoneRequests += 1;
    if (options.microphoneDenied) throw new Error("Denied");
    return stream;
  } } });
  dom.window.HTMLMediaElement.prototype.play = async () => { if (options.autoplayBlocked) throw new Error("Autoplay blocked"); playback += 1; };
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  const request = (async (url: string | URL | Request, input?: RequestInit) => {
    requests.push({ url: String(url), input });
    if (String(url).startsWith("/api/v1/tts-connections")) return Response.json({ data: [{ id: "voice-a", name: "Mira's voice", provider: "google", voice: "warm" }] });
    if (String(url).startsWith("/api/v1/stt-connections")) return Response.json({ data: [{ id: "stt-a", name: "Dictation", provider: "openai" }] });
    if (url === "/api/v1/stt/transcribe") return options.stt ?? Response.json({ text: "What do you think?" });
    if (url === "/api/v1/tts/synthesize") return options.tts ?? new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } });
    throw new Error("Unexpected endpoint");
  }) as typeof fetch;
  const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Option: dom.window.Option, MediaRecorder: Recorder, fetch: request };
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  host.mutable.desktop.capture.request = async (input) => { host.requests.push(input); return approval.promise; };
  host.mutable.sendToFrontend = (payload, userId, routing) => { host.sent.push({ payload, userId, options: routing }); backendMessage(payload); };
  const uninstall = installCompanion(host.api);
  const context = { manifest: { identifier: "desk_companion" },
    permissions: { async getGranted() { return ["ui_panels", "characters", "generation", "screen_capture", "screen_recording"]; } },
    getActiveChat: () => ({ characterId: "character-a", chatId: null }),
    events: { on(name: string, callback: (payload: unknown) => void) { events.set(name, callback); return () => events.delete(name); } },
    sendToBackend(payload: unknown) { outgoing.push(payload); host.emit(payload); },
    onBackendMessage(callback: (payload: unknown) => void) { backendMessage = callback; return () => { backendMessage = () => {}; }; },
  } as unknown as SpindleFrontendContext;
  const view = mountView(context, dom.window.document.querySelector("main")!);
  await settle();
  const element = <ElementType extends HTMLElement>(role: string) => view.panel.querySelector<ElementType>(`[data-role="${role}"]`)!;
  const enable = (role: string) => { const control = element<HTMLInputElement>(role); control.checked = true; control.dispatchEvent(new dom.window.Event("input")); };
  return { host, view, outgoing, events, element, enable, requests,
    microphoneRequests: () => microphoneRequests, tracksStopped: () => tracksStopped, playback: () => playback,
    paid: (path: string) => requests.filter((entry) => entry.url === path),
    approve: async () => { approval.resolve(host.capture); await settle(); },
    message: (payload: unknown) => backendMessage(payload),
    async close() {
      view.dispose(); uninstall(); approval.resolve(host.capture); await settle(); dom.window.close();
      for (const name of globals) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe("configured widget share pipeline", () => {
  test("defaults to text-only with no microphone or paid TTS on load or share", async () => {
    const screen = await widget();
    try {
      expect(screen.element<HTMLInputElement>("auto-speak").checked).toBe(false);
      expect(screen.element<HTMLInputElement>("voice-input").checked).toBe(false);
      expect(screen.microphoneRequests()).toBe(0);
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests).toHaveLength(1); expect(screen.host.generations).toHaveLength(0);
      await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(0);
      expect(screen.microphoneRequests()).toBe(0); expect(screen.element("reply").textContent).toBe("You have a calendar open.");
    } finally { await screen.close(); }
  });
  test("one main action runs timed STT, approved capture, character generation, and TTS exactly once", async () => {
    const screen = await widget();
    try {
      screen.enable("auto-speak"); screen.enable("voice-input");
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.microphoneRequests()).toBe(1); expect(screen.tracksStopped()).toBeGreaterThan(0);
      expect(screen.paid("/api/v1/stt/transcribe")).toHaveLength(1); expect(screen.host.requests).toHaveLength(1);
      expect(screen.host.generations).toHaveLength(0); expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(0);
      expect(screen.element("input-status").textContent).toContain("What do you think?");
      expect(screen.element<HTMLInputElement>("auto-speak").disabled).toBe(true);
      await screen.approve();
      expect(screen.host.generations).toHaveLength(1);
      expect(screen.host.generations[0].messages[1].content[0].text).toBe("What do you think?");
      expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(1); expect(screen.playback()).toBe(1);
      const body = JSON.parse(String(screen.paid("/api/v1/tts/synthesize")[0].input?.body));
      expect(body).toEqual({ connectionId: "voice-a", text: "You have a calendar open.", voice: "warm", parameters: { speed: 1.1 } });
      screen.message(screen.host.sent.find((entry) => entry.payload.type === "complete")?.payload); await settle();
      expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(1);
      expect(screen.host.sent.every((entry) => entry.options?.frontendSessionId === "session-a" && entry.userId === "user-a")).toBe(true);
    } finally { await screen.close(); }
  });
  test("Stop prevents pending automatic speech without cancelling the character's text", async () => {
    const screen = await widget();
    try {
      screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle();
      screen.element<HTMLButtonElement>("stop-speech").click(); await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(0);
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
    } finally { await screen.close(); }
  });
  test("cancelled STT cannot open screen consent, dispatch generation, or speak a late reply", async () => {
    const transcription = deferred<Response>(); const screen = await widget({ stt: transcription.promise });
    try {
      screen.enable("voice-input"); screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.paid("/api/v1/stt/transcribe")).toHaveLength(1);
      screen.element<HTMLButtonElement>("cancel").click();
      expect(screen.paid("/api/v1/stt/transcribe")[0].input?.signal?.aborted).toBe(true);
      transcription.resolve(Response.json({ text: "Too late" })); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0); expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(0);
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
    } finally { transcription.resolve(Response.json({ text: "Too late" })); await screen.close(); }
  });
  test("microphone denial stops before screen capture rather than silently running a different request", async () => {
    const screen = await widget({ microphoneDenied: true });
    try {
      screen.enable("voice-input"); screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
      expect(screen.element("status").textContent).toContain("Microphone access was declined");
    } finally { await screen.close(); }
  });
  test("autoplay denial keeps audio controls available without retrying synthesis", async () => {
    const screen = await widget({ autoplayBlocked: true });
    try {
      screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(1); expect(screen.element<HTMLAudioElement>("audio").hidden).toBe(false);
      expect(screen.element<HTMLDetailsElement>("speech-options").open).toBe(true);
      expect(screen.element("speech-status").textContent).toContain("requires pressing Play");
    } finally { await screen.close(); }
  });
  test("TTS failure retains generated text without restarting generation", async () => {
    const screen = await widget({ tts: Promise.resolve(new Response("PRIVATE_PROVIDER_ERROR", { status: 502 })) });
    try {
      screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.paid("/api/v1/tts/synthesize")).toHaveLength(1);
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
      expect(screen.element("speech-status").textContent).not.toContain("PRIVATE_PROVIDER_ERROR");
    } finally { await screen.close(); }
  });
  test("Clear aborts pending auto-TTS and discards late audio", async () => {
    const synthesis = deferred<Response>(); const screen = await widget({ tts: synthesis.promise });
    try {
      screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      screen.element<HTMLButtonElement>("clear").click();
      expect(screen.paid("/api/v1/tts/synthesize")[0].input?.signal?.aborted).toBe(true);
      synthesis.resolve(new Response("audio", { headers: { "Content-Type": "audio/wav" } })); await settle();
      expect(screen.playback()).toBe(0); expect(screen.element<HTMLAudioElement>("audio").hidden).toBe(true);
      expect(screen.element<HTMLAudioElement>("audio").hasAttribute("src")).toBe(false);
    } finally { synthesis.resolve(new Response()); await screen.close(); }
  });
});
