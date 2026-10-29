// src/settings.ts
var DEFAULT_SETTINGS = Object.freeze({
  characterId: "",
  connectionId: "",
  deviceId: "",
  kind: "image",
  durationSeconds: 3,
  question: "",
  autoSpeak: false,
  voiceInput: false,
  sttProvider: "connection",
  sttId: "",
  ttsId: "",
  voice: "",
  speed: 1
});
function parseSettingsPatch(value) {
  if (!record(value) || Object.keys(value).length === 0 || Object.keys(value).length > Object.keys(DEFAULT_SETTINGS).length)
    return null;
  const patch = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key))
      return null;
    if (["characterId", "connectionId", "deviceId", "sttId", "ttsId"].includes(key)) {
      if (setting !== "" && !identifier(setting))
        return null;
    } else if (key === "kind") {
      if (setting !== "image" && setting !== "video")
        return null;
    } else if (key === "sttProvider") {
      if (setting !== "connection" && setting !== "whistle" && setting !== "webspeech")
        return null;
    } else if (key === "autoSpeak" || key === "voiceInput") {
      if (typeof setting !== "boolean")
        return null;
    } else if (key === "question" || key === "voice") {
      if (typeof setting !== "string" || setting.length > (key === "question" ? MAX_QUESTION : 256))
        return null;
    } else if (typeof setting !== "number" || !Number.isFinite(setting) || (key === "speed" ? setting < 0.25 || setting > 4 : !Number.isInteger(setting) || setting < 1 || setting > 30))
      return null;
    patch[key] = setting;
  }
  return patch;
}

// src/protocol.ts
var CHANNEL = "desk-companion/v1";
var MAX_QUESTION = 1200;
var REQUIRED_PERMISSIONS = ["ui_panels", "characters", "generation", "screen_capture"];
function createMessageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function safeLabel(value, maximum = 120) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, maximum);
}

// src/capture-flow.ts
var CAPTURE_PENDING = "Capturing on your desktop. If native setup opens, choose a source and optionally remember it for future shares. Use the native Stop & Discard control to stop.";

// src/speech.ts
var MAX_SPEECH_CHARS = 2400;
function speechAPI(ctx) {
  return (ctx.host.capabilities["text-to-speech-v1"] ?? 0) >= 1 && ctx.tts ? ctx.tts : undefined;
}
async function listSpeechConnections(ctx, signal) {
  if (signal.aborted)
    throw new DOMException("Aborted", "AbortError");
  if ((ctx.host.capabilities["connection-kinds-v1"] ?? 0) < 1 || !ctx.connections)
    throw new Error("Update Lumiverse to list speech connections through Spindle.");
  const rows = await ctx.connections.list({ kind: "tts" });
  if (signal.aborted)
    throw new DOMException("Aborted", "AbortError");
  return rows.filter((entry) => entry.kind === "tts" && identifier(entry.id)).slice(0, 100).map((entry) => ({ id: entry.id, name: safeLabel(entry.name), provider: safeLabel(entry.provider), voice: (entry.voice ?? "").slice(0, 256) }));
}
async function speakReply(text, connectionId, signal, api, onSpeaking) {
  if (signal.aborted)
    throw new DOMException("Aborted", "AbortError");
  if (!text.trim() || text.length > MAX_SPEECH_CHARS || !identifier(connectionId)) {
    throw new Error("Speech requires a valid connection and a reply of at most 2,400 characters.");
  }
  if (!api)
    throw new Error("Update Lumiverse to use speech playback through Spindle.");
  const cancel = () => {
    try {
      api.stop();
    } catch {}
  };
  const unsubscribe = api.subscribe((speaking) => {
    if (!signal.aborted)
      onSpeaking?.(speaking);
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await api.speak({ text }, { connectionId });
    if (signal.aborted)
      throw new DOMException("Aborted", "AbortError");
  } catch (error) {
    if (signal.aborted || error instanceof Error && error.name === "AbortError")
      throw new DOMException("Aborted", "AbortError");
    throw new Error("Speech could not play. Check Media permission, enable TTS in Voice & Speech, and check the selected connection.");
  } finally {
    signal.removeEventListener("abort", cancel);
    unsubscribe();
  }
}

// src/speech-input.ts
var aborted = () => new DOMException("Aborted", "AbortError");
function speechInputAPI(ctx) {
  return (ctx.host.capabilities["speech-to-text-v1"] ?? 0) >= 1 && ctx.stt && typeof ctx.stt.listProviders === "function" && typeof ctx.stt.start === "function" ? ctx.stt : undefined;
}
function transcriptionProviders(api) {
  if (!api)
    return ["whistle", "connection", "webspeech"].map((id) => ({
      id,
      name: id === "whistle" ? "Whistle (on this device)" : id === "webspeech" ? "Web Speech" : "STT connection",
      onDevice: id === "whistle",
      available: false,
      unavailableReason: "hostUpdate",
      supportsAudioTranscription: false
    }));
  return api.listProviders();
}
async function listTranscriptionConnections(ctx, signal) {
  if (signal.aborted)
    throw aborted();
  if ((ctx.host.capabilities["connection-kinds-v1"] ?? 0) < 1 || !ctx.connections)
    throw new Error("Update Lumiverse to list STT connections through Spindle.");
  const rows = await ctx.connections.list({ kind: "stt" });
  if (signal.aborted)
    throw aborted();
  return rows.filter((entry) => entry.kind === "stt" && identifier(entry.id)).slice(0, 100).map((entry) => ({ id: entry.id, name: safeLabel(entry.name), provider: safeLabel(entry.provider) }));
}
function recognitionError(error, provider, signal) {
  if (signal.aborted || error instanceof Error && error.name === "AbortError")
    return aborted();
  if (error instanceof Error && error.message.startsWith("PERMISSION_DENIED"))
    return new Error("Grant the extension's Media permission before using voice input.");
  if (error instanceof Error && error.name === "NotAllowedError")
    return new Error("Microphone access was declined or is unavailable in this window.");
  return new Error(provider === "whistle" ? "Whistle could not transcribe your question. Check its availability in Voice & Speech settings." : "Speech recognition could not finish. Check microphone access and the selected provider in Voice & Speech settings.");
}
function recognizeQuestion(provider, connectionId, signal, api, onStatus) {
  if (signal.aborted)
    throw aborted();
  if (!["whistle", "connection", "webspeech"].includes(provider) || provider === "connection" && !identifier(connectionId))
    throw new Error("Choose an STT provider and, when required, an STT connection.");
  if (!api)
    throw new Error("Update Lumiverse to use voice input through Spindle.");
  let session;
  try {
    session = api.start({
      provider,
      signal,
      continuous: false,
      interimResults: false,
      onStatus: (status) => {
        if (!signal.aborted)
          onStatus?.(status);
      },
      ...provider === "connection" ? { connectionId } : {}
    });
  } catch (error) {
    throw recognitionError(error, provider, signal);
  }
  return finishQuestion(session, provider, signal);
}
async function finishQuestion(session, provider, signal) {
  let cancelled = false;
  const cancelSession = () => {
    if (cancelled)
      return;
    cancelled = true;
    try {
      session.cancel();
    } catch {}
  };
  const cancel = () => {
    cancelSession();
    rejectCancellation(aborted());
  };
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const completed = Promise.all([session.ready, session.result]);
    if (signal.aborted)
      cancel();
    const [, transcript] = await Promise.race([completed, cancellation]);
    if (signal.aborted)
      throw aborted();
    if (!record(transcript) || typeof transcript.text !== "string" || !transcript.text.trim() || transcript.text.length > MAX_QUESTION) {
      throw new Error("No usable question was recognized, or it exceeded 1,200 characters. Try a shorter voice input.");
    }
    return transcript.text.trim();
  } catch (error) {
    cancelSession();
    if (error instanceof Error && error.message.startsWith("No usable question"))
      throw error;
    throw recognitionError(error, provider, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

// src/share-workflow.ts
async function prepareShareQuestion(question, spoken, signal) {
  if (signal.aborted)
    throw new DOMException("Aborted", "AbortError");
  if (question.length > MAX_QUESTION)
    throw new Error("The written question exceeds 1,200 characters.");
  const transcript = await spoken;
  if (signal.aborted)
    throw new DOMException("Aborted", "AbortError");
  const combined = [question.trim(), transcript.trim()].filter(Boolean).join(`

`);
  if (combined.length > MAX_QUESTION)
    throw new Error("The combined written and spoken question exceeds 1,200 characters.");
  return combined;
}

class AutomaticShareSpeech {
  pending = null;
  arm(requestId, voice) {
    this.pending = voice ? { requestId, voice: { ...voice } } : null;
  }
  take(requestId) {
    if (this.pending?.requestId !== requestId)
      return null;
    const voice = this.pending.voice;
    this.pending = null;
    return voice;
  }
  cancel() {
    this.pending = null;
  }
}

// src/shortcuts.ts
var SHARE_COMMAND = "share-screen";
var QUICK_SHARE_COMMAND = "share-screen-without-voice";

// src/shared-ui.ts
function bindField(state, mount) {
  const initial = state();
  const handle = mount(initial);
  let previous = JSON.stringify(initial);
  return {
    sync(force = false) {
      const next = state();
      const serialized = JSON.stringify(next);
      if (force || previous !== serialized) {
        handle.update(next);
        previous = serialized;
      }
    },
    destroy: () => handle.destroy()
  };
}
function mountSharedFields(ctx, root, selectOptions) {
  const bindings = [];
  const components = ctx.components;
  for (const control of root.querySelectorAll("select,input,textarea")) {
    const target = document.createElement("span");
    target.className = "dc-control";
    control.after(target);
    let binding;
    const emit = (value) => {
      if (control.disabled)
        return;
      if (control instanceof control.ownerDocument.defaultView.HTMLInputElement && control.type === "checkbox")
        control.checked = Boolean(value);
      else {
        const text = value === null ? "" : String(value);
        const limit = control.tagName === "TEXTAREA" ? control.maxLength : -1;
        control.value = limit < 0 ? text : text.slice(0, limit);
      }
      const Event = control.ownerDocument.defaultView.Event;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof value === "string" && control.value !== value)
        binding?.sync(true);
    };
    const ariaLabel = control.getAttribute("aria-label") ?? undefined;
    try {
      if (control.tagName === "SELECT" && components?.mountSelect) {
        const select = control;
        const state = () => ({
          value: select.value,
          disabled: select.disabled,
          placeholder: select.options[0]?.value === "" ? select.options[0].textContent ?? "Choose…" : "Choose…",
          options: Array.from(select.options).filter((option) => option.value).map((option) => ({ value: option.value, label: option.textContent ?? option.value, disabled: option.disabled })),
          ...selectOptions?.(select)
        });
        binding = bindField(state, (options) => components.mountSelect(target, { ...options, ariaLabel, onChange: emit }));
      } else if (control.tagName === "TEXTAREA" && components?.mountTextArea) {
        binding = bindField(() => ({ value: control.value, disabled: control.disabled }), (options) => components.mountTextArea(target, { ...options, ariaLabel, rows: 3, placeholder: control.getAttribute("placeholder") ?? "", onChange: emit }));
      } else if (control.tagName === "INPUT" && control.type === "number" && components?.mountNumericInput) {
        const input = control;
        binding = bindField(() => ({ value: input.value === "" ? null : Number(input.value), disabled: input.disabled }), (options) => components.mountNumericInput(target, { ...options, ariaLabel, min: Number(input.min), max: Number(input.max), step: 1, integer: true, onChange: emit }));
      } else if (control.tagName === "INPUT" && control.type === "checkbox" && components?.mountSwitch) {
        const input = control;
        binding = bindField(() => ({ checked: input.checked, disabled: input.disabled }), (options) => components.mountSwitch(target, { ...options, ariaLabel, size: "sm", onChange: emit }));
      }
      if (!binding) {
        target.remove();
        continue;
      }
      control.hidden = true;
      const mounted = binding;
      bindings.push({ sync: (force) => mounted.sync(force), destroy() {
        mounted.destroy();
        target.remove();
        control.hidden = false;
      } });
    } catch {
      binding?.destroy();
      target.remove();
      control.hidden = false;
    }
  }
  return { sync: () => {
    for (const binding of bindings)
      binding.sync();
  }, destroy: () => {
    for (const binding of bindings.splice(0).reverse())
      binding.destroy();
  } };
}
function mountSharedBadge(ctx, fallback) {
  if (!ctx.components?.mountBadge)
    return { sync() {}, destroy() {} };
  const target = document.createElement("span");
  target.className = "dc-badge-host";
  fallback.after(target);
  try {
    const state = () => ({ text: fallback.textContent ?? "", color: fallback.dataset.busy === "true" ? "primary" : fallback.textContent === "Ready" ? "success" : "neutral", size: "pill" });
    const handle = ctx.components.mountBadge(target, state());
    fallback.hidden = true;
    let previous = JSON.stringify(state());
    return { sync() {
      const next = state();
      if (JSON.stringify(next) !== previous) {
        handle.update(next);
        previous = JSON.stringify(next);
      }
    }, destroy() {
      handle.destroy();
      target.remove();
      fallback.hidden = false;
    } };
  } catch {
    target.remove();
    return { sync() {}, destroy() {} };
  }
}
function mountSharedSections(ctx, root) {
  const cleanups = [];
  if (ctx.components?.mountCollapsibleSection)
    for (const details of root.querySelectorAll("details[data-shared-section]")) {
      const summary = details.querySelector("summary");
      const target = document.createElement("div");
      details.before(target);
      try {
        const handle = ctx.components.mountCollapsibleSection(target, { title: summary.textContent ?? "Help", defaultExpanded: details.open });
        for (const child of Array.from(details.childNodes))
          if (child !== summary)
            handle.body.append(child);
        details.remove();
        cleanups.push(() => {
          handle.destroy();
          target.remove();
        });
      } catch {
        target.remove();
      }
    }
  return () => {
    for (const cleanup of cleanups.splice(0).reverse())
      cleanup();
  };
}

// src/companion-view.ts
var SETTINGS_DEBOUNCE_MS = 300;
function mountView(ctx, root, options = {}) {
  const surface = options.surface ?? "widget";
  const clientId = createMessageId();
  const panel = document.createElement("section");
  panel.className = surface === "widget" ? "dc-shell dc-widget" : "dc-shell dc-settings";
  panel.setAttribute("aria-label", "Desk Companion");
  panel.innerHTML = `
    <header class="dc-header"><h2>Desk Companion</h2><span class="dc-badge" data-role="badge">Ready</span><button class="dc-icon-button" data-role="settings" type="button" aria-label="Companion settings" title="Settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg></button></header>
    <div data-view="configuration">
      <div class="dc-tabs" role="tablist" aria-label="Companion settings">
        <button role="tab" data-tab="companion" aria-selected="true" type="button">Companion</button>
        <button role="tab" data-tab="speech" aria-selected="false" tabindex="-1" type="button">Speech</button>
        <button role="tab" data-tab="shortcuts" aria-selected="false" tabindex="-1" type="button">Shortcuts</button>
      </div>
      <div data-pane="companion" role="tabpanel" tabindex="0">
        <div class="dc-field"><span>Character</span><select class="dc-native" data-role="character" aria-label="Character"><option value="">Choose a character</option></select></div>
        <div class="dc-field"><span>Model connection</span><select class="dc-native" data-role="connection" aria-label="Model connection"><option value="">Choose a model connection</option></select></div>
        <div class="dc-field"><span>Desktop</span><select class="dc-native" data-role="device" aria-label="Desktop device"><option value="">Choose a desktop</option></select></div>
        <div class="dc-grid"><div class="dc-field"><span>Capture</span><select class="dc-native" data-role="kind" aria-label="Capture type"><option value="image">Screenshot</option><option value="video">Video clip</option></select></div><div class="dc-field" data-role="duration-field" hidden><span>Clip length (seconds)</span><input class="dc-native" data-role="duration" aria-label="Clip duration" type="number" min="1" max="30" step="1" value="3" disabled></div></div>
        <p class="dc-note" data-role="capture-readiness" aria-live="polite"></p>
        <div class="dc-field"><span>Question or direction <span class="dc-optional">Optional</span></span><textarea class="dc-native" data-role="question" aria-label="Optional question or direction" placeholder="What would you like your character to react to?" maxlength="1200"></textarea></div>
        <details data-shared-section><summary>Screen capture setup</summary>
          <p class="dc-note">Enable screen capture in Desktop, then choose a source on your first share. Select Remember to reuse it.</p>
          <p class="dc-note">To change a saved source, use Forget Screen Capture Approvals in the Desktop tray. Desktop also manages capture permissions and paused requests.</p>
        </details>
      </div>
      <div data-pane="speech" role="tabpanel" tabindex="0" hidden>
        <section class="dc-group" aria-labelledby="${clientId}-input-title">
          <div class="dc-toggle-row"><div><h3 id="${clientId}-input-title">Voice input</h3><p class="dc-note">Add a spoken question before capture.</p></div><input class="dc-native" data-role="voice-input" aria-label="Voice input" type="checkbox"></div>
          <div data-role="voice-options" hidden>
            <div class="dc-field"><span>Speech recognition</span><select class="dc-native" data-role="stt-provider" aria-label="STT provider"><option value="connection">STT connection</option><option value="whistle">Whistle (on this device)</option><option value="webspeech">Web Speech</option></select></div>
            <div class="dc-field" data-role="stt-connection"><span>STT connection</span><select class="dc-native" data-role="stt" aria-label="STT connection"><option value="">Choose an STT connection</option></select></div>
            <p class="dc-note" data-role="stt-guidance"></p>
          </div>
          <p class="dc-note" data-role="input-status" role="status"></p>
        </section>
        <section class="dc-group" data-role="speech-options" aria-labelledby="${clientId}-output-title">
          <div class="dc-toggle-row"><div><h3 id="${clientId}-output-title">Spoken replies</h3><p class="dc-note">Read your character's replies automatically.</p></div><input class="dc-native" data-role="auto-speak" aria-label="Automatic spoken replies" type="checkbox"></div>
          <div class="dc-field"><span>Voice connection</span><select class="dc-native" data-role="tts" aria-label="TTS connection"><option value="">Choose a TTS connection</option></select></div>
          <button data-role="character-voice" type="button">Use character's voice</button>
          <p class="dc-note" data-role="tts-guidance"></p>
        </section>
        <div class="dc-note" data-role="speech-status" role="status" aria-live="polite"></div>
      </div>
      <div data-pane="shortcuts" role="tabpanel" tabindex="0" hidden>
        <div data-role="shortcuts">
          <div data-role="shortcut-editors" hidden><div class="dc-field"><span>Action</span><select class="dc-native" data-role="shortcut-action" aria-label="Shortcut action"><option value="share-screen">Share screen</option><option value="share-screen-without-voice">Share without voice input</option></select></div><div class="dc-keybindings" data-role="keybinding-editor"></div></div>
          <p class="dc-note" data-role="shortcut-help">Open Lumiverse Desktop to configure keyboard shortcuts.</p>
        </div>
      </div>
      <footer class="dc-footer"><span data-role="sync-status" role="status">Connecting…</span><div class="dc-row"><button data-role="refresh" type="button">Refresh</button><button data-role="grant" type="button">Permissions</button></div></footer>
      <div class="dc-row"><button data-role="cancel" type="button" hidden>Cancel request</button><button data-role="stop-speech" type="button" hidden>Stop speech</button></div>
    </div>
    <div data-view="triggers">
      <p class="dc-note" data-role="capture-readiness" aria-live="polite" hidden></p>
      <button data-role="check-devices" type="button" hidden>Check desktops</button>
      <div class="dc-row dc-actions"><button class="dc-primary" data-role="observe" type="button" disabled>Look at my screen</button><button data-role="cancel" type="button" hidden>Cancel</button></div>
      <div class="dc-reply"><div class="dc-reply-name" data-role="speaker" hidden></div><div class="dc-reply-text" data-role="reply">Share your screen to hear from your character.</div></div>
      <footer class="dc-reply-actions"><button data-role="speak" type="button" hidden>Speak reply</button><button data-role="stop-speech" type="button" hidden>Stop speech</button><button data-role="clear" type="button" hidden>Clear</button></footer>
      <div class="dc-note" data-role="speech-status" role="status" aria-live="polite"></div>
    </div>
    <div class="dc-status" data-role="status" role="status" aria-live="polite">Connecting…</div>`;
  const configuration = panel.querySelector('[data-view="configuration"]');
  const triggers = panel.querySelector('[data-view="triggers"]');
  if (surface === "widget")
    configuration.remove();
  else
    triggers.remove();
  if (surface === "settings")
    panel.querySelector('[data-role="settings"]').hidden = true;
  for (const button of panel.querySelectorAll("button"))
    button.classList.add("dc-button");
  const elements = new Map;
  for (const container of [panel, configuration, triggers])
    for (const child of container.querySelectorAll("[data-role]")) {
      if (!elements.has(child.dataset.role))
        elements.set(child.dataset.role, child);
    }
  root.append(panel);
  function element(role) {
    const found = elements.get(role);
    if (!found)
      throw new Error("Desk Companion UI could not mount.");
    return found;
  }
  const character = element("character");
  const connection = element("connection");
  const device = element("device");
  const kind = element("kind");
  const duration = element("duration");
  const question = element("question");
  const tts = element("tts");
  const outputAPI = speechAPI(ctx);
  const autoSpeak = element("auto-speak");
  const voiceInput = element("voice-input");
  const stt = element("stt");
  const sttProvider = element("stt-provider");
  const inputAPI = speechInputAPI(ctx);
  let inputProviders = [];
  const status = element("status");
  const reply = element("reply");
  const badge = element("badge");
  let disposed = false;
  let disposing = false;
  let granted = [];
  let catalog = null;
  let catalogId = null;
  let devicesId = null;
  let devicesTimeout = null;
  let catalogTimeout = null;
  let approvalQuery = null;
  let approval = null;
  let approvalCheckedKey = "";
  let shortcutsMounted = false;
  const shortcutCleanups = [];
  let canShare = false;
  let canQuickShare = false;
  let runId = null;
  let stage = "idle";
  let completedText = "";
  let completedVoice = null;
  let speechConnections = [];
  let transcriptionConnections = [];
  let inputController = null;
  let inputMessage = "";
  const automaticSpeech = new AutomaticShareSpeech;
  let speechController = null;
  let snapshot = null;
  let pendingPatch = {};
  let saving = null;
  let saveTimer = null;
  let saveTimeout = null;
  let subscription = null;
  let pendingBegin = null;
  let initializeVoice = false;
  let automaticRequestId = null;
  const listingController = new AbortController;
  const cleanups = [];
  const destroySections = surface === "settings" ? mountSharedSections(ctx, configuration) : () => {};
  const knownCharacters = new Map;
  let characterChoices = [];
  let characterOffset = 0;
  let characterTotal = 0;
  let characterSearch = "";
  let characterRequest = null;
  let searchTimer = null;
  const paginatedPicker = typeof ctx.components?.mountSelect === "function" && (ctx.host.capabilities["shared-select-pagination-v1"] ?? 0) >= 1;
  const remoteCharacterSearch = () => paginatedPicker && catalog?.characterSearch === true;
  const searchCharacters = (query) => {
    query = query.trim().slice(0, 200);
    if (!remoteCharacterSearch() || query === characterSearch || disposed || isBusy() || !granted.includes("characters"))
      return;
    characterSearch = query;
    if (searchTimer !== null)
      window.clearTimeout(searchTimer);
    resetCharacterRequest();
    characterChoices = [];
    characterOffset = 0;
    characterTotal = 0;
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      loadCharacters(true);
    }, 200);
    updateControls();
  };
  const loadMoreCharacters = () => loadCharacters();
  const fields = mountSharedFields(ctx, surface === "settings" ? configuration : document.createElement("div"), (control) => control !== character ? {} : {
    options: characterOptions(),
    forceSearch: true,
    searchPlaceholder: "Search characters…",
    remoteSearch: remoteCharacterSearch(),
    onSearchChange: searchCharacters,
    loading: catalogId !== null || characterRequest !== null || searchTimer !== null,
    hasMore: characterOffset < characterTotal,
    onLoadMore: loadMoreCharacters,
    loadMoreOnScroll: true,
    emptyMessage: "No characters found",
    loadMoreLabel: "Load more characters"
  });
  const sharedBadge = mountSharedBadge(ctx, badge);
  cleanups.push(destroySections, () => fields.destroy(), () => sharedBadge.destroy());
  const tabs = Array.from(configuration.querySelectorAll("[role=tab]"));
  function activateTab(tab) {
    for (const button of tabs) {
      const active = button === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const pane of configuration.querySelectorAll("[data-pane]"))
      pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  }
  for (const [index, tab] of tabs.entries()) {
    const pane = configuration.querySelector(`[data-pane="${tab.dataset.tab}"]`);
    tab.id = `${clientId}-tab-${index}`;
    pane.id = `${clientId}-pane-${index}`;
    tab.setAttribute("aria-controls", pane.id);
    pane.setAttribute("aria-labelledby", tab.id);
    listen(tab, "click", () => activateTab(tab));
    const navigate = (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0)
        return;
      event.preventDefault();
      activateTab(tabs[next]);
      tabs[next].focus();
    };
    tab.addEventListener("keydown", navigate);
    cleanups.push(() => tab.removeEventListener("keydown", navigate));
  }
  function resetCharacterRequest() {
    if (characterRequest)
      window.clearTimeout(characterRequest.timer);
    characterRequest = null;
  }
  function characterOptions(selectedId = character.value) {
    const choices = [...characterChoices];
    const selected = knownCharacters.get(selectedId);
    if (selected && !choices.some((entry) => entry.id === selected.id))
      choices.unshift(selected);
    return choices.map((entry) => ({
      value: entry.id,
      label: entry.name,
      leading: { type: "image", src: entry.avatarUrl ?? "", fallback: { text: entry.name.slice(0, 1) } }
    }));
  }
  function syncCharacters(preferred = character.value || settings().characterId) {
    const choices = characterOptions(preferred);
    fill(character, choices.map((entry) => ({ id: entry.value, label: entry.label })), "Choose a character", preferred);
  }
  function loadCharacters(first = false) {
    if (disposed || surface !== "settings" || !catalog || catalogId || characterRequest || searchTimer !== null || isBusy() || !granted.includes("characters") || !granted.includes("ui_panels") || !first && characterOffset >= characterTotal)
      return;
    const offset = first ? 0 : characterOffset;
    const id = send({ type: "characters", offset, search: remoteCharacterSearch() ? characterSearch : "" });
    const timer = window.setTimeout(() => {
      if (characterRequest?.id !== id)
        return;
      characterRequest = null;
      notice("Characters could not be loaded. Refresh to try again.", true);
      updateControls();
    }, 8000);
    characterRequest = { id, offset, search: characterSearch, timer };
    updateControls();
  }
  function mountShortcuts() {
    if (surface !== "settings" || shortcutsMounted || !snapshot)
      return;
    shortcutsMounted = true;
    const help = element("shortcut-help");
    if (!snapshot.shortcutsAvailable) {
      help.textContent = "Update the Lumiverse backend for shortcuts scoped to this account and Desktop window. Button sharing remains available.";
      return;
    }
    if (!ctx.client?.getInfo().bridges.desktop)
      return;
    if (!ctx.components?.mountKeybindingEditor) {
      help.textContent = "Configure these Desk Companion actions in Desktop Settings → Key Bindings, or update Desktop to edit them here.";
      return;
    }
    try {
      const commandId = element("shortcut-action").value === QUICK_SHARE_COMMAND ? QUICK_SHARE_COMMAND : SHARE_COMMAND;
      const editor = ctx.components.mountKeybindingEditor(element("keybinding-editor"), { commandId });
      shortcutCleanups.push(() => editor.destroy());
      element("shortcut-editors").hidden = false;
      help.textContent = "Share screen uses your speech settings. The second action skips voice input.";
    } catch {
      for (const cleanup of shortcutCleanups.splice(0))
        cleanup();
      help.textContent = "The shortcut editor could not open. Configure Desk Companion in Desktop Settings → Key Bindings, then reopen this panel.";
    }
  }
  function approvalKey() {
    const current = settings();
    return JSON.stringify([current.deviceId, current.connectionId, current.kind]);
  }
  function discoverApproval(force = false) {
    const current = settings();
    const key = approvalKey();
    if (disposed || isBusy() || approvalQuery || !snapshot || saving || Object.keys(pendingPatch).length || !catalog?.devices.some((entry) => entry.id === current.deviceId) || !current.connectionId || !granted.includes("generation") || !granted.includes(current.kind === "video" ? "screen_recording" : "screen_capture") || !force && approvalCheckedKey === key)
      return;
    const id = createMessageId();
    const timer = window.setTimeout(() => {
      approvalQuery = null;
      approval = null;
      if (!disposed)
        updateControls();
    }, 12000);
    approvalCheckedKey = key;
    approvalQuery = { id, key, timer };
    send({ type: "approval", deviceId: current.deviceId, connectionId: current.connectionId, kind: current.kind }, id);
  }
  function listen(target, event, handler) {
    target.addEventListener(event, handler);
    cleanups.push(() => target.removeEventListener(event, handler));
  }
  function send(body, id = createMessageId()) {
    try {
      ctx.sendToBackend({ channel: CHANNEL, clientId, id, ...body });
    } catch (error) {
      if (!disposing)
        throw error;
    }
    return id;
  }
  function settings() {
    return { ...DEFAULT_SETTINGS, ...snapshot?.settings, ...saving?.patch, ...pendingPatch };
  }
  const settingsControls = [
    { key: "characterId", control: character },
    { key: "connectionId", control: connection },
    { key: "deviceId", control: device },
    { key: "kind", control: kind },
    { key: "durationSeconds", control: duration },
    { key: "question", control: question },
    { key: "autoSpeak", control: autoSpeak },
    { key: "voiceInput", control: voiceInput },
    { key: "sttProvider", control: sttProvider },
    { key: "sttId", control: stt },
    { key: "ttsId", control: tts }
  ];
  function applySettings() {
    const current = settings();
    if (knownCharacters.has(current.characterId))
      syncCharacters(current.characterId);
    for (const { key, control } of settingsControls) {
      if (key === "autoSpeak" || key === "voiceInput")
        control.checked = current[key];
      else {
        control.value = String(current[key]);
        if (!current[key] && control.tagName === "SELECT" && control.options.length === 2)
          control.selectedIndex = 1;
      }
    }
  }
  function retainSettingsEdits() {
    if (saveTimeout !== null)
      window.clearTimeout(saveTimeout);
    saveTimeout = null;
    if (saving)
      pendingPatch = { ...saving.patch, ...pendingPatch };
    saving = null;
  }
  function subscribe() {
    if (disposed || disposing || subscription)
      return;
    const id = createMessageId();
    const timer = window.setTimeout(() => {
      subscription = null;
      if (!disposed) {
        notice("Desk Companion could not reconnect. Refresh to try again; your edits are kept in this window.", true);
        updateControls();
      }
    }, 8000);
    subscription = { id, timer };
    send({ type: "subscribe", surface }, id);
    updateControls();
  }
  function flushSettings() {
    if (disposed || saveTimer !== null || !snapshot || subscription || saving || !Object.keys(pendingPatch).length)
      return;
    const patch = pendingPatch;
    pendingPatch = {};
    const id = createMessageId();
    saving = { id, patch };
    saveTimeout = window.setTimeout(() => {
      saveTimeout = null;
      if (disposed || saving?.id !== id)
        return;
      retainSettingsEdits();
      subscribe();
    }, 8000);
    send({ type: "configure", patch }, id);
    updateControls();
  }
  function queueSettings(patch) {
    if (surface !== "settings" || disposed || !snapshot || !parseSettingsPatch(patch))
      return;
    const current = settings();
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => current[key] !== value));
    if (!Object.keys(changed).length)
      return;
    pendingPatch = { ...pendingPatch, ...changed };
    if (saveTimer !== null)
      window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      flushSettings();
    }, SETTINGS_DEBOUNCE_MS);
    updateControls();
  }
  function chooseDefaults() {
    if (!snapshot || surface !== "settings" || isBusy())
      return;
    const current = settings();
    const patch = {};
    for (const { key, control } of settingsControls) {
      if (["characterId", "connectionId", "deviceId", "sttId", "ttsId"].includes(key) && !current[key] && control.value) {
        Object.assign(patch, { [key]: control.value });
      }
    }
    if (Object.keys(patch).length)
      queueSettings(patch);
  }
  function notice(text, error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.dataset.error = String(error);
  }
  function fill(select, choices, placeholder, preferred) {
    const previous = preferred ?? select.value;
    select.replaceChildren(new Option(placeholder, ""));
    for (const choice of choices)
      select.append(new Option(choice.label, choice.id));
    if (choices.some((choice) => choice.id === previous))
      select.value = previous;
    else if (!previous && choices.length === 1)
      select.value = choices[0].id;
  }
  function selectedCharacter() {
    return knownCharacters.get(character.value);
  }
  function isBusy() {
    return runId !== null || inputController !== null || Boolean(snapshot && snapshot.activity.stage !== "idle");
  }
  function updateDevices(devices) {
    if (!catalog)
      return;
    catalog.devices = devices;
    const savedId = settings().deviceId;
    fill(device, devices.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.platform}` })), "Choose a desktop", savedId);
    if (savedId && !devices.some((entry) => entry.id === savedId)) {
      const unavailable = new Option("Saved desktop unavailable — choose a connected desktop", savedId);
      unavailable.disabled = true;
      device.append(unavailable);
      device.value = savedId;
    }
    chooseDefaults();
  }
  function applyCharacterVoice(silent = false) {
    const chosen = surface === "settings" ? selectedCharacter()?.voice : completedVoice ?? selectedCharacter()?.voice;
    if (chosen && speechConnections.some((entry) => entry.id === chosen.connectionId)) {
      tts.value = chosen.connectionId;
      queueSettings({ ttsId: tts.value });
      if (!silent)
        element("speech-status").textContent = "Character voice selected.";
    } else {
      if (!silent)
        element("speech-status").textContent = "Choose a voice connection; this character has none available.";
    }
    updateControls();
  }
  function initializeCharacterVoice() {
    if (!initializeVoice || surface !== "settings" || !selectedCharacter() || !speechConnections.length)
      return;
    initializeVoice = false;
    applyCharacterVoice(true);
  }
  function discoverInputProviders() {
    try {
      inputProviders = transcriptionProviders(inputAPI);
    } catch {
      inputProviders = [];
    }
    for (const option of sttProvider.options) {
      const provider = inputProviders.find((entry) => entry.id === option.value);
      option.disabled = !provider || !provider.available && !(provider.id === "connection" && provider.unavailableReason === "connectionRequired");
      option.textContent = `${provider?.name ?? (option.value === "whistle" ? "Whistle (on this device)" : option.value === "webspeech" ? "Web Speech" : "STT connection")}${option.disabled ? " · unavailable" : ""}`;
    }
  }
  function updateControls() {
    const busy = isBusy();
    const current = settings();
    const chosenConnection = catalog?.connections.find((entry) => entry.id === connection.value);
    const chosenDevice = catalog?.devices.find((entry) => entry.id === device.value);
    const video = kind.value === "video";
    const hasGrants = REQUIRED_PERMISSIONS.filter((permission) => permission !== "screen_capture" || !video).every((permission) => granted.includes(permission)) && (!video || granted.includes("screen_recording"));
    const supported = video ? chosenConnection?.video && chosenDevice?.video : chosenConnection?.image && chosenDevice?.image;
    const validDuration = Number.isInteger(Number(duration.value)) && Number(duration.value) >= 1 && Number(duration.value) <= 30;
    const validVoice = Boolean(outputAPI) && granted.includes("media") && speechConnections.some((entry) => entry.id === tts.value);
    const provider = inputProviders.find((entry) => entry.id === sttProvider.value);
    const connectionInput = sttProvider.value === "connection";
    const providerReady = provider?.available || connectionInput && provider?.unavailableReason === "connectionRequired";
    const validInput = Boolean(providerReady) && Boolean(inputAPI) && granted.includes("media") && (!connectionInput || transcriptionConnections.some((entry) => entry.id === stt.value));
    for (const control of [character, connection, device, kind, question, tts, autoSpeak, sttProvider, stt])
      control.disabled = busy;
    voiceInput.disabled = busy || !inputAPI;
    element("voice-options").hidden = !voiceInput.checked;
    element("stt-connection").hidden = !connectionInput;
    element("tts-guidance").textContent = !outputAPI ? "Update Lumiverse to enable spoken replies." : !granted.includes("media") ? "Use Permissions to grant Media for speech playback." : "Voice and playback settings are managed in Voice & Speech.";
    element("stt-guidance").textContent = inputAPI && !granted.includes("media") ? "Use Permissions to grant Media for voice input." : !providerReady ? provider?.unavailableReason === "hostUpdate" ? "Update Lumiverse to use speech recognition through Spindle." : "Unavailable in this window. Choose another provider or check Voice & Speech." : connectionInput ? "Audio is sent to this connection. Listening ends on silence." : sttProvider.value === "whistle" ? "On-device recognition. Listening ends on silence." : "Uses your browser or device's speech engine. Listening ends on silence.";
    duration.disabled = busy || !video;
    element("duration-field").hidden = !video;
    const needsSettings = !hasGrants || !supported || !character.value || !current.characterId || !current.connectionId || !current.deviceId || character.value !== current.characterId || connection.value !== current.connectionId || device.value !== current.deviceId || question.value.length > MAX_QUESTION || video && !validDuration || autoSpeak.checked && !validVoice;
    const blocked = !snapshot || subscription !== null || busy || saving !== null || Object.keys(pendingPatch).length > 0 || needsSettings;
    canQuickShare = !blocked;
    canShare = !blocked && (!voiceInput.checked || validInput);
    element("observe").disabled = surface !== "widget" || !canShare;
    element("observe").textContent = video ? "Share a video clip" : "Look at my screen";
    element("cancel").disabled = !busy || stage === "cancelling";
    element("cancel").hidden = !busy;
    const speaking = speechController !== null || Boolean(snapshot && snapshot.activity.speechStage !== "idle");
    element("stop-speech").hidden = !speaking;
    element("speak").hidden = !completedText || speaking || !validVoice;
    element("clear").hidden = !completedText || busy;
    element("speaker").hidden = !completedText && !snapshot?.activity.text;
    reply.parentElement.dataset.empty = String(!completedText && !busy);
    element("speak").disabled = busy || !completedText || !validVoice || speechController !== null || completedText.length > MAX_SPEECH_CHARS;
    element("character-voice").disabled = busy;
    element("refresh").disabled = busy || catalogId !== null || devicesId !== null;
    element("grant").disabled = busy;
    element("check-devices").hidden = surface !== "widget" || busy || Boolean(chosenDevice) || !hasGrants;
    element("check-devices").disabled = catalogId !== null || devicesId !== null;
    badge.dataset.busy = String(busy);
    badge.textContent = busy ? stage === "listening" ? "Listening" : stage === "transcribing" ? "Transcribing" : stage === "consent" ? "Capturing" : stage === "generating" ? "Thinking" : stage === "cancelling" ? "Cancelling" : "Checking" : subscription ? "Reconnecting" : !snapshot ? "Connecting" : !hasGrants ? "Permissions" : !catalog ? "Loading" : saving || Object.keys(pendingPatch).length ? "Saving" : needsSettings || voiceInput.checked && !validInput ? "Setup needed" : "Ready";
    const nativeStatus = approval?.key === approvalKey() ? approval.status : null;
    const readiness = element("capture-readiness");
    readiness.textContent = !hasGrants ? "Grant permissions to enable screen sharing." : !catalog ? "Finding desktops…" : !chosenDevice ? current.deviceId ? "Your saved desktop is offline. Reconnect it or choose a desktop in Settings." : "Set Up Screen Capture in Lumiverse Desktop to connect a desktop." : chosenConnection && !supported ? `This model or desktop does not support ${video ? "video clips" : "screenshots"}. Change the model or capture type in Settings.` : autoSpeak.checked && !validVoice ? "Choose a voice connection in Speech, or turn off spoken replies." : voiceInput.checked && !validInput ? "Check speech recognition in Speech, or turn off voice input." : needsSettings ? "Choose a character, model connection, and desktop in Settings." : nativeStatus?.approval === "paused" ? "Capture requests are paused. Resume them in the Desktop tray." : nativeStatus?.approval === "unavailable" ? "Cannot check capture approval. Check Desktop's connection." : nativeStatus?.source === "permission_required" ? "Desktop needs screen-recording permission. Open native capture setup." : nativeStatus?.source === "missing" ? "Your saved source is unavailable. Choose a source on your next share." : nativeStatus?.approval === "remembered" && nativeStatus.source === "ready" ? "Screen source remembered." : nativeStatus?.approval === "required" ? "Choose a screen source on your next share." : "";
    const needsAttention = !hasGrants || !catalog || !chosenDevice || needsSettings || voiceInput.checked && !validInput || nativeStatus?.approval === "paused" || nativeStatus?.approval === "unavailable" || nativeStatus?.source === "permission_required" || nativeStatus?.source === "missing";
    readiness.hidden = busy || !readiness.textContent || surface === "widget" && !needsAttention;
    element("sync-status").textContent = subscription ? "Reconnecting…" : !snapshot ? "Connecting…" : saving || Object.keys(pendingPatch).length ? "Saving…" : "Saved";
    fields.sync();
    sharedBadge.sync();
    discoverApproval();
  }
  function stopSpeech() {
    if (element("speech-status").dataset.shared === "true")
      element("speech-status").textContent = "";
    element("speech-status").dataset.shared = "false";
    speechController?.abort();
    speechController = null;
    if (!disposed && snapshot?.activity.requestId)
      send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
    updateControls();
  }
  function clearReply(clearAutomatic = true) {
    if (clearAutomatic)
      automaticSpeech.cancel();
    element("input-status").textContent = "";
    stopSpeech();
    completedText = "";
    completedVoice = null;
    reply.textContent = "Share your screen to hear from your character.";
    element("speaker").textContent = "A fresh perspective";
    element("speech-status").textContent = "";
    updateControls();
  }
  function cancel(shared = true) {
    automaticSpeech.cancel();
    inputController?.abort();
    stopSpeech();
    if (runId && stage !== "cancelling") {
      send({ type: "cancel", targetId: runId });
      stage = "cancelling";
      notice("Generation is being cancelled. A pending native capture must be stopped with the native panel's Stop & Discard control.");
      updateControls();
    }
    const targetId = pendingBegin?.id ?? snapshot?.activity.requestId;
    if (targetId && snapshot?.activity.stage !== "idle" && (shared || snapshot?.activity.ownerClientId === clientId)) {
      send({ type: "cancel-shared", targetId });
    }
  }
  function refresh(page = 0) {
    if (disposed || catalogId || devicesId)
      return;
    discoverInputProviders();
    if (!REQUIRED_PERMISSIONS.filter((permission) => permission !== "screen_capture").every((permission) => granted.includes(permission)) || !granted.includes("screen_capture") && !granted.includes("screen_recording")) {
      notice("Grant UI Panels, Characters, Generation, and at least one capture permission using Permissions.");
      return;
    }
    if (searchTimer !== null)
      window.clearTimeout(searchTimer);
    searchTimer = null;
    resetCharacterRequest();
    catalogId = send({ type: "catalog", page, activeCharacterId: settings().characterId || character.value || ctx.getActiveChat().characterId || undefined });
    catalogTimeout = window.setTimeout(() => {
      catalogId = null;
      catalogTimeout = null;
      if (!disposed) {
        notice("Desktop discovery did not finish. Check your connection, then Refresh in Settings.", true);
        updateControls();
      }
    }, 8000);
    updateControls();
  }
  function discoverDevices() {
    if (disposed || document.visibilityState === "hidden" || isBusy() || !catalog || catalogId || devicesId || !granted.includes("generation") || !granted.includes("characters") || !granted.includes("ui_panels") || !granted.includes("screen_capture") && !granted.includes("screen_recording"))
      return;
    devicesId = send({ type: "devices" });
    devicesTimeout = window.setTimeout(() => {
      devicesId = null;
      devicesTimeout = null;
      if (!disposed) {
        updateDevices([]);
        updateControls();
      }
    }, 8000);
    updateControls();
  }
  async function speak(selectedVoice) {
    if (!completedText || !selectedVoice && !tts.value || speechController || disposed)
      return;
    stopSpeech();
    const controller = new AbortController;
    speechController = controller;
    const timer = window.setTimeout(() => {
      if (speechController === controller) {
        stopSpeech();
        if (!disposed)
          element("speech-status").textContent = "Speech stopped or timed out.";
      }
    }, 45000);
    element("speech-status").textContent = "Synthesizing with your selected TTS connection…";
    if (snapshot?.activity.requestId)
      send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "synthesizing" });
    updateControls();
    try {
      await speakReply(completedText, (selectedVoice ?? { connectionId: tts.value }).connectionId, controller.signal, outputAPI, (speaking) => {
        if (disposed || controller.signal.aborted || speechController !== controller)
          return;
        if (snapshot?.activity.requestId)
          send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: speaking ? "playing" : "idle" });
        element("speech-status").textContent = speaking ? "Preparing or playing through Lumiverse. Use Stop speech or the host's audio controls." : "Speech finished.";
      });
      if (!disposed && !controller.signal.aborted && speechController === controller) {
        element("speech-status").textContent = "Speech finished.";
        if (snapshot?.activity.requestId)
          send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
      }
    } catch (error) {
      if (!disposed && snapshot?.activity.requestId)
        send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
      if (!disposed && speechController === controller)
        element("speech-status").textContent = controller.signal.aborted ? "Speech stopped or timed out." : error instanceof Error ? error.message : "Speech could not finish.";
    } finally {
      window.clearTimeout(timer);
      if (speechController === controller)
        speechController = null;
      if (!disposed)
        updateControls();
    }
  }
  const unsubscribe = ctx.onBackendMessage((payload) => {
    if (disposed || !record(payload) || payload.channel !== CHANNEL || payload.clientId !== clientId || typeof payload.id !== "string")
      return;
    const message = payload;
    if (message.type === "shortcut") {
      updateControls();
      if (message.skipVoice ? canQuickShare : canShare)
        share({ shortcut: true, skipVoice: message.skipVoice });
      else if (!isBusy()) {
        notice("Shortcut could not start. Finish setup in Desk Companion and wait for settings to save, then press it again.", true);
        options.openSettings?.();
      }
      return;
    }
    if (message.id === approvalQuery?.id) {
      const queried = approvalQuery;
      approvalQuery = null;
      window.clearTimeout(queried.timer);
      if (queried.key === approvalKey())
        approval = message.type === "approval" ? { key: queried.key, status: message.status } : null;
      updateControls();
      return;
    }
    if (message.type === "open-settings") {
      options.openSettings?.();
      return;
    }
    if (message.type === "stop-local") {
      if (message.targetId === automaticRequestId) {
        automaticSpeech.cancel();
        automaticRequestId = null;
      }
      stopSpeech();
      if (!message.speechOnly && (message.targetId === pendingBegin?.id || message.targetId === snapshot?.activity.requestId))
        inputController?.abort();
      return;
    }
    if (message.type === "error" && message.code === "SESSION_REQUIRED") {
      retainSettingsEdits();
      if (pendingBegin) {
        const pending = pendingBegin;
        pendingBegin = null;
        pending.reject(new Error("Desk Companion is reconnecting. Share again once it is ready."));
      }
      automaticSpeech.cancel();
      inputController?.abort();
      speechController?.abort();
      subscribe();
      return;
    }
    if (message.id === subscription?.id) {
      window.clearTimeout(subscription.timer);
      subscription = null;
      if (message.type === "error") {
        notice(message.message, true);
        updateControls();
        return;
      }
    }
    if (message.type === "state") {
      const incoming = message.snapshot;
      if (saving?.id === message.id) {
        if (saveTimeout !== null)
          window.clearTimeout(saveTimeout);
        saveTimeout = null;
        saving = null;
      }
      if (pendingBegin?.id === message.id && snapshot && incoming.epoch === snapshot.epoch && incoming.sequence <= snapshot.sequence) {
        const pending = pendingBegin;
        pendingBegin = null;
        if (snapshot.activity.requestId === pending.id && snapshot.activity.ownerClientId === clientId && snapshot.activity.stage !== "idle")
          pending.resolve();
        else
          pending.reject(new Error("The shared workflow changed before this widget could start."));
      }
      if (snapshot && incoming.epoch === snapshot.epoch && incoming.sequence <= snapshot.sequence) {
        flushSettings();
        updateControls();
        return;
      }
      const first = !snapshot;
      if (first)
        initializeVoice = !incoming.settings.ttsId;
      const restarted = Boolean(snapshot && incoming.epoch !== snapshot.epoch);
      if (restarted) {
        automaticSpeech.cancel();
        automaticRequestId = null;
        inputController?.abort();
        stopSpeech();
        runId = null;
        retainSettingsEdits();
        catalogId = null;
        devicesId = null;
        catalog = null;
        if (approvalQuery)
          window.clearTimeout(approvalQuery.timer);
        approvalQuery = null;
        approval = null;
        approvalCheckedKey = "";
        for (const cleanup of shortcutCleanups.splice(0))
          cleanup();
        shortcutsMounted = false;
        if (catalogTimeout !== null)
          window.clearTimeout(catalogTimeout);
        if (searchTimer !== null)
          window.clearTimeout(searchTimer);
        searchTimer = null;
        resetCharacterRequest();
        if (devicesTimeout !== null)
          window.clearTimeout(devicesTimeout);
      }
      const oldCharacter = snapshot?.settings.characterId;
      snapshot = incoming;
      mountShortcuts();
      applySettings();
      chooseDefaults();
      stage = incoming.activity.stage;
      completedText = stage === "idle" ? incoming.activity.text : "";
      completedVoice = incoming.activity.voice;
      reply.textContent = incoming.activity.text || "Share your screen to hear from your character.";
      element("speaker").textContent = incoming.activity.characterName;
      notice(inputController && incoming.activity.ownerClientId === clientId && inputMessage && !incoming.activity.error ? inputMessage : incoming.activity.stage === "idle" && incoming.activity.text && !incoming.activity.error ? "" : incoming.activity.message, incoming.activity.error);
      if (incoming.activity.speechClientId !== clientId && incoming.activity.speechStage !== "idle") {
        element("speech-status").textContent = `${incoming.activity.speechStage === "playing" ? "Speaking" : incoming.activity.speechStage === "ready" ? "Audio is ready" : "Synthesizing speech"} in another companion window.`;
        element("speech-status").dataset.shared = "true";
      } else if (element("speech-status").dataset.shared === "true") {
        element("speech-status").textContent = "";
        element("speech-status").dataset.shared = "false";
      }
      if (pendingBegin?.id === message.id) {
        const pending = pendingBegin;
        pendingBegin = null;
        if (incoming.activity.requestId === pending.id && incoming.activity.ownerClientId === clientId && stage !== "idle")
          pending.resolve();
        else
          pending.reject(new Error("Settings changed. Review the synchronized configuration and try again."));
      }
      if (first || restarted || oldCharacter !== incoming.settings.characterId && !knownCharacters.has(incoming.settings.characterId))
        refresh(0);
      if (catalog && incoming.settings.deviceId && !catalog.devices.some((entry) => entry.id === incoming.settings.deviceId))
        discoverDevices();
      flushSettings();
      updateControls();
      return;
    }
    if (message.type === "error" && pendingBegin?.id === message.id) {
      const pending = pendingBegin;
      pendingBegin = null;
      pending.reject(new Error(message.message));
      return;
    }
    if (message.type === "error" && saving?.id === message.id) {
      if (saveTimeout !== null)
        window.clearTimeout(saveTimeout);
      saveTimeout = null;
      saving = null;
      pendingPatch = {};
      applySettings();
      notice(message.message, true);
      updateControls();
      return;
    }
    if (message.id === devicesId) {
      devicesId = null;
      if (devicesTimeout !== null) {
        window.clearTimeout(devicesTimeout);
        devicesTimeout = null;
      }
      if (message.type === "devices" && JSON.stringify(message.devices) !== JSON.stringify(catalog?.devices))
        updateDevices(message.devices);
      else if (message.type === "error")
        updateDevices([]);
      discoverApproval(true);
      updateControls();
      return;
    }
    if (message.id === characterRequest?.id) {
      const request = characterRequest;
      resetCharacterRequest();
      if (message.type === "characters" && message.search === request.search) {
        for (const entry of message.characters)
          knownCharacters.set(entry.id, entry);
        const merged = new Map((request.offset === 0 ? [] : characterChoices).map((entry) => [entry.id, entry]));
        for (const entry of message.characters)
          merged.set(entry.id, entry);
        characterChoices = [...merged.values()];
        characterTotal = message.total;
        characterOffset = message.nextOffset > request.offset ? message.nextOffset : message.total;
        syncCharacters();
      } else if (message.type === "error")
        notice("Characters could not be loaded. Refresh to try again.", true);
      updateControls();
      if (message.type === "characters" && !remoteCharacterSearch())
        loadCharacters();
      return;
    }
    if (message.id === catalogId) {
      if (catalogTimeout !== null) {
        window.clearTimeout(catalogTimeout);
        catalogTimeout = null;
      }
      if (message.type === "catalog") {
        catalog = message.catalog;
        catalogId = null;
        for (const entry of catalog.characters)
          knownCharacters.set(entry.id, entry);
        characterChoices = catalog.characters;
        characterOffset = catalog.characterNextOffset;
        characterTotal = catalog.characterTotal;
        const current = settings();
        const preferred = current.characterId || ctx.getActiveChat().characterId || undefined;
        fill(character, catalog.characters.map((entry) => ({ id: entry.id, label: entry.name })), "Choose a character", preferred);
        fill(connection, catalog.connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.model}` })), "Choose a model connection", current.connectionId);
        updateDevices(catalog.devices);
        if (!snapshot?.activity.requestId && !isBusy())
          notice("");
        chooseDefaults();
        initializeCharacterVoice();
        if (characterSearch && remoteCharacterSearch()) {
          characterChoices = [];
          characterOffset = 0;
          characterTotal = 0;
          loadCharacters(true);
        } else if (!remoteCharacterSearch())
          loadCharacters();
      } else if (message.type === "error") {
        catalogId = null;
        notice(message.message, true);
      }
      updateControls();
      return;
    }
    if (message.id !== runId)
      return;
    if (message.type === "status") {
      stage = message.stage;
      const messages = {
        checking: "Verifying the character, model, and desktop for your account…",
        consent: CAPTURE_PENDING,
        generating: "The approved capture is attached privately. Your character is thinking…",
        cancelling: "Generation cancelled. Use Stop & Discard in any native capture panel still open; waiting for that request to finish."
      };
      notice(messages[message.stage]);
    } else if (message.type === "text" && stage !== "cancelling")
      reply.textContent = message.text;
    else if (message.type === "complete") {
      const chosenVoice = automaticSpeech.take(message.id);
      automaticRequestId = null;
      if (stage === "cancelling") {
        runId = null;
        stage = "idle";
        clearReply();
        notice("Observation cancelled; no automatic speech.");
        updateControls();
        return;
      }
      runId = null;
      stage = "idle";
      completedText = message.text;
      completedVoice = message.voice;
      reply.textContent = message.text;
      element("speaker").textContent = message.characterName;
      notice("");
      if (message.text.length > MAX_SPEECH_CHARS)
        element("speech-status").textContent = "Reply exceeds the 2,400-character speech limit. Ask for a shorter answer.";
      else if (chosenVoice)
        speak(chosenVoice);
    } else if (message.type === "error") {
      runId = null;
      stage = "idle";
      clearReply();
      notice(message.message, true);
    }
    updateControls();
  });
  cleanups.push(unsubscribe);
  async function share(trigger = {}) {
    if (!(trigger.skipVoice ? canQuickShare : canShare) || surface !== "widget" && !trigger.shortcut)
      return;
    send({ type: "subscribe", surface });
    const selectedVoice = autoSpeak.checked ? { connectionId: tts.value, voice: "" } : null;
    const requestId = createMessageId();
    stopSpeech();
    automaticSpeech.arm(requestId, selectedVoice);
    automaticRequestId = requestId;
    const request = {
      type: "observe",
      characterId: character.value,
      connectionId: connection.value,
      deviceId: device.value,
      kind: kind.value,
      durationSeconds: Number(duration.value),
      question: question.value
    };
    const includeVoice = voiceInput.checked && !trigger.skipVoice;
    const inputProvider = sttProvider.value;
    const controller = new AbortController;
    inputController = controller;
    inputMessage = "";
    const timer = window.setTimeout(() => controller.abort(), 60000);
    let dispatched = false;
    let failureMessage = "Share stopped before requesting screen capture.";
    updateControls();
    try {
      const reservation = new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => finish(new Error("Share cancelled."));
        const reservationTimer = window.setTimeout(() => finish(new Error("The companion did not synchronize. Refresh before sharing.")), 1e4);
        const finish = (error) => {
          if (settled)
            return;
          settled = true;
          window.clearTimeout(reservationTimer);
          controller.signal.removeEventListener("abort", abort);
          if (pendingBegin?.id === requestId)
            pendingBegin = null;
          if (error)
            reject(error);
          else
            resolve();
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        pendingBegin = { id: requestId, resolve: () => finish(), reject: (error) => finish(error) };
        send({ type: "begin-share", revision: snapshot.revision }, requestId);
      });
      reservation.catch(() => {});
      const beginInput = () => {
        stage = "listening";
        inputMessage = "Listening… pause when you finish.";
        notice(inputMessage);
        updateControls();
        return prepareShareQuestion(request.question, recognizeQuestion(inputProvider, stt.value, controller.signal, inputAPI, (status) => {
          if (disposed || controller.signal.aborted || inputController !== controller)
            return;
          stage = status.phase === "processing" ? "transcribing" : "listening";
          send({ type: "input-stage", targetId: requestId, stage });
          inputMessage = status.phase === "loading" ? `Loading ${inputProvider === "whistle" ? "Whistle on this device" : "speech recognition"}${typeof status.progress === "number" ? ` · ${Math.round(Math.max(0, Math.min(1, status.progress)) * 100)}%` : ""}…` : status.phase === "processing" ? "Transcribing your question…" : "Listening… pause when you finish.";
          notice(inputMessage);
          updateControls();
        }), controller.signal);
      };
      const questionReady = includeVoice && !trigger.shortcut ? beginInput() : null;
      questionReady?.catch(() => {});
      await reservation;
      if (disposed || controller.signal.aborted)
        return;
      clearReply(false);
      if (includeVoice)
        request.question = await (questionReady ?? beginInput());
      if (disposed || controller.signal.aborted)
        return;
      if (includeVoice)
        element("input-status").textContent = `Included question: ${request.question}`;
      inputController = null;
      stage = "checking";
      runId = send(request, requestId);
      dispatched = true;
    } catch (error) {
      automaticSpeech.cancel();
      failureMessage = controller.signal.aborted ? "Share cancelled or voice input timed out. Nothing was requested from a model." : error instanceof Error ? error.message : "Voice input could not finish; no screen capture was requested.";
      controller.abort();
      if (!disposed) {
        stage = "idle";
        notice(failureMessage, true);
      }
    } finally {
      window.clearTimeout(timer);
      if (!dispatched && !disposed)
        send({ type: "input-ended", targetId: requestId, message: failureMessage.slice(0, 400) });
      if (inputController === controller)
        inputController = null;
      if (!disposed)
        updateControls();
    }
  }
  listen(element("observe"), "click", () => {
    share();
  });
  listen(element("cancel"), "click", () => cancel());
  listen(element("clear"), "click", () => {
    cancel();
    clearReply();
    send({ type: "clear-state" });
  });
  listen(element("refresh"), "click", () => {
    retainSettingsEdits();
    subscribe();
    refresh();
  });
  listen(element("check-devices"), "click", () => {
    if (catalog)
      discoverDevices();
    else
      refresh();
  });
  listen(element("shortcut-action"), "change", () => {
    for (const cleanup of shortcutCleanups.splice(0))
      cleanup();
    shortcutsMounted = false;
    mountShortcuts();
  });
  listen(element("speak"), "click", () => {
    speak();
  });
  listen(element("stop-speech"), "click", () => {
    automaticSpeech.cancel();
    stopSpeech();
    send({ type: "stop-speech" });
    element("speech-status").textContent = "Speech stopped; pending automatic speech is disabled for this share.";
  });
  listen(element("settings"), "click", () => {
    options.openSettings ? options.openSettings() : send({ type: "open-settings" });
  });
  listen(element("character-voice"), "click", () => applyCharacterVoice());
  for (const { key, control } of settingsControls)
    listen(control, "input", () => {
      const value = key === "autoSpeak" || key === "voiceInput" ? control.checked : ["durationSeconds"].includes(key) ? Number(control.value) : control.value;
      queueSettings({ [key]: value });
      if (key === "characterId") {
        clearReply();
        applyCharacterVoice();
      }
      updateControls();
    });
  listen(element("grant"), "click", () => {
    ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording", "media"], { reason: "Desk Companion uses Media for optional voice input and playback, plus grants to select a character, request desktop capture with native approval, and ask your chosen model." }).then((permissions) => {
      if (!disposed) {
        granted = permissions;
        refresh();
        updateControls();
      }
    }).catch(() => {
      if (!disposed)
        notice("Permission request was declined. An administrator/owner must approve capture grants.", true);
    });
  });
  cleanups.push(ctx.events.on("SPINDLE_PERMISSION_CHANGED", (payload) => {
    if (!record(payload) || payload.extensionId !== ctx.host.extensionInstallationId)
      return;
    if (approvalQuery)
      window.clearTimeout(approvalQuery.timer);
    approvalQuery = null;
    approval = null;
    approvalCheckedKey = "";
    if (payload.granted === false) {
      if (searchTimer !== null)
        window.clearTimeout(searchTimer);
      searchTimer = null;
      resetCharacterRequest();
      catalogId = null;
      catalog = null;
      knownCharacters.clear();
      characterChoices = [];
      characterTotal = 0;
      characterOffset = 0;
      fill(character, [], "Choose a character");
      cancel();
      clearReply();
    }
    ctx.permissions.getGranted().then((permissions) => {
      if (!disposed) {
        granted = permissions;
        refresh();
        updateControls();
      }
    }).catch(() => {});
  }));
  ctx.permissions.getGranted().then((permissions) => {
    if (!disposed) {
      granted = permissions;
      subscribe();
      updateControls();
    }
  }).catch(() => {
    if (!disposed)
      notice("Cannot read grants. Check the extension's permissions.", true);
  });
  const listingTimeout = window.setTimeout(() => listingController.abort(), 15000);
  const speechListing = listSpeechConnections(ctx, listingController.signal).then((connections) => {
    if (disposed)
      return;
    speechConnections = connections;
    fill(tts, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose a TTS connection", settings().ttsId);
    chooseDefaults();
    initializeCharacterVoice();
    updateControls();
  }).catch(() => {
    if (!disposed)
      element("speech-status").textContent = "Voice connections could not be loaded. Reopen settings to retry.";
  });
  discoverInputProviders();
  const inputListing = listTranscriptionConnections(ctx, listingController.signal).then((connections) => {
    if (disposed)
      return;
    transcriptionConnections = connections;
    fill(stt, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose an STT connection", settings().sttId);
    chooseDefaults();
    updateControls();
  }).catch(() => {
    if (!disposed)
      element("input-status").textContent = "STT connections could not be loaded. Choose Whistle or reopen settings to retry.";
  });
  Promise.allSettled([speechListing, inputListing]).finally(() => window.clearTimeout(listingTimeout));
  const resynchronize = () => {
    if (disposed || disposing)
      return;
    retainSettingsEdits();
    if (subscription)
      window.clearTimeout(subscription.timer);
    subscription = null;
    if (catalogTimeout !== null)
      window.clearTimeout(catalogTimeout);
    if (devicesTimeout !== null)
      window.clearTimeout(devicesTimeout);
    catalogTimeout = null;
    devicesTimeout = null;
    catalogId = null;
    devicesId = null;
    if (approvalQuery)
      window.clearTimeout(approvalQuery.timer);
    approvalQuery = null;
    approval = null;
    approvalCheckedKey = "";
    subscribe();
    refresh();
    updateControls();
  };
  cleanups.push(ctx.events.on("CONNECTED", (payload) => {
    if (record(payload) && typeof payload.role === "string" && payload.role.length > 0)
      resynchronize();
  }));
  const restorePage = (event) => {
    if (event.persisted)
      resynchronize();
  };
  const refreshAvailability = () => {
    if (disposed || document.visibilityState === "hidden")
      return;
    discoverInputProviders();
    if (catalog)
      discoverDevices();
    else
      refresh();
    updateControls();
  };
  window.addEventListener("pageshow", restorePage);
  document.addEventListener("visibilitychange", refreshAvailability);
  window.addEventListener("focus", refreshAvailability);
  cleanups.push(() => {
    window.removeEventListener("pageshow", restorePage);
    document.removeEventListener("visibilitychange", refreshAvailability);
    window.removeEventListener("focus", refreshAvailability);
  });
  updateControls();
  return { panel, dispose: () => {
    if (disposed || disposing)
      return;
    disposing = true;
    cancel(false);
    send({ type: "unsubscribe" });
    disposed = true;
    listingController.abort();
    stopSpeech();
    pendingBegin?.reject(new Error("Companion window closed."));
    pendingBegin = null;
    if (saveTimer !== null)
      window.clearTimeout(saveTimer);
    if (saveTimeout !== null)
      window.clearTimeout(saveTimeout);
    if (subscription)
      window.clearTimeout(subscription.timer);
    subscription = null;
    if (devicesTimeout !== null)
      window.clearTimeout(devicesTimeout);
    if (catalogTimeout !== null)
      window.clearTimeout(catalogTimeout);
    if (searchTimer !== null)
      window.clearTimeout(searchTimer);
    resetCharacterRequest();
    if (approvalQuery)
      window.clearTimeout(approvalQuery.timer);
    window.clearTimeout(listingTimeout);
    for (const cleanup of shortcutCleanups.splice(0))
      cleanup();
    for (const cleanup of cleanups.splice(0))
      cleanup();
    completedText = "";
    completedVoice = null;
    catalog = null;
    panel.replaceChildren();
    panel.remove();
  } };
}

// src/styles.ts
var STYLES = `
.dc-shell,.dc-about { box-sizing:border-box; color:var(--lumiverse-text,#eeeaf8); font:calc(13px * var(--lumiverse-font-scale,1))/1.5 system-ui,-apple-system,sans-serif; }
.dc-shell *,.dc-about * { box-sizing:border-box; }
.dc-shell [hidden],.dc-about [hidden] { display:none!important; }
.dc-shell { width:100%; height:100%; min-height:0; max-height:100%; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; touch-action:pan-y; user-select:text; scrollbar-width:thin; padding:16px; }
.dc-widget { display:flex; flex-direction:column; background:var(--lumiverse-bg-elevated,#1c1923); }
.dc-settings { height:auto; max-height:none; overflow:visible; padding:0; }
.dc-header { display:flex; gap:10px; align-items:center; min-height:32px; margin-bottom:16px; }
.dc-header h2 { font-size:16px; font-weight:600; letter-spacing:-.3px; margin:0; }
.dc-badge,.dc-badge-host { margin-left:auto; flex-shrink:0; }
.dc-badge { color:var(--lumiverse-text-muted,#b5afc2); font-size:11px; padding:2px 8px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:20px; }
.dc-note { margin:6px 0; color:var(--lumiverse-text-dim,#9e97ad); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.dc-note:empty,.dc-status:empty { display:none; }
.dc-field { display:flex; flex-direction:column; min-width:0; gap:6px; margin:0 0 16px; font-size:13px; }
.dc-field > span:first-child { color:var(--lumiverse-text-muted,#b5afc2); font-weight:500; }
.dc-optional { margin-left:6px; color:var(--lumiverse-text-dim,#9e97ad); font-size:11px; font-weight:400; }
.dc-control { display:block; min-width:0; width:100%; }
.dc-native:not([type=checkbox]) { display:block; width:100%; padding:10px 12px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:8px; background:var(--lumiverse-fill-subtle,#ffffff05); color:inherit; font:inherit; }
textarea.dc-native { resize:vertical; min-height:92px; }
.dc-native:focus-visible,.dc-button:focus-visible { outline:2px solid var(--lumiverse-primary,#b59bd6); outline-offset:2px; }
.dc-native:disabled { opacity:.5; }
.dc-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:8px 12px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:8px; background:var(--lumiverse-fill-subtle,#ffffff05); color:var(--lumiverse-text,#eeeaf8); font:inherit; line-height:1.4; cursor:pointer; transition:background .15s,border-color .15s; }
.dc-button:hover:not(:disabled) { background:var(--lumiverse-fill-hover,#ffffff0a); border-color:var(--lumiverse-border-hover,#51475e); }
.dc-button:disabled { opacity:.45; cursor:not-allowed; }
.dc-icon-button { padding:6px; border-color:transparent; background:transparent; color:var(--lumiverse-text-muted,#b5afc2); }
.dc-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.dc-grid:has(> [data-role=duration-field][hidden]) { grid-template-columns:1fr; }
.dc-tabs { display:flex; gap:20px; margin-bottom:24px; border-bottom:1px solid var(--lumiverse-border,#3b3548); }
.dc-tabs .dc-button { border:0; border-radius:0; border-bottom:2px solid transparent; padding:10px 0; background:transparent; color:var(--lumiverse-text-dim,#9e97ad); font-weight:500; }
.dc-tabs .dc-button[aria-selected=true] { color:var(--lumiverse-primary,#b59bd6); border-bottom-color:var(--lumiverse-primary,#b59bd6); }
.dc-tabs .dc-button:hover { background:transparent; color:var(--lumiverse-text,#eeeaf8); }
.dc-group { margin-bottom:24px; }
.dc-group + .dc-group { border-top:1px solid var(--lumiverse-border,#3b3548); padding-top:24px; }
.dc-group h3 { margin:0; font-size:14px; font-weight:600; }
.dc-toggle-row { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; }
.dc-toggle-row .dc-note { margin:3px 0 0; }
.dc-toggle-row > .dc-control { width:auto; flex-shrink:0; }
.dc-keybindings { margin:16px 0; }
.dc-settings details[data-shared-section] { margin-top:20px; padding-top:12px; border-top:1px solid var(--lumiverse-border,#3b3548); }
.dc-settings details[data-shared-section] > summary { color:var(--lumiverse-text-muted,#b5afc2); cursor:pointer; font-weight:500; }
.dc-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:24px; padding-top:16px; border-top:1px solid var(--lumiverse-border,#3b3548); color:var(--lumiverse-text-dim,#9e97ad); font-size:11px; }
.dc-footer .dc-button { font-size:12px; }
.dc-status { margin-top:12px; color:var(--lumiverse-text-muted,#b5afc2); font-size:12px; overflow-wrap:anywhere; }
.dc-status[data-error=true] { color:var(--lumiverse-danger,#f099a5); }
.dc-widget [data-view=triggers] { display:flex; flex-direction:column; flex:1; min-height:0; }
.dc-actions { margin-bottom:14px; }
.dc-primary { flex:1; background:var(--lumiverse-primary,#b59bd6); border-color:var(--lumiverse-primary,#b59bd6); color:var(--lumiverse-primary-contrast,var(--lumiverse-text,#eeeaf8)); font-weight:600; padding:11px 14px; }
.dc-primary:hover:not(:disabled) { background:var(--lumiverse-primary-hover,#c5afe0); border-color:var(--lumiverse-primary-hover,#c5afe0); }
.dc-reply { flex:1; min-height:100px; max-height:360px; overflow:auto; padding:14px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:10px; background:var(--lumiverse-fill-subtle,#ffffff05); }
.dc-reply-name { color:var(--lumiverse-primary,#b59bd6); font-size:12px; font-weight:600; margin-bottom:8px; }
.dc-reply-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.dc-reply[data-empty=true] .dc-reply-text { color:var(--lumiverse-text-muted,#b5afc2); }
.dc-reply-actions { display:flex; align-items:center; gap:8px; margin-top:10px; }
.dc-reply-actions .dc-button { padding:6px 9px; font-size:12px; }
.dc-reply-actions [data-role=clear] { margin-left:auto; }
.dc-about { padding:24px; width:100%; max-width:760px; margin:0 auto; }
.dc-launcher { display:flex; align-items:center; gap:8px; margin-left:auto; }
.dc-launcher .dc-button { font-size:12px; padding:7px 10px; }
@media(max-width:420px) { .dc-about { padding:16px; } .dc-header { flex-wrap:wrap; } .dc-settings .dc-badge,.dc-settings .dc-badge-host { display:none; } .dc-tabs { gap:18px; } .dc-grid { gap:12px; } }
`;

// src/companion-widget.ts
function mountCompanionWidget(ctx, target, openSettings) {
  if ((ctx.host.capabilities["frontend-session-origin-v1"] ?? 0) < 1 || !ctx.frontendSessionId) {
    throw new Error("Desk Companion requires document-scoped frontend session identity.");
  }
  const removeStyle = ctx.dom.addStyle(STYLES);
  let widget = null;
  try {
    const mounted = ctx.ui.createFloatWidget({
      width: target?.width ?? 380,
      height: target?.height ?? 360,
      initialPosition: { x: 24, y: 72 },
      snapToEdge: true,
      tooltip: "Desk Companion",
      chromeless: target?.chromeless ?? false
    });
    widget = mounted;
    Object.assign(mounted.root.style, { width: "100%", height: "100%", minHeight: "0", overflow: "hidden" });
    const view = mountView(ctx, mounted.root, { surface: "widget", openSettings });
    const returned = (event) => {
      const detail = event.detail;
      if (record(detail) && detail.extensionId === ctx.host.extensionInstallationId && (detail.widgetId === undefined || detail.widgetId === mounted.widgetId))
        mounted.root.append(view.panel);
    };
    window.addEventListener("spindle:desktop-widget-returned", returned);
    let disposed = false;
    return () => {
      if (disposed)
        return;
      disposed = true;
      window.removeEventListener("spindle:desktop-widget-returned", returned);
      try {
        view.dispose();
      } finally {
        try {
          mounted.destroy();
        } finally {
          removeStyle();
        }
      }
    };
  } catch (error) {
    try {
      widget?.destroy();
    } finally {
      removeStyle();
    }
    throw error;
  }
}

// src/frontend.ts
function setup(ctx) {
  const removeStyle = ctx.dom.addStyle(STYLES);
  const tab = ctx.ui.registerDrawerTab({
    id: "desk-companion",
    title: "Desk Companion",
    shortName: "Companion",
    description: "Configure your permissioned desktop companion",
    keywords: ["desktop", "capture", "character", "voice", "popout", "settings", "configuration"]
  });
  const about = document.createElement("section");
  about.className = "dc-about";
  about.innerHTML = `<div class="dc-launcher"><button class="dc-button" data-role="permissions" type="button">Grant permissions</button><button class="dc-button" data-role="show" type="button">Open widget</button></div><p class="dc-note" data-role="status" role="status" hidden></p>`;
  tab.root.append(about);
  const permissionButton = about.querySelector('[data-role="permissions"]');
  const showButton = about.querySelector('[data-role="show"]');
  const status = about.querySelector('[data-role="status"]');
  const launcher = about.querySelector(".dc-launcher");
  function notice(message) {
    status.textContent = message;
    status.hidden = !message;
  }
  let disposed = false;
  let destroyWidget = null;
  let settingsView = null;
  async function show() {
    try {
      const granted = await ctx.permissions.getGranted();
      if (disposed)
        return;
      permissionButton.hidden = REQUIRED_PERMISSIONS.every((permission) => granted.includes(permission));
      if (!granted.includes("ui_panels")) {
        about.prepend(launcher);
        const destroy = destroyWidget;
        destroyWidget = null;
        destroy?.();
        settingsView?.dispose();
        settingsView = null;
        notice("Grant UI Panels to configure your companion.");
        return;
      }
      if ((ctx.host.capabilities["frontend-session-origin-v1"] ?? 0) < 1 || !ctx.frontendSessionId) {
        notice("Update Lumiverse: Desk Companion requires document-scoped frontend session identity.");
        return;
      }
      if (!settingsView) {
        settingsView = mountView(ctx, about, { surface: "settings", openSettings: () => tab.activate() });
        settingsView.panel.querySelector(".dc-header").append(launcher);
      }
      if (destroyWidget)
        return;
      destroyWidget = mountCompanionWidget(ctx, undefined, () => tab.activate());
      notice("");
    } catch {
      if (!disposed)
        notice("Cannot open the widget. Check permissions and the host version.");
    }
  }
  const showHandler = () => {
    show();
  };
  const permissionHandler = () => {
    ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording", "media"], { reason: "Enable an opt-in character desktop companion with optional Media access for voice transcription. Desktop can remember your capture source and approval." }).then(() => show()).catch(() => {
      if (!disposed)
        notice("Capture permissions require administrator or owner approval.");
    });
  };
  showButton.addEventListener("click", showHandler);
  permissionButton.addEventListener("click", permissionHandler);
  const unsubscribePermissions = ctx.events.on("SPINDLE_PERMISSION_CHANGED", (payload) => {
    if (!disposed && record(payload) && payload.extensionId === ctx.host.extensionInstallationId)
      show();
  });
  show();
  return () => {
    if (disposed)
      return;
    disposed = true;
    destroyWidget?.();
    destroyWidget = null;
    settingsView?.dispose();
    settingsView = null;
    unsubscribePermissions();
    showButton.removeEventListener("click", showHandler);
    permissionButton.removeEventListener("click", permissionHandler);
    about.replaceChildren();
    tab.destroy();
    removeStyle();
  };
}
export {
  setup
};
