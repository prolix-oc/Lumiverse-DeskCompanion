import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { SpindleFrontendContext, SpindleSTTProviderOption, SpindleSTTStartOptions } from "lumiverse-spindle-types";
import { mountView } from "../src/companion-view";
import { installCompanion } from "../src/worker";
import { CHARACTER, deferred, fixture, settle } from "./fixtures";

async function widget(options: { stt?: Promise<Response>; silence?: Promise<void>; tts?: Promise<Response>; autoplayBlocked?: boolean; microphoneDenied?: boolean; offline?: boolean; approval?: boolean; desktop?: boolean; oldHost?: boolean;
  listSpeech?: (kind: string, sessionId: string) => Promise<any[]>;
  dropInitialSubscription?: boolean; characterLibrary?: boolean; legacyPicker?: boolean; sharedControls?: boolean; hostStt?: boolean; hostSpeech?: boolean; noConnections?: boolean; noMedia?: boolean; finishSupport?: boolean; providers?: SpindleSTTProviderOption[] } = {}) {
  const host = fixture();
  if (options.finishSupport) {
    Object.assign(host.mutable.host.capabilities, { "desktop-capture-finish-v1": 1 });
    Object.assign(host.device, { recordingControlSupported: true });
  }
  const library = Array.from({ length: 125 }, (_, i) => ({ ...CHARACTER, id: i === 0 ? CHARACTER.id : `character-${i}`,
    name: i === 0 ? CHARACTER.name : i === 120 ? "Zelda" : `Companion ${i}`,
    avatar_url: `https://lumiverse.test/thumbnail-${i}.png` }));
  if (options.characterLibrary) {
    Object.assign(host.mutable.host.capabilities, { "character-search-v1": 1 });
    host.mutable.characters.list = async (input: any) => {
      const choices = library.filter(c => !input.search || c.name.toLowerCase().includes(input.search.toLowerCase()));
      return { data: choices.slice(input.offset, input.offset + input.limit), total: choices.length };
    };
    host.mutable.characters.get = async (id: string) => library.find(c => c.id === id) ?? null as any;
  }

  if (options.approval) Object.assign(host.mutable.host.capabilities, { "desktop-capture-approval-status-v1": 1 });
  if (options.oldHost) host.mutable.host.capabilities["command-session-routing-v1"] = 0;
  const editors: Array<{ target: HTMLElement; commandId: string; destroyed: boolean }> = [];
  const components: Array<{ kind: string; target: HTMLElement; options: any; destroyed: boolean; updates: number }> = [];
  const mount = (kind: string) => (target: HTMLElement, input: any) => {
    const component = { kind, target, options: input, destroyed: false, updates: 0 }; components.push(component);
    const body = target.ownerDocument.createElement("div"); target.append(body);
    return { body, update(patch: any) { component.options = { ...component.options, ...patch }; component.updates += 1; }, destroy() { component.destroyed = true; body.remove(); } };
  };
  const approval = deferred<typeof host.capture>();
  const dom = new JSDOM("<main></main>", { url: "https://lumiverse.test/", pretendToBeVisual: true });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const schedule = dom.window.setTimeout.bind(dom.window);
  const unschedule = dom.window.clearTimeout.bind(dom.window);
  dom.window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = schedule(() => { timers.delete(id); callback(); }, delay);
    timers.set(id, { callback, delay }); return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id) => { timers.delete(id); unschedule(id); };
  const globals = ["window", "document", "navigator", "Option", "fetch"];
  const previous = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests: string[] = [];
  const speechCalls: Array<{ input: { text: string }; options: { connectionId?: string }; stopped: boolean }> = [];
  const speechStops = new Set<() => void>();
  const speechListeners = new Set<(speaking: boolean) => void>();
  let speaking = false;
  const recognitions: Array<{ options: SpindleSTTStartOptions; cancelled: boolean; finished: boolean }> = [];
  const outgoing: any[] = [];
  const events = new Map<string, Set<(payload: unknown) => void>>();
  let microphoneRequests = 0;
  let tracksStopped = 0;
  let playback = 0;
  let clock = host.now;
  let devices = options.offline ? [] : [host.device];
  const backendMessages = new Map<string, Set<(payload: unknown) => void>>();
  const request = (async (url: unknown) => { requests.push(String(url)); throw new Error("Direct REST requests are forbidden"); }) as typeof fetch;
  const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Option: dom.window.Option, fetch: request };
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  host.mutable.desktop.capture.request = async (input) => { host.requests.push(input); return approval.promise; };
  host.mutable.desktop.capture.listDevices = async (input) => { host.gets.push({ kind: "devices", userId: input.userId }); return devices; };
  host.mutable.sendToFrontend = (payload, userId, routing) => {
    host.sent.push({ payload, userId, options: routing });
    for (const handler of [...(backendMessages.get(routing?.frontendSessionId ?? "") ?? [])]) handler(payload);
  };
  const uninstall = installCompanion(host.api, { now: () => clock });
  let droppedSubscription = false;
  function context(sessionId: string): SpindleFrontendContext { return { manifest: { identifier: "desk_companion" },
    host: { ...host.mutable.host, capabilities: { "frontend-session-origin-v1": 1, ...(options.characterLibrary && !options.legacyPicker ? { "shared-select-pagination-v1": 1 } : {}), ...(options.hostStt !== false ? { "speech-to-text-v1": 1 } : {}), ...(options.hostSpeech !== false ? { "text-to-speech-v1": 1, "connection-kinds-v1": 1 } : {}) } }, frontendSessionId: sessionId,
    ...(options.hostStt !== false ? { stt: {
      listProviders: () => options.providers ?? [
        { id: "whistle", name: "Whistle (on this device)", onDevice: true, available: true, supportsAudioTranscription: true },
        { id: "connection", name: "STT connection", onDevice: false, available: false, unavailableReason: "connectionRequired", supportsAudioTranscription: true },
      ],
      start(input: SpindleSTTStartOptions) {
        microphoneRequests += 1;
        if (options.microphoneDenied) throw new DOMException("Denied", "NotAllowedError");
        const call = { options: input, cancelled: false, finished: false }; recognitions.push(call);
        const final = deferred<{ text: string; provider: string }>();
        input.onStatus?.({ phase: "listening" });
        const process = async () => {
          await (options.silence ?? Promise.resolve());
          if (call.cancelled) return;
          input.onStatus?.({ phase: input.provider === "whistle" ? "loading" : "processing", progress: 0.5 });
          const response = await (options.stt ?? Response.json({ text: "What do you think?" }));
          if (call.cancelled) return;
          if (!response.ok) throw new Error("SECRET_PROVIDER_BODY");
          call.finished = true; tracksStopped += 1;
          final.resolve({ ...await response.clone().json(), provider: input.provider });
        };
        void process().catch(final.reject);
        return { provider: input.provider, ready: Promise.resolve(), result: final.promise,
          stop() { return final.promise; },
          cancel() { if (call.cancelled || call.finished) return; call.cancelled = true; tracksStopped += 1; final.reject(new DOMException("Aborted", "AbortError")); },
        };
      },
    } } : {}),
    connections: { async list({ kind }: { kind: string }) {
      if (options.listSpeech) return options.listSpeech(kind, sessionId);
      if (kind === "stt" && options.noConnections) throw new Error("No connections available");
      return kind === "tts" ? [{ id: "voice-a", kind, name: "Mira's voice", provider: "google", voice: "warm" }]
        : [{ id: "stt-a", kind, name: "Dictation", provider: "openai" }];
    } },
    tts: {
      async speak(input: { text: string }, settings: { connectionId?: string }) {
        const call = { input, options: settings, stopped: false }; speechCalls.push(call);
        const finished = deferred<void>();
        const stop = () => { call.stopped = true; speaking = false; for (const listener of speechListeners) listener(false); finished.resolve(); };
        speechStops.add(stop);
        const startup = (async () => {
          const response = await (options.tts ?? new Response("audio"));
          if (call.stopped) return;
          if (!response.ok) throw new Error("PRIVATE_PROVIDER_ERROR");
          if (options.autoplayBlocked) throw new DOMException("PRIVATE_PLAYBACK_ERROR", "NotAllowedError");
          playback += 1; speaking = true; for (const listener of speechListeners) listener(true);
          await finished.promise;
        })();
        try { await Promise.race([startup, finished.promise]); } finally { speechStops.delete(stop); }
      },
      stop() { for (const stop of speechStops) stop(); },
      isSpeaking: () => speaking,
      subscribe(callback: (speaking: boolean) => void) { speechListeners.add(callback); return () => speechListeners.delete(callback); },
    },
    client: { getInfo: () => ({ bridges: { desktop: options.desktop === true } }) },
    components: { ...(options.sharedControls === false ? {} : {
      mountSelect: mount("select"), mountTextArea: mount("textarea"), mountNumericInput: mount("number"), mountSwitch: mount("switch"), mountBadge: mount("badge"), mountCollapsibleSection: mount("section"),
    }), mountKeybindingEditor(target: HTMLElement, input: { commandId: string }) {
      const editor = { target, commandId: input.commandId, destroyed: false }; editors.push(editor);
      return { destroy() { editor.destroyed = true; } };
    } },
    permissions: { async getGranted() { return ["ui_panels", "characters", "generation", "screen_capture", "screen_recording", ...(options.noMedia ? [] : ["media"])]; } },
    getActiveChat: () => ({ characterId: "character-a", chatId: null }),
    events: { on(name: string, callback: (payload: unknown) => void) {
      const handlers = events.get(name) ?? new Set(); handlers.add(callback); events.set(name, handlers);
      return () => { handlers.delete(callback); };
    } },
    sendToBackend(payload: any) {
      outgoing.push(payload);
      if (options.dropInitialSubscription && !droppedSubscription && payload.type === "configure") {
        droppedSubscription = true;
        host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: sessionId }, "user-a");
        setTimeout(() => host.emit(payload, "user-a", sessionId), 0); return;
      }
      host.emit(payload, "user-a", sessionId);
    },
    onBackendMessage(callback: (payload: unknown) => void) {
      const handlers = backendMessages.get(sessionId) ?? new Set(); handlers.add(callback); backendMessages.set(sessionId, handlers);
      return () => { handlers.delete(callback); };
    },
  } as unknown as SpindleFrontendContext; }
  const settings = mountView(context("session-a"), dom.window.document.querySelector("main")!, { surface: "settings" });
  const view = mountView(context("session-b"), dom.window.document.querySelector("main")!);
  const element = <ElementType extends HTMLElement>(role: string) => (view.panel.querySelector<ElementType>(`[data-role="${role}"]`)
    ?? settings.panel.querySelector<ElementType>(`[data-role="${role}"]`))!;
  const runTimers = async (delay: number) => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) {
      dom.window.clearTimeout(id); timer.callback();
    }
    await settle();
  };
  const synchronize = () => runTimers(300);
  const enable = async (role: string) => {
    const control = element<HTMLInputElement>(role); control.checked = true; control.dispatchEvent(new dom.window.Event("input")); await synchronize();
  };
  await settle(); await synchronize();
  return { host, view, settings, context, dom, outgoing, events, element, enable, synchronize, requests, editors, components, recognitions, speechCalls, isSpeaking: () => speaking,
    setDevices: (value: typeof devices) => { devices = value; },
    advanceClock: () => { clock += 10001; },
    discover: async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); await settle(); },
    idle: () => runTimers(10000),
    connected: async (payload: unknown = { role: "user" }) => { for (const callback of [...events.get("CONNECTED") ?? []]) callback(payload); await settle(); },
    debounceSettings: synchronize,
    settingsTimers: () => [...timers].filter(([, timer]) => timer.delay === 300).map(([id]) => id),
    expireDiscovery: () => runTimers(8000),
    expireSpeechDiscovery: () => runTimers(15000),
    search: (query: string) => { components.find(c => c.options.ariaLabel === "Character")!.options.onSearchChange(query); return runTimers(200); },
    expireApproval: () => runTimers(12000),
    expireInput: () => runTimers(60000),
    microphoneRequests: () => microphoneRequests, tracksStopped: () => tracksStopped, playback: () => playback,
    approve: async () => { approval.resolve(host.capture); await settle(); },
    message: (payload: unknown) => { for (const callback of backendMessages.get("session-b") ?? []) callback(payload); },
    async close() {
      view.dispose(); settings.dispose(); uninstall(); approval.resolve(host.capture); await settle(); dom.window.close();
      for (const name of globals) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe("configured widget share pipeline", () => {
  test("drawer optimization controls persist and apply before generation, with PNG hiding lossy quality", async () => {
    const screen = await widget();
    Object.assign(screen.host.mutable.host.capabilities, { "desktop-capture-optimize-v1": 1 });
    const settingsElement = (role: string) => screen.settings.panel.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
    try {
      expect(settingsElement("optimization-options").hidden).toBe(true);
      screen.components.find(c => c.options.ariaLabel === "Optimize before sending")!.options.onChange(true);
      await screen.synchronize();
      expect(settingsElement("optimization-options").hidden).toBe(false);
      for (const [label, value] of [["Maximum long edge", 960], ["Image quality", 72], ["Image format", "webp"]] as const) {
        screen.components.find(c => c.options.ariaLabel === label)!.options.onChange(value);
      }
      await screen.synchronize();
      expect(screen.outgoing.filter(m => m.type === "configure").at(-1).patch).toMatchObject({ optimizeMaxEdge: 960, imageQuality: 72, imageFormat: "webp" });
      screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.host.optimized).toEqual([{ assetId: screen.host.capture.assetId, connectionId: "model-a", userId: "user-a", kind: "image", maxEdge: 960, quality: 72, format: "webp" }]);
      expect(screen.host.generations).toHaveLength(1);
      screen.components.find(c => c.options.ariaLabel === "Image format")!.options.onChange("png"); await screen.synchronize();
      expect(settingsElement("image-quality-field").hidden).toBe(true);
      screen.components.find(c => c.options.ariaLabel === "Capture type")!.options.onChange("video"); await screen.synchronize();
      expect(settingsElement("video-optimization").hidden).toBe(false);
      expect(settingsElement("image-optimization").hidden).toBe(true);
      screen.components.find(c => c.options.ariaLabel === "Video frame rate")!.options.onChange(10);
      screen.components.find(c => c.options.ariaLabel === "Video bitrate")!.options.onChange(1600);
      await screen.synchronize();
      expect(screen.outgoing.filter(m => m.type === "configure").at(-1).patch).toMatchObject({ videoFps: 10, videoBitrateKbps: 1600 });
    } finally { await screen.close(); }
  });
  test("Gemini media detail is optional, saves to shared settings, and reaches the request", async () => {
    const screen = await widget();
    try {
      expect(screen.settings.panel.querySelector<HTMLElement>('[data-role="media-resolution-field"]')!.hidden).toBe(false);
      const detail = screen.components.find(c => c.options.ariaLabel === "Gemini media detail")!;
      expect(detail.options.value).toBe("inherit");
      detail.options.onChange("high"); await screen.synchronize();
      expect(screen.outgoing.filter(m => m.type === "configure").at(-1).patch.mediaResolution).toBe("high");
      screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.host.generations[0].parameters).toEqual({ media_resolution: "high" });
    } finally { await screen.close(); }
  });

  test("history count saves without a fixed ceiling and the settings control clears the selected character", async () => {
    const screen = await widget();
    try {
      const count = screen.components.find(c => c.options.ariaLabel === "Conversation history exchanges")!;
      expect(count.options.value).toBe(5);
      expect(count.options.max).toBeUndefined();
      count.options.onChange(250); await screen.synchronize();
      expect(screen.outgoing.filter(m => m.type === "configure").at(-1).patch.historyTurns).toBe(250);
      screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      screen.element<HTMLButtonElement>("clear-history").click(); await settle();
      expect(screen.host.stored.get(JSON.stringify(["user-a", "companion-history-character-a.json"]))).toEqual([]);
    } finally { await screen.close(); }
  });

  test("the same shortcut or share button finishes one video early without a second capture or microphone session", async () => {
    for (const trigger of ["shortcut", "button"] as const) {
      const screen = await widget({ finishSupport: true });
      try {
        screen.components.find(c => c.options.ariaLabel === "Capture type")!.options.onChange("video");
        screen.components.find(c => c.options.ariaLabel === "Max clip duration")!.options.onChange(120);
        await screen.synchronize();
        if (trigger === "shortcut") await screen.host.invoke(); else screen.element<HTMLButtonElement>("observe").click();
        await settle();
        expect(screen.host.requests).toHaveLength(1);
        expect(screen.host.requests[0].durationSeconds).toBe(120);
        expect(screen.element("observe").textContent).toBe("Finish and send clip");
        expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
        if (trigger === "shortcut") { await screen.host.invoke(); await screen.host.invoke(); }
        else { screen.element<HTMLButtonElement>("observe").click(); screen.element<HTMLButtonElement>("observe").click(); }
        await settle();
        expect(screen.host.finished).toEqual([{ requestKey: screen.host.requests[0].requestKey, userId: "user-a" }]);
        expect(screen.host.requests).toHaveLength(1); expect(screen.microphoneRequests()).toBe(0);
        Object.assign(screen.host.capture, { kind: "video", mimeType: "video/mp4", durationSeconds: 2.5 });
        await screen.approve();
        expect(screen.host.generations).toHaveLength(1);
        expect(screen.element("reply").textContent).toBe("You have a calendar open.");
        expect(screen.host.released).toHaveLength(1);
      } finally { await screen.close(); }
    }
  });

  test("older desktops retain cutoff capture and ignore repeated share actions", async () => {
    const screen = await widget();
    try {
      screen.components.find(c => c.options.ariaLabel === "Capture type")!.options.onChange("video");
      await screen.synchronize(); await screen.host.invoke(); await settle(); await screen.host.invoke();
      expect(screen.host.finished).toHaveLength(0); expect(screen.host.requests).toHaveLength(1);
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      Object.assign(screen.host.capture, { kind: "video", mimeType: "video/mp4", durationSeconds: 3 });
      await screen.approve(); expect(screen.host.generations).toHaveLength(1);
    } finally { await screen.close(); }
  });
  test("speech lists recover from an initially empty host cache on focus without polling", async () => {
    let ready = false;
    const screen = await widget({ listSpeech: async kind => ready ? [{ id: `${kind}-ready`, kind, name: `${kind} ready`, provider: "google" }] : [] });
    try {
      expect(screen.element<HTMLSelectElement>("tts").options).toHaveLength(1);
      expect(screen.element<HTMLSelectElement>("stt").options).toHaveLength(1);
      ready = true; await screen.discover(); await screen.synchronize();
      expect(screen.element<HTMLSelectElement>("tts").value).toBe("tts-ready");
      expect(screen.element<HTMLSelectElement>("stt").value).toBe("stt-ready");
      expect(screen.components.find(c => c.options.ariaLabel === "TTS connection")!.options.options).toEqual([
        { value: "tts-ready", label: "tts ready · google", disabled: false },
      ]);
      expect(screen.host.requests).toHaveLength(0); expect(screen.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("Refresh retries failed speech discovery and reconnect updates renamed profiles", async () => {
    let ready = false;
    let name = "Original";
    const screen = await widget({ listSpeech: async kind => {
      if (!ready) throw new Error("PRIVATE_BACKEND_FAILURE");
      return [{ id: `${kind}-ready`, kind, name, provider: "google" }];
    } });
    try {
      ready = true; screen.element<HTMLButtonElement>("refresh").click(); await settle(); await screen.synchronize();
      expect(screen.element<HTMLSelectElement>("tts").value).toBe("tts-ready");
      expect(screen.element<HTMLSelectElement>("stt").value).toBe("stt-ready");
      const saves = screen.outgoing.filter(message => message.type === "configure").length;
      name = "Renamed"; await screen.connected();
      expect(screen.element<HTMLSelectElement>("tts").selectedOptions[0].textContent).toBe("Renamed · google");
      expect(screen.element<HTMLSelectElement>("stt").selectedOptions[0].textContent).toBe("Renamed · google");
      expect(screen.outgoing.filter(message => message.type === "configure")).toHaveLength(saves);
      expect(screen.settings.panel.textContent).not.toContain("PRIVATE_BACKEND_FAILURE");
      expect(screen.host.requests).toHaveLength(0); expect(screen.recognitions).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("speech discovery timeout can be retried and a late response cannot replace newer choices", async () => {
    const pending = deferred<any[]>();
    let ready = false;
    const screen = await widget({ listSpeech: async kind => ready ? [{ id: `${kind}-new`, kind, name: "Current", provider: "google" }] : pending.promise });
    try {
      await screen.expireSpeechDiscovery();
      ready = true; screen.element<HTMLButtonElement>("refresh").click(); await settle(); await screen.synchronize();
      expect(screen.element<HTMLSelectElement>("tts").value).toBe("tts-new");
      expect(screen.element<HTMLSelectElement>("stt").value).toBe("stt-new");
      pending.resolve([{ id: "obsolete", kind: "tts", name: "Obsolete", provider: "google" }]); await settle();
      expect(screen.element<HTMLSelectElement>("tts").value).toBe("tts-new");
      expect(screen.element<HTMLSelectElement>("stt").value).toBe("stt-new");
    } finally { pending.resolve([]); await screen.close(); }
  });

  test("new speech selections synchronize to widgets and a failed refresh preserves working choices", async () => {
    let added = false, failed = false;
    const loads: string[] = [];
    const screen = await widget({ listSpeech: async (kind, sessionId) => {
      loads.push(sessionId);
      if (failed) throw new Error("Connection unavailable");
      return ["a", ...(added ? ["b"] : [])].map(suffix => ({ id: `${kind}-${suffix}`, kind, name: suffix, provider: "google" }));
    } });
    try {
      await screen.enable("auto-speak");
      added = true;
      screen.settings.panel.querySelector<HTMLButtonElement>('[data-tab="speech"]')!.click(); await settle();
      screen.components.find(c => c.options.ariaLabel === "TTS connection")!.options.onChange("tts-b");
      screen.components.find(c => c.options.ariaLabel === "STT connection")!.options.onChange("stt-b");
      const widgetLoads = loads.filter(sessionId => sessionId === "session-b").length;
      await screen.synchronize();
      expect(loads.filter(sessionId => sessionId === "session-b").length).toBeGreaterThan(widgetLoads);
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      failed = true; screen.element<HTMLButtonElement>("refresh").click(); await settle();
      expect(screen.element<HTMLSelectElement>("tts").value).toBe("tts-b");
      expect(screen.element<HTMLSelectElement>("stt").value).toBe("stt-b");
      expect(screen.element("tts-guidance").textContent).toContain("Use Refresh to retry");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.host.requests).toHaveLength(0); expect(screen.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("idle time never polls connections or redraws shared controls", async () => {
    const screen = await widget();
    try {
      const sent = screen.outgoing.length;
      const queries = screen.host.gets.length;
      const updates = screen.components.map(component => component.updates);
      await screen.idle(); await screen.idle(); await screen.idle();
      expect(screen.outgoing).toHaveLength(sent);
      expect(screen.host.gets).toHaveLength(queries);
      expect(screen.components.map(component => component.updates)).toEqual(updates);
      expect(screen.settings.panel.querySelector('[data-role="sync-status"]')!.textContent).toBe("Saved");
    } finally { await screen.close(); }
  });

  test("returning to the window checks desktops without resubscribing or reloading controls", async () => {
    const screen = await widget();
    try {
      const subscriptions = screen.outgoing.filter(message => message.type === "subscribe").length;
      const catalogs = screen.outgoing.filter(message => message.type === "catalog").length;
      const queries = screen.host.gets.filter(entry => entry.kind === "devices").length;
      const updates = screen.components.map(component => component.updates);
      screen.dom.window.dispatchEvent(new screen.dom.window.Event("focus"));
      screen.dom.window.document.dispatchEvent(new screen.dom.window.Event("visibilitychange"));
      await settle();
      expect(screen.host.gets.filter(entry => entry.kind === "devices").length).toBeGreaterThan(queries);
      expect(screen.outgoing.filter(message => message.type === "subscribe")).toHaveLength(subscriptions);
      expect(screen.outgoing.filter(message => message.type === "catalog")).toHaveLength(catalogs);
      expect(screen.components.map(component => component.updates)).toEqual(updates);
      expect(screen.element("badge").textContent).toBe("Ready");
    } finally { await screen.close(); }
  });

  test("Spindle's authenticated connection event restores subscriptions and retains the input debounce", async () => {
    const screen = await widget();
    try {
      const subscriptions = screen.outgoing.filter(message => message.type === "subscribe").length;
      await screen.connected({});
      expect(screen.outgoing.filter(message => message.type === "subscribe")).toHaveLength(subscriptions);
      screen.host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: "session-a" }, "user-a");
      screen.host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: "session-b" }, "user-a");
      await settle();
      const field = screen.components.find(c => c.options.ariaLabel === "Optional question or direction")!;
      field.options.onChange("Keep this edit through reconnect");
      const saves = screen.outgoing.filter(message => message.type === "configure").length;
      await screen.connected();
      expect(screen.outgoing.filter(message => message.type === "subscribe")).toHaveLength(subscriptions + 2);
      expect(screen.outgoing.filter(message => message.type === "configure")).toHaveLength(saves);
      expect(field.options.value).toBe("Keep this edit through reconnect");
      await screen.debounceSettings();
      expect(screen.outgoing.filter(message => message.type === "configure")).toHaveLength(saves + 1);
      expect(screen.settings.panel.querySelector('[data-role="sync-status"]')!.textContent).toBe("Saved");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.host.requests).toHaveLength(0); expect(screen.recognitions).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("settings input restarts the debounce and discovery cannot save early or repeatedly", async () => {
    const screen = await widget();
    try {
      const field = screen.components.find(c => c.options.ariaLabel === "Optional question or direction")!;
      const saves = () => screen.outgoing.filter(message => message.type === "configure");
      const count = saves().length;
      field.options.onChange("First edit");
      const firstTimer = screen.settingsTimers();
      expect(firstTimer).toHaveLength(1);
      field.options.onChange("Latest edit");
      expect(screen.settingsTimers()).toHaveLength(1);
      expect(screen.settingsTimers()).not.toEqual(firstTimer);
      await screen.discover();
      expect(saves()).toHaveLength(count);
      expect(field.options.value).toBe("Latest edit");
      await screen.debounceSettings();
      expect(saves()).toHaveLength(count + 1);
      expect(saves().at(-1).patch).toEqual({ question: "Latest edit" });
      await screen.discover(); await screen.discover();
      expect(saves()).toHaveLength(count + 1);
    } finally { await screen.close(); }
  });

  test("acknowledging an earlier save does not flush newer input before its debounce", async () => {
    const screen = await widget();
    const saved = screen.host.mutable.userStorage.setJson;
    const acknowledgement = deferred<void>();
    let blocked = true;
    screen.host.mutable.userStorage.setJson = async (...args) => {
      if (blocked) { blocked = false; await acknowledgement.promise; }
      await saved(...args);
    };
    try {
      const field = screen.components.find(c => c.options.ariaLabel === "Optional question or direction")!;
      const saves = () => screen.outgoing.filter(message => message.type === "configure");
      const count = saves().length;
      field.options.onChange("First save"); await screen.debounceSettings();
      expect(saves()).toHaveLength(count + 1);
      field.options.onChange("Still typing");
      acknowledgement.resolve(); await settle();
      expect(saves()).toHaveLength(count + 1);
      field.options.onChange("Finished typing"); await screen.debounceSettings();
      expect(saves()).toHaveLength(count + 2);
      expect(saves().at(-1).patch).toEqual({ question: "Finished typing" });
    } finally { acknowledgement.resolve(); screen.host.mutable.userStorage.setJson = saved; await screen.close(); }
  });

  test("shared controls repeating the same value on blur do not save again", async () => {
    const screen = await widget();
    try {
      const field = screen.components.find(c => c.options.ariaLabel === "Max clip duration")!;
      screen.components.find(c => c.options.ariaLabel === "Capture type")!.options.onChange("video");
      field.options.onChange(10); await screen.debounceSettings();
      const count = screen.outgoing.filter(message => message.type === "configure").length;
      field.options.onChange(10);
      expect(screen.settingsTimers()).toHaveLength(0);
      expect(screen.settings.panel.querySelector('[data-role="sync-status"]')!.textContent).toBe("Saved");
      await screen.debounceSettings(); await screen.discover();
      expect(screen.outgoing.filter(message => message.type === "configure")).toHaveLength(count);
    } finally { await screen.close(); }
  });

  test("native change, blur, and closing settings cannot bypass the input debounce", async () => {
    const screen = await widget({ sharedControls: false });
    try {
      const question = screen.element<HTMLTextAreaElement>("question");
      const count = screen.outgoing.filter(message => message.type === "configure").length;
      question.value = "Only input should schedule a save";
      question.dispatchEvent(new screen.dom.window.Event("change"));
      question.dispatchEvent(new screen.dom.window.Event("blur"));
      expect(screen.settingsTimers()).toHaveLength(0);
      question.dispatchEvent(new screen.dom.window.Event("input"));
      question.dispatchEvent(new screen.dom.window.Event("blur"));
      expect(screen.outgoing.filter(message => message.type === "configure")).toHaveLength(count);
      screen.settings.dispose(); await screen.debounceSettings();
      expect(screen.outgoing.filter(message => message.type === "configure")).toHaveLength(count);
    } finally { await screen.close(); }
  });

  test("recovers a settings subscription lost during setup without losing visible choices", async () => {
    const screen = await widget({ dropInitialSubscription: true });
    try {
      await screen.synchronize();
      expect(screen.settings.panel.querySelector('[data-role="badge"]')!.textContent).toBe("Ready");
      expect(screen.settings.panel.querySelector('[data-role="status"]')!.textContent).toBe("");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      const field = screen.components.find(c => c.options.ariaLabel === "Capture type")!;
      field.options.onChange("video"); await screen.synchronize();
      expect(field.options.value).toBe("video");
      expect(screen.element("observe").textContent).toBe("Share a video clip");
      expect(screen.requests).toHaveLength(0); expect(screen.recognitions).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("reconnects after a lost save acknowledgement and keeps newer edits", async () => {
    const screen = await widget();
    const deliver = screen.host.mutable.sendToFrontend;
    let dropped = false;
    screen.host.mutable.sendToFrontend = (payload: any, userId, route) => {
      if (!dropped && route?.frontendSessionId === "session-a" && payload.type === "state"
        && screen.outgoing.some(message => message.type === "configure" && message.id === payload.id)) { dropped = true; return; }
      deliver(payload, userId, route);
    };
    try {
      const field = screen.components.find(c => c.options.ariaLabel === "Optional question or direction")!;
      field.options.onChange("First edit"); await screen.synchronize();
      field.options.onChange("Keep the latest edit");
      await screen.expireDiscovery(); await screen.synchronize();
      expect(dropped).toBe(true);
      expect(field.options.value).toBe("Keep the latest edit");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.settings.panel.querySelector('[data-role="sync-status"]')!.textContent).toBe("Saved");
      expect(screen.requests).toHaveLength(0); expect(screen.recognitions).toHaveLength(0);
    } finally { screen.host.mutable.sendToFrontend = deliver; await screen.close(); }
  });

  test("a lost share subscription reconnects without replaying microphone input or capture", async () => {
    const screen = await widget();
    try {
      await screen.enable("voice-input");
      const emit = screen.host.emit;
      let disconnected = false;
      screen.host.emit = (payload: any, userId, sessionId) => {
        if (!disconnected && payload.type === "begin-share") {
          disconnected = true;
          setTimeout(() => {
            screen.host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: sessionId }, userId);
            setTimeout(() => emit(payload, userId, sessionId), 0);
          }, 0);
        } else emit(payload, userId, sessionId);
      };
      screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.synchronize();
      expect(screen.recognitions).toHaveLength(1);
      expect(screen.recognitions[0].cancelled || screen.recognitions[0].finished).toBe(true);
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0); expect(screen.speechCalls).toHaveLength(0);
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.recognitions).toHaveLength(2);
      expect(screen.host.requests).toHaveLength(1);
    } finally { await screen.close(); }
  });

  test("character picker loads on scroll, searches the library and retains selection and thumbnails", async () => {
    const screen = await widget({ characterLibrary: true });
    try {
      const picker = screen.components.find(c => c.options.ariaLabel === "Character")!;
      expect(screen.settings.panel.querySelector('[data-role="next"]')).toBeNull();
      expect(picker.options.loadMoreOnScroll).toBe(true);
      expect(picker.options.remoteSearch).toBe(true);
      expect(picker.options.options).toHaveLength(50);
      expect(picker.options.options[0].leading.src).toBe("https://lumiverse.test/thumbnail-0.png");
      const settingsClient = screen.outgoing.find(message => message.type === "subscribe" && message.surface === "settings").clientId;
      const catalogs = screen.outgoing.filter(message => message.type === "catalog" && message.clientId === settingsClient).length;
      picker.options.onLoadMore(); picker.options.onLoadMore(); await settle();
      expect(picker.options.options).toHaveLength(100);
      picker.options.onChange("character-75"); await screen.synchronize();
      await screen.search("Zelda");
      expect(picker.options.options.map((c: any) => c.value)).toEqual(["character-75", "character-120"]);
      expect(picker.options.value).toBe("character-75");
      expect(picker.options.hasMore).toBe(false);
      picker.options.onChange("character-120"); await screen.synchronize();
      expect(picker.options.value).toBe("character-120");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      await screen.search("");
      expect(picker.options.options[0].value).toBe("character-120");
      expect(screen.outgoing.filter(message => message.type === "catalog" && message.clientId === settingsClient)).toHaveLength(catalogs);
      expect(screen.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("character search ignores stale pages and failed pagination can be retried", async () => {
    const screen = await widget({ characterLibrary: true });
    try {
      const picker = screen.components.find(c => c.options.ariaLabel === "Character")!;
      const list = screen.host.mutable.characters.list;
      screen.host.mutable.characters.list = async () => { throw new Error("private provider data"); };
      picker.options.onLoadMore(); await settle();
      expect(picker.options.loading).toBe(false);
      expect(picker.options.hasMore).toBe(true);
      expect(picker.options.options).toHaveLength(50);
      screen.host.mutable.characters.list = list;
      picker.options.onLoadMore(); await settle();
      expect(picker.options.options).toHaveLength(100);
      const late = deferred<any>();
      screen.host.mutable.characters.list = input => input.search === "older" ? late.promise : list(input);
      await screen.search("older");
      await screen.search("Zelda");
      expect(picker.options.options.map((c: any) => c.label)).toEqual(["Mira", "Zelda"]);
      late.resolve({ data: [{ ...CHARACTER, id: "stale", name: "Stale" }], total: 1 }); await settle();
      expect(picker.options.options.map((c: any) => c.label)).toEqual(["Mira", "Zelda"]);
      expect(picker.options.value).toBe("character-a");
      expect(screen.settings.panel.textContent).not.toContain("private provider data");
    } finally { await screen.close(); }
  });

  test("older pickers preload the library without page controls", async () => {
    const screen = await widget({ characterLibrary: true, legacyPicker: true });
    try {
      const picker = screen.components.find(c => c.options.ariaLabel === "Character")!;
      expect(picker.options.options).toHaveLength(125);
      expect(picker.options.remoteSearch).toBe(false);
      expect(picker.options.hasMore).toBe(false);
      expect(screen.settings.panel.querySelector('[data-role="previous"]')).toBeNull();
      picker.options.onChange("character-120"); await screen.synchronize();
      expect(picker.options.value).toBe("character-120");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("shared controls save across tabs and windows, follow busy state, and unmount on disposal", async () => {
    const screen = await widget();
    try {
      const field = (label: string) => screen.components.find(component => component.options.ariaLabel === label)!;
      expect(screen.components.map(component => component.kind)).toEqual(expect.arrayContaining(["select", "textarea", "number", "switch", "badge", "section"]));
      expect(screen.element("character").hidden).toBe(true);
      const speech = screen.settings.panel.querySelector<HTMLButtonElement>('[data-tab="speech"]')!;
      speech.click();
      expect(screen.settings.panel.querySelector<HTMLElement>('[data-pane="speech"]')!.hidden).toBe(false);
      expect(screen.settings.panel.querySelector<HTMLElement>('[data-pane="companion"]')!.hidden).toBe(true);
      field("STT provider").options.onChange("whistle");
      field("Voice input").options.onChange(true);
      field("Capture type").options.onChange("video");
      field("Max clip duration").options.onChange(10);
      field("Optional question or direction").options.onChange("x".repeat(1200));
      field("Optional question or direction").options.onChange("x".repeat(1201));
      expect(field("Optional question or direction").options.value).toHaveLength(1200);
      field("Optional question or direction").options.onChange("What catches your eye?");
      await screen.synchronize();
      expect(screen.element("duration-field").hidden).toBe(false);
      expect(field("STT provider").options.value).toBe("whistle");
      expect(screen.element("observe").textContent).toBe("Share a video clip");
      expect(speech.getAttribute("aria-selected")).toBe("true");
      speech.dispatchEvent(new screen.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(screen.settings.panel.querySelector('[data-tab="shortcuts"]')!.getAttribute("aria-selected")).toBe("true");
      Object.assign(screen.host.capture, { kind: "video", mimeType: "video/mp4", durationSeconds: 10 });
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(field("Capture type").options.disabled).toBe(true);
      expect(screen.recognitions[0].options.provider).toBe("whistle");
      expect(screen.host.requests[0].durationSeconds).toBe(10);
      await screen.approve();
      expect(screen.host.generations[0].messages.at(-1)!.content[0].text).toContain("What catches your eye?");
      expect(field("Capture type").options.disabled).toBe(false);
      screen.settings.dispose();
      expect(screen.components.filter(component => screen.settings.panel.contains(component.target))).toHaveLength(0);
      expect(screen.components.filter(component => component.kind !== "badge").every(component => component.destroyed)).toBe(true);
    } finally { await screen.close(); }
    expect(screen.components.every(component => component.destroyed)).toBe(true);
  });

  test("the compact widget shows only relevant controls and keeps native fields usable on older hosts", async () => {
    const screen = await widget({ sharedControls: false });
    try {
      expect(screen.element("character").hidden).toBe(false);
      expect(screen.view.panel.querySelector('[data-role="widget-summary"]')).toBeNull();
      expect(screen.element("capture-readiness").hidden).toBe(true);
      for (const role of ["cancel", "speak", "stop-speech", "clear"]) expect(screen.element(role).hidden).toBe(true);
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.element("cancel").hidden).toBe(false);
      await screen.approve();
      expect(screen.element("cancel").hidden).toBe(true);
      expect(screen.element("clear").hidden).toBe(false);
      expect(screen.element("speak").hidden).toBe(false);
      expect(screen.element("status").textContent).toBe("");
    } finally { await screen.close(); }
  });

  test("a button starts host input synchronously and waits for silence instead of a duration", async () => {
    const silence = deferred<void>(); const screen = await widget({ silence: silence.promise });
    try {
      await screen.enable("voice-input");
      screen.element<HTMLButtonElement>("observe").click();
      expect(screen.microphoneRequests()).toBe(1);
      await settle();
      expect(screen.recognitions[0].options.continuous).toBe(false);
      expect(screen.settings.panel.querySelector('[data-role="voice-seconds"]')).toBeNull();
      expect(screen.element("badge").textContent).toBe("Listening");
      expect(screen.host.requests).toHaveLength(0);
      await screen.host.invoke(); await settle(); expect(screen.recognitions).toHaveLength(1);
      silence.resolve(); await settle();
      expect(screen.host.requests).toHaveLength(1); await screen.approve();
      expect(screen.host.generations[0].messages.at(-1)!.content[0].text).toBe("What do you think?");
      expect(screen.requests).toHaveLength(0);
    } finally { silence.resolve(); await screen.close(); }
  });

  test("Cancel and the maximum timeout close listening sessions without a later capture", async () => {
    for (const action of ["cancel", "timeout"]) {
      const silence = deferred<void>(); const screen = await widget({ silence: silence.promise });
      try {
        await screen.enable("voice-input"); screen.element<HTMLButtonElement>("observe").click(); await settle();
        if (action === "cancel") screen.element<HTMLButtonElement>("cancel").click();
        else await screen.expireInput();
        await settle();
        expect(screen.recognitions[0].cancelled).toBe(true);
        silence.resolve(); await settle();
        expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
      } finally { silence.resolve(); await screen.close(); }
    }
  });

  test("a rejected button reservation cancels input started in the user gesture", async () => {
    const silence = deferred<void>(); const screen = await widget({ silence: silence.promise });
    const emit = screen.host.emit; let reservation: any;
    try {
      await screen.enable("voice-input");
      screen.host.emit = (payload: any, userId, sessionId) => {
        if (payload.type === "begin-share") reservation = payload;
        else emit(payload, userId, sessionId);
      };
      screen.element<HTMLButtonElement>("observe").click();
      expect(screen.microphoneRequests()).toBe(1);
      screen.message({ ...reservation, type: "error", code: "BUSY", message: "Another share started." }); await settle();
      expect(screen.recognitions[0].cancelled).toBe(true);
      silence.resolve(); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
    } finally { silence.resolve(); await screen.close(); }
  });

  test("Whistle works without saved STT connections and a shortcut transcribes exactly once through Spindle", async () => {
    const transcript = deferred<Response>(); const screen = await widget({ noConnections: true, stt: transcript.promise });
    try {
      const question = screen.element<HTMLTextAreaElement>("question");
      question.value = "Look at this page.";
      question.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize();
      const provider = screen.element<HTMLSelectElement>("stt-provider");
      expect([...provider.options].find((option) => option.value === "whistle")?.disabled).toBe(false);
      provider.value = "whistle"; provider.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize();
      await screen.enable("voice-input"); await screen.enable("auto-speak");
      expect(screen.element("stt-connection").hidden).toBe(true);
      expect(screen.element("stt-guidance").textContent).toContain("On-device");
      expect(screen.view.panel.querySelector('[data-role="widget-summary"]')).toBeNull();
      await screen.host.invoke(); await settle();
      expect(screen.recognitions).toHaveLength(1); expect(screen.microphoneRequests()).toBe(1);
      expect(screen.recognitions[0].options.provider).toBe("whistle");
      expect(Object.hasOwn(screen.recognitions[0].options, "connectionId")).toBe(false);
      expect(screen.element("status").textContent).toContain("Loading Whistle");
      await screen.host.invoke(); await settle(); expect(screen.recognitions).toHaveLength(1);
      transcript.resolve(Response.json({ text: "What changed?" })); await settle(); await screen.approve();
      expect(screen.host.generations[0].messages.at(-1)!.content[0].text).toBe("Look at this page.\n\nWhat changed?");
      expect(screen.host.generations[0].messages[0].content).toContain(CHARACTER.description);
      expect(screen.host.generations[0].messages[0].content).toContain(CHARACTER.personality);
      expect(screen.host.generations[0].messages[0].content).toContain(`You are ${CHARACTER.name},`);
      expect(screen.speechCalls).toHaveLength(1); expect(screen.requests).toHaveLength(0);
    } finally { transcript.resolve(Response.json({ text: "late" })); await screen.close(); }
  });

  test("missing Media permission blocks voice while the quick shortcut still shares", async () => {
    const screen = await widget({ noMedia: true });
    try {
      await screen.enable("voice-input");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      expect(screen.element("stt-guidance").textContent).toContain("grant Media");
      await screen.host.invoke(); await settle(); expect(screen.microphoneRequests()).toBe(0);
      await screen.host.invoke("share-screen-without-voice"); await settle();
      expect(screen.host.requests).toHaveLength(1); expect(screen.recognitions).toHaveLength(0);
      expect(screen.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("older speech hosts keep text sharing and cannot fall back to REST", async () => {
    const screen = await widget({ hostStt: false, hostSpeech: false });
    try {
      expect([...screen.element<HTMLSelectElement>("stt-provider").options].every((option) => option.disabled)).toBe(true);
      expect(screen.element("tts-guidance").textContent).toContain("Update Lumiverse");
      screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.requests).toHaveLength(0);
      expect(screen.speechCalls).toHaveLength(0); expect(screen.recognitions).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("Whistle failure stops before capture without switching to a connection", async () => {
    const screen = await widget({ stt: Promise.resolve(new Response("PRIVATE_PROVIDER_ERROR", { status: 502 })) });
    try {
      const provider = screen.element<HTMLSelectElement>("stt-provider"); provider.value = "whistle";
      provider.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize(); await screen.enable("voice-input");
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.recognitions).toHaveLength(1); expect(screen.host.requests).toHaveLength(0);
      expect(screen.element("status").textContent).toContain("Whistle could not transcribe");
      expect(screen.element("status").textContent).not.toContain("PRIVATE_PROVIDER_ERROR");
      expect(screen.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("a shortcut follows configured voice input once and ignores repeat presses while transcribing", async () => {
    const transcript = deferred<Response>(); const screen = await widget({ stt: transcript.promise });
    try {
      await screen.enable("voice-input"); await screen.enable("auto-speak");
      await screen.host.invoke(); await settle();
      expect(screen.microphoneRequests()).toBe(1);
      expect(screen.element("badge").textContent).toBe("Transcribing");
      expect(screen.host.requests).toHaveLength(0);
      await screen.host.invoke(); await settle();
      expect(screen.microphoneRequests()).toBe(1); expect(screen.recognitions).toHaveLength(1);
      expect(screen.recognitions[0].options).toMatchObject({ provider: "connection", connectionId: "stt-a" });
      transcript.resolve(Response.json({ text: "What changed?" })); await settle();
      expect(screen.host.requests).toHaveLength(1);
      await screen.approve();
      expect(screen.host.generations).toHaveLength(1);
      expect(screen.host.generations[0].messages.at(-1)!.content[0].text).toBe("What changed?");
      expect(screen.speechCalls).toHaveLength(1);
    } finally { transcript.resolve(Response.json({ text: "late" })); await screen.close(); }
  });

  test("quick shortcut skips configured STT without changing preferences, written question, or automatic reply speech", async () => {
    const screen = await widget({ microphoneDenied: true });
    try {
      await screen.enable("voice-input"); await screen.enable("auto-speak");
      const question = screen.element<HTMLTextAreaElement>("question"); question.value = "Check this calendar";
      question.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize();
      await screen.host.invoke("share-screen-without-voice"); await settle();
      expect(screen.microphoneRequests()).toBe(0); expect(screen.recognitions).toHaveLength(0);
      expect(screen.host.requests).toHaveLength(1); await screen.approve();
      expect(screen.host.generations[0].messages.at(-1)!.content[0].text).toBe("Check this calendar");
      expect(screen.element<HTMLInputElement>("voice-input").checked).toBe(true);
      expect(screen.speechCalls).toHaveLength(1);
    } finally { await screen.close(); }
  });

  test("shortcut shares without STT by default and never runs in another document or before setup", async () => {
    const screen = await widget({ offline: true });
    try {
      await screen.host.invoke(); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.microphoneRequests()).toBe(0);
      expect(screen.element("status").textContent).toContain("Finish setup");
      screen.setDevices([screen.host.device]); await screen.discover(); await screen.synchronize();
      await screen.host.invoke("share-screen", "other-user", "session-b");
      await screen.host.invoke("share-screen", "user-a", "other-document"); await settle();
      expect(screen.host.requests).toHaveLength(0);
      await screen.host.invoke(); await settle();
      expect(screen.microphoneRequests()).toBe(0); expect(screen.host.requests).toHaveLength(1);
      await screen.approve();
    } finally { await screen.close(); }
  });

  test("the invoking main document can own microphone input and cancellation when its widget is popped out", async () => {
    const transcript = deferred<Response>(); const screen = await widget({ stt: transcript.promise });
    try {
      await screen.enable("voice-input"); screen.view.dispose();
      await screen.host.invoke("share-screen", "user-a", "session-a"); await settle();
      expect(screen.microphoneRequests()).toBe(1);
      const cancel = screen.settings.panel.querySelector<HTMLButtonElement>('[data-role="cancel"]')!;
      expect(cancel.hidden).toBe(false); cancel.click(); await settle();
      transcript.resolve(Response.json({ text: "late" })); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
    } finally { transcript.resolve(Response.json({ text: "late" })); await screen.close(); }
  });

  test("embeds both host binding editors only in desktop settings and destroys them on teardown", async () => {
    const screen = await widget({ desktop: true });
    try {
      expect(screen.editors.map(editor => editor.commandId)).toEqual(["share-screen"]);
      expect(screen.editors.every(editor => screen.settings.panel.contains(editor.target))).toBe(true);
      const action = screen.element<HTMLSelectElement>("shortcut-action"); action.value = "share-screen-without-voice";
      action.dispatchEvent(new screen.dom.window.Event("change"));
      expect(screen.editors.map(editor => editor.commandId)).toEqual(["share-screen", "share-screen-without-voice"]);
      expect(screen.editors[0].destroyed).toBe(true); expect(screen.editors[1].destroyed).toBe(false);
      expect(screen.element("shortcut-help").textContent).toContain("second action skips voice input");
      screen.settings.dispose(); expect(screen.editors.every(editor => editor.destroyed)).toBe(true);
    } finally { await screen.close(); }
    for (const options of [{}, { desktop: true, oldHost: true }]) {
      const fallback = await widget(options);
      try {
        expect(fallback.editors).toHaveLength(0);
        if (options.oldHost) expect(fallback.element("shortcut-help").textContent).toContain("Update the Lumiverse backend");
      } finally { await fallback.close(); }
    }
  });

  test("stable device identity reconnects without reselecting or capturing automatically", async () => {
    const screen = await widget();
    try {
      screen.setDevices([]); await screen.discover();
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      screen.setDevices([Object.assign(screen.host.device, { stableIdentity: true })]); await screen.discover();
      expect(screen.element<HTMLSelectElement>("device").value).toBe("desktop-a");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.host.requests).toHaveLength(0);
      expect(screen.outgoing.filter(message => message.type === "configure" && message.patch.deviceId && message.patch.deviceId !== "desktop-a")).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("approval discovery reports remembered, paused and missing-source states without starting capture", async () => {
    const screen = await widget({ approval: true });
    try {
      for (const [approval, source, expected] of [
        ["remembered", "ready", "Screen source remembered"],
        ["paused", "ready", "Capture requests are paused"],
        ["remembered", "missing", "saved source is unavailable"],
        ["remembered", "permission_required", "needs screen-recording permission"],
        ["required", "unknown", "Choose a screen source on your next share"],
      ]) {
        screen.host.mutable.desktop.capture.getApprovalStatus = async input => ({ ...input, approval, source, checkedAt: screen.host.now });
        await screen.discover();
        expect(screen.element("capture-readiness").textContent).toContain(expected);
      }
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0); expect(screen.microphoneRequests()).toBe(0);
    } finally { await screen.close(); }
  });

  test("an approval query cannot apply to a changed capture kind or arrive after its timeout", async () => {
    const screen = await widget({ approval: true });
    const old = deferred<any>();
    try {
      screen.host.mutable.desktop.capture.getApprovalStatus = async input => input.kind === "image" ? old.promise
        : { deviceId: input.deviceId, kind: "video", approval: "required", source: "unknown", checkedAt: screen.host.now };
      await screen.discover();
      const kind = screen.element<HTMLSelectElement>("kind"); kind.value = "video";
      kind.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize();
      old.resolve({ deviceId: "desktop-a", kind: "image", approval: "remembered", source: "ready", checkedAt: screen.host.now }); await settle();
      expect(screen.element("capture-readiness").textContent).not.toContain("Screen source remembered");
      await screen.discover();
      expect(screen.element("capture-readiness").textContent).toContain("Choose a screen source on your next share");
      const late = deferred<any>(); screen.host.mutable.desktop.capture.getApprovalStatus = async () => late.promise;
      await screen.discover(); await screen.expireApproval();
      late.resolve({ deviceId: "desktop-a", kind: "video", approval: "paused", source: "ready", checkedAt: screen.host.now }); await settle();
      expect(screen.element("capture-readiness").textContent).not.toContain("Capture requests are paused");
      expect(screen.host.requests).toHaveLength(0);
    } finally { old.resolve({}); await screen.close(); }
  });

  test("microphone denial and cooldown after a shortcut never fall through to capture or restart STT", async () => {
    const denied = await widget({ microphoneDenied: true });
    try {
      await denied.enable("voice-input"); await denied.host.invoke(); await settle();
      expect(denied.microphoneRequests()).toBe(1); expect(denied.host.requests).toHaveLength(0);
      expect(denied.element("status").textContent).toContain("Microphone access");
    } finally { await denied.close(); }
    const screen = await widget();
    try {
      await screen.enable("voice-input"); await screen.host.invoke(); await settle(); await screen.approve();
      await screen.host.invoke(); await settle();
      expect(screen.microphoneRequests()).toBe(1); expect(screen.host.requests).toHaveLength(1);
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
      expect(screen.element("status").textContent).toContain("Wait at least 10 seconds");
    } finally { await screen.close(); }
  });

  test("Stop speech while a shortcut waits for its reservation suppresses its later automatic reply", async () => {
    const screen = await widget();
    const emit = screen.host.emit;
    let reservation: any;
    try {
      await screen.enable("auto-speak");
      screen.host.emit = (payload: any, userId, sessionId) => {
        if (payload.type === "begin-share") reservation = { payload, userId, sessionId };
        else emit(payload, userId, sessionId);
      };
      await screen.host.invoke(); await settle();
      expect(reservation).toBeDefined(); expect(screen.host.requests).toHaveLength(0);
      screen.element<HTMLButtonElement>("stop-speech").click();
      emit(reservation.payload, reservation.userId, reservation.sessionId); await settle(); await screen.approve();
      expect(screen.host.requests).toHaveLength(1); expect(screen.host.generations).toHaveLength(1);
      expect(screen.speechCalls).toHaveLength(0);
    } finally { screen.host.emit = emit; await screen.close(); }
  });

  test("discovers newly enabled capture on focus without starting media or reloading resource catalogs", async () => {
    const screen = await widget({ offline: true });
    try {
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      expect(screen.element("badge").textContent).toBe("Setup needed");
      expect(screen.element("capture-readiness").textContent).toContain("Set Up Screen Capture");
      const resourceLoads = screen.host.gets.filter((entry) => entry.kind !== "devices").length;
      screen.setDevices([screen.host.device]);
      await screen.discover(); await screen.synchronize(); await settle();
      expect(screen.element<HTMLSelectElement>("device").value).toBe("desktop-a");
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.element("badge").textContent).toBe("Ready");
      expect(screen.element("capture-readiness").hidden).toBe(true);
      expect(screen.host.gets.filter((entry) => entry.kind !== "devices")).toHaveLength(resourceLoads);
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
      expect(screen.microphoneRequests()).toBe(0); expect(screen.speechCalls).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("a reconnected desktop with the same name requires an explicit registration choice", async () => {
    const screen = await widget();
    try {
      screen.setDevices([{ ...screen.host.device, id: "desktop-new" }]);
      await screen.discover(); await screen.synchronize();
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      expect(screen.element<HTMLSelectElement>("device").value).toBe("desktop-a");
      expect(screen.element<HTMLSelectElement>("device").selectedOptions[0].textContent).toContain("Saved display unavailable");
      expect(screen.element("capture-readiness").textContent).toContain("choose a desktop in Settings");
      expect(screen.host.requests).toHaveLength(0);
      const control = screen.element<HTMLSelectElement>("device");
      control.value = "desktop-new"; control.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize();
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.host.requests).toHaveLength(0);
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests[0].deviceId).toBe("desktop-new");
      await screen.approve();
    } finally { await screen.close(); }
  });

  test("all three displays appear in settings and selecting the third routes the widget capture without fallback after unplugging it", async () => {
    const screen = await widget({ approval: true });
    try {
      const displays = ["a", "b", "c"].map((id, index) => ({ id: id.repeat(64), name: `Display ${index + 1}`, width: 1920, height: 1080, primary: index === 0 }));
      Object.assign(screen.host.device, { displays });
      await screen.discover(); await screen.synchronize();
      const control = screen.element<HTMLSelectElement>("device");
      for (const display of displays) expect(Array.from(control.options).find(option => option.value === display.id)?.textContent).toContain(display.name);
      expect(Array.from(control.options).find(option => option.value === displays[0].id)?.textContent).toContain("Primary");
      expect(control.value).toBe("desktop-a"); // Existing saved native-picker choice survives the upgrade.
      control.value = displays[2].id; control.dispatchEvent(new screen.dom.window.Event("input")); await screen.synchronize();
      expect(screen.host.approvalQueries.at(-1)).toMatchObject({ deviceId: "desktop-a", displayId: displays[2].id });
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests[0]).toMatchObject({ deviceId: "desktop-a", displayId: displays[2].id, kind: "image" });
      await screen.approve();
      Object.assign(screen.host.device, { displays: displays.slice(0, 2) });
      await screen.discover(); await screen.synchronize();
      expect(control.value).toBe(displays[2].id);
      expect(control.selectedOptions[0].disabled).toBe(true);
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      expect(screen.host.requests).toHaveLength(1);
    } finally { await screen.close(); }
  });

  test("repeated user shares proceed directly with native approval and never add an extension confirmation", async () => {
    const screen = await widget();
    try {
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.element("badge").textContent).toBe("Capturing");
      expect(screen.element("status").textContent).toContain("Capturing on your desktop");
      expect(screen.element("status").textContent).not.toContain("Preview, then Share");
      const queries = screen.host.gets.length;
      await screen.discover(); expect(screen.host.gets).toHaveLength(queries);
      await screen.approve();
      const status = screen.element("status").textContent;
      await screen.discover();
      expect(screen.element("status").textContent).toBe(status);
      screen.advanceClock();
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests).toHaveLength(2); expect(screen.host.generations).toHaveLength(2);
      expect(screen.host.released).toHaveLength(2);
      expect(screen.host.requests.every((entry) => entry.deviceId === "desktop-a" && !Object.hasOwn(entry, "remember"))).toBe(true);
    } finally { await screen.close(); }
  });

  test("discovery pauses in hidden documents and stops on disposal", async () => {
    const screen = await widget();
    try {
      Object.defineProperty(screen.dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
      const queries = screen.host.gets.length;
      await screen.discover(); expect(screen.host.gets).toHaveLength(queries);
      screen.view.dispose(); screen.settings.dispose();
      Object.defineProperty(screen.dom.window.document, "visibilityState", { configurable: true, value: "visible" });
      await screen.discover();
      screen.dom.window.dispatchEvent(new screen.dom.window.Event("focus")); await settle();
      expect(screen.host.gets).toHaveLength(queries); expect(screen.host.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("discovery timeout recovers without clearing replies or accepting a late device result", async () => {
    const screen = await widget();
    const pending = deferred<typeof screen.host.device[]>();
    const listing = screen.host.mutable.desktop.capture.listDevices;
    try {
      screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      screen.host.mutable.desktop.capture.listDevices = async () => pending.promise;
      await screen.discover(); await screen.expireDiscovery();
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      expect(screen.element<HTMLButtonElement>("check-devices").disabled).toBe(false);
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
      pending.resolve([screen.host.device]); await settle();
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      screen.host.mutable.desktop.capture.listDevices = listing;
      await screen.discover();
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
      expect(screen.host.requests).toHaveLength(1); expect(screen.host.generations).toHaveLength(1);
    } finally { pending.resolve([]); await screen.close(); }
  });

  test("sidebar edits immediately synchronize after saving to a different widget document", async () => {
    const screen = await widget();
    try {
      expect(screen.view.panel.querySelectorAll("select,input,textarea")).toHaveLength(0);
      const question = screen.element<HTMLTextAreaElement>("question");
      question.value = "What catches your eye?"; question.dispatchEvent(new screen.dom.window.Event("input"));
      await screen.synchronize();
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      const observe = screen.outgoing.find((entry) => entry.type === "observe");
      expect(observe.question).toBe("What catches your eye?");
      expect(screen.settings.panel.querySelector<HTMLSelectElement>('[data-role="character"]')!.disabled).toBe(true);
      await screen.approve();
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
      expect(screen.settings.panel.querySelector('[data-role="status"]')!.textContent).toBe("");
    } finally { await screen.close(); }
  });

  test("an unavailable saved desktop never silently switches to another available device", async () => {
    const screen = await widget();
    try {
      const saved = screen.host.sent.filter((entry) => entry.payload.type === "state" && entry.options?.frontendSessionId === "session-b").at(-1)!.payload;
      screen.message({ ...saved, snapshot: { ...saved.snapshot, sequence: saved.snapshot.sequence + 100,
        settings: { ...saved.snapshot.settings, deviceId: "disconnected-desktop" } } });
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(true);
      expect(screen.host.requests).toHaveLength(0);
    } finally { await screen.close(); }
  });

  test("reopening a native widget restores shared configuration and reply without replaying paid speech", async () => {
    const screen = await widget(); let reopened: ReturnType<typeof mountView> | null = null;
    try {
      await screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      reopened = mountView(screen.context("session-c"), screen.dom.window.document.querySelector("main")!);
      await settle();
      expect(reopened.panel.querySelector('[data-role="reply"]')!.textContent).toBe("You have a calendar open.");
      expect(reopened.panel.querySelector('[data-role="speaker"]')!.textContent).toContain("Mira");
      expect(reopened.panel.querySelectorAll("select,input,textarea")).toHaveLength(0);
      expect(screen.speechCalls).toHaveLength(1);
      expect(reopened.panel.querySelector('[data-role="speech-status"]')!.textContent).toContain("Speaking in another companion window");
      reopened.panel.querySelector<HTMLButtonElement>('[data-role="stop-speech"]')!.click(); await settle();
      expect(screen.isSpeaking()).toBe(false);
      reopened.panel.querySelector<HTMLButtonElement>('[data-role="clear"]')!.click(); await settle();
      expect(screen.element("reply").textContent).not.toContain("calendar");
    } finally { reopened?.dispose(); await screen.close(); }
  });

  test("another widget mirrors and cancels a pending transcription without starting its own microphone", async () => {
    const transcription = deferred<Response>(); const screen = await widget({ stt: transcription.promise });
    const other = mountView(screen.context("session-c"), screen.dom.window.document.querySelector("main")!);
    try {
      await settle(); await screen.enable("voice-input");
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(other.panel.querySelector<HTMLButtonElement>('[data-role="observe"]')!.disabled).toBe(true);
      expect(other.panel.querySelector('[data-role="badge"]')!.textContent).toBe("Transcribing");
      other.panel.querySelector<HTMLButtonElement>('[data-role="cancel"]')!.click(); await settle();
      expect(screen.recognitions[0].options.signal?.aborted).toBe(true);
      transcription.resolve(Response.json({ text: "Too late" })); await settle();
      expect(screen.microphoneRequests()).toBe(1); expect(screen.host.requests).toHaveLength(0);
      expect(other.panel.querySelector<HTMLButtonElement>('[data-role="observe"]')!.disabled).toBe(false);
    } finally { transcription.resolve(Response.json({ text: "Too late" })); other.dispose(); await screen.close(); }
  });

  test("defaults to text-only with no microphone or paid TTS on load or share", async () => {
    const screen = await widget();
    try {
      expect(screen.element<HTMLInputElement>("auto-speak").checked).toBe(false);
      expect(screen.element<HTMLInputElement>("voice-input").checked).toBe(false);
      expect(screen.microphoneRequests()).toBe(0);
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests).toHaveLength(1); expect(screen.host.generations).toHaveLength(0);
      await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.speechCalls).toHaveLength(0);
      expect(screen.microphoneRequests()).toBe(0); expect(screen.element("reply").textContent).toBe("You have a calendar open.");
    } finally { await screen.close(); }
  });
  test("one main action runs silence-ended STT, approved capture, character generation, and TTS exactly once", async () => {
    const screen = await widget();
    try {
      await screen.enable("auto-speak"); await screen.enable("voice-input");
      screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.microphoneRequests()).toBe(1); expect(screen.tracksStopped()).toBeGreaterThan(0);
      expect(screen.recognitions).toHaveLength(1); expect(screen.host.requests).toHaveLength(1);
      expect(screen.host.generations).toHaveLength(0); expect(screen.speechCalls).toHaveLength(0);
      expect(screen.element<HTMLInputElement>("auto-speak").disabled).toBe(true);
      await screen.approve();
      expect(screen.host.generations).toHaveLength(1);
      expect(screen.host.generations[0].messages.at(-1)!.content[0].text).toBe("What do you think?");
      expect(screen.speechCalls).toHaveLength(1); expect(screen.playback()).toBe(1);
      expect(screen.speechCalls[0]).toMatchObject({ input: { text: "You have a calendar open." }, options: { connectionId: "voice-a" } });
      screen.message(screen.host.sent.find((entry) => entry.payload.type === "complete")?.payload); await settle();
      expect(screen.speechCalls).toHaveLength(1);
      expect(screen.host.sent.every((entry) => ["session-a", "session-b"].includes(entry.options?.frontendSessionId ?? "") && entry.userId === "user-a")).toBe(true);
    } finally { await screen.close(); }
  });
  test("Stop prevents pending automatic speech without cancelling the character's text", async () => {
    const screen = await widget();
    try {
      await screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle();
      screen.element<HTMLButtonElement>("stop-speech").click(); await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.speechCalls).toHaveLength(0);
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
    } finally { await screen.close(); }
  });
  test("cancelled STT cannot open screen consent, dispatch generation, or speak a late reply", async () => {
    const transcription = deferred<Response>(); const screen = await widget({ stt: transcription.promise });
    try {
      await screen.enable("voice-input"); await screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.recognitions).toHaveLength(1);
      screen.element<HTMLButtonElement>("cancel").click();
      expect(screen.recognitions[0].options.signal?.aborted).toBe(true);
      transcription.resolve(Response.json({ text: "Too late" })); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0); expect(screen.speechCalls).toHaveLength(0);
      expect(screen.element<HTMLButtonElement>("observe").disabled).toBe(false);
    } finally { transcription.resolve(Response.json({ text: "Too late" })); await screen.close(); }
  });
  test("microphone denial stops before screen capture rather than silently running a different request", async () => {
    const screen = await widget({ microphoneDenied: true });
    try {
      await screen.enable("voice-input"); screen.element<HTMLButtonElement>("observe").click(); await settle();
      expect(screen.host.requests).toHaveLength(0); expect(screen.host.generations).toHaveLength(0);
      expect(screen.element("status").textContent).toContain("Microphone access was declined");
    } finally { await screen.close(); }
  });
  test("host playback failure keeps text and does not retry synthesis", async () => {
    const screen = await widget({ autoplayBlocked: true });
    try {
      await screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.speechCalls).toHaveLength(1); expect(screen.isSpeaking()).toBe(false);
      expect(screen.view.panel.querySelector("audio")).toBeNull();
      expect(screen.element("speech-status").textContent).toContain("Audio playback was blocked");
    } finally { await screen.close(); }
  });
  test("TTS failure retains generated text without restarting generation", async () => {
    const screen = await widget({ tts: Promise.resolve(new Response("PRIVATE_PROVIDER_ERROR", { status: 502 })) });
    try {
      await screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      expect(screen.host.generations).toHaveLength(1); expect(screen.speechCalls).toHaveLength(1);
      expect(screen.element("reply").textContent).toBe("You have a calendar open.");
      expect(screen.element("speech-status").textContent).not.toContain("PRIVATE_PROVIDER_ERROR");
    } finally { await screen.close(); }
  });
  test("Clear aborts pending auto-TTS and discards late audio", async () => {
    const synthesis = deferred<Response>(); const screen = await widget({ tts: synthesis.promise });
    try {
      await screen.enable("auto-speak"); screen.element<HTMLButtonElement>("observe").click(); await settle(); await screen.approve();
      screen.element<HTMLButtonElement>("clear").click();
      expect(screen.speechCalls[0].stopped).toBe(true);
      synthesis.resolve(new Response("audio", { headers: { "Content-Type": "audio/wav" } })); await settle();
      expect(screen.playback()).toBe(0); expect(screen.isSpeaking()).toBe(false);
      expect(screen.view.panel.querySelector("audio")).toBeNull();
    } finally { synthesis.resolve(new Response()); await screen.close(); }
  });
});
