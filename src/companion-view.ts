import type { DesktopCaptureApprovalStatus, SpindleFrontendContext, SpindleSTTProviderOption } from "lumiverse-spindle-types";
import { CHANNEL, CHARACTER_PAGE_SIZE, MAX_QUESTION, REQUIRED_PERMISSIONS, createMessageId, record } from "./protocol";
import type { Catalog, CharacterOption, ClientMessage, DeviceOption, ServerMessage, VoiceRef } from "./protocol";
import { CAPTURE_PENDING } from "./capture-flow";
import { MAX_SPEECH_CHARS, listSpeechConnections, speakReply, speechAPI } from "./speech";
import type { SpeechConnection } from "./speech";
import { listTranscriptionConnections, recognizeQuestion, speechInputAPI, transcriptionProviders } from "./speech-input";
import type { TranscriptionConnection, TranscriptionProvider } from "./speech-input";
import { AutomaticShareSpeech, prepareShareQuestion } from "./share-workflow";
import { DEFAULT_SETTINGS, parseSettingsPatch } from "./settings";
import type { CompanionSettings, CompanionSnapshot } from "./settings";
import { QUICK_SHARE_COMMAND, SHARE_COMMAND } from "./shortcuts";
import { mountSharedBadge, mountSharedFields, mountSharedSections } from "./shared-ui";

export function mountView(ctx: SpindleFrontendContext, root: HTMLElement, options: { surface?: "widget" | "settings"; openSettings?: () => void } = {}): { panel: HTMLElement; dispose: () => void } {
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
        <div class="dc-page"><button data-role="previous" type="button" aria-label="Previous character page">Previous</button><span data-role="page">Character library</span><button data-role="next" type="button" aria-label="Next character page">Next</button></div>
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
  const configuration = panel.querySelector<HTMLElement>('[data-view="configuration"]')!;
  const triggers = panel.querySelector<HTMLElement>('[data-view="triggers"]')!;
  if (surface === "widget") configuration.remove(); else triggers.remove();
  if (surface === "settings") (panel.querySelector('[data-role="settings"]') as HTMLElement).hidden = true;
  for (const button of panel.querySelectorAll("button")) button.classList.add("dc-button");
  const elements = new Map<string, HTMLElement>();
  for (const container of [panel, configuration, triggers]) for (const child of container.querySelectorAll<HTMLElement>("[data-role]")) {
    if (!elements.has(child.dataset.role!)) elements.set(child.dataset.role!, child);
  }
  root.append(panel);

  function element<ElementType extends HTMLElement>(role: string): ElementType {
    const found = elements.get(role) as ElementType | undefined;
    if (!found) throw new Error("Desk Companion UI could not mount.");
    return found;
  }

  const character = element<HTMLSelectElement>("character");
  const connection = element<HTMLSelectElement>("connection");
  const device = element<HTMLSelectElement>("device");
  const kind = element<HTMLSelectElement>("kind");
  const duration = element<HTMLInputElement>("duration");
  const question = element<HTMLTextAreaElement>("question");
  const tts = element<HTMLSelectElement>("tts");
  const outputAPI = speechAPI(ctx);
  const autoSpeak = element<HTMLInputElement>("auto-speak");
  const voiceInput = element<HTMLInputElement>("voice-input");
  const stt = element<HTMLSelectElement>("stt");
  const sttProvider = element<HTMLSelectElement>("stt-provider");
  const inputAPI = speechInputAPI(ctx);
  let inputProviders: SpindleSTTProviderOption[] = [];
  const status = element("status");
  const reply = element("reply");
  const badge = element("badge");
  let disposed = false;
  let disposing = false;
  let granted: string[] = [];
  let catalog: Catalog | null = null;
  let catalogId: string | null = null;
  let devicesId: string | null = null;
  let devicesTimeout: number | null = null;
  let catalogTimeout: number | null = null;
  let approvalQuery: { id: string; key: string; timer: number } | null = null;
  let approval: { key: string; status: DesktopCaptureApprovalStatus } | null = null;
  let approvalCheckedKey = "";
  let shortcutsMounted = false;
  const shortcutCleanups: Array<() => void> = [];
  let canShare = false;
  let canQuickShare = false;
  let runId: string | null = null;
  let stage = "idle";
  let completedText = "";
  let completedVoice: VoiceRef | null = null;
  let speechConnections: SpeechConnection[] = [];
  let transcriptionConnections: TranscriptionConnection[] = [];
  let inputController: AbortController | null = null;
  let inputMessage = "";
  const automaticSpeech = new AutomaticShareSpeech();
  let speechController: AbortController | null = null;
  let snapshot: CompanionSnapshot | null = null;
  let pendingPatch: Partial<CompanionSettings> = {};
  let saving: { id: string; patch: Partial<CompanionSettings> } | null = null;
  let saveTimer: number | null = null;
  let pendingBegin: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  let initializeVoice = false;
  let automaticRequestId: string | null = null;
  const listingController = new AbortController();
  const cleanups: Array<() => void> = [];
  const destroySections = surface === "settings" ? mountSharedSections(ctx, configuration) : () => {};
  const fields = mountSharedFields(ctx, surface === "settings" ? configuration : document.createElement("div"));
  const sharedBadge = mountSharedBadge(ctx, badge);
  cleanups.push(destroySections, () => fields.destroy(), () => sharedBadge.destroy());
  const tabs = Array.from(configuration.querySelectorAll<HTMLButtonElement>("[role=tab]"));
  function activateTab(tab: HTMLButtonElement): void {
    for (const button of tabs) { const active = button === tab; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; }
    for (const pane of configuration.querySelectorAll<HTMLElement>("[data-pane]")) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  }
  for (const [index, tab] of tabs.entries()) {
    const pane = configuration.querySelector<HTMLElement>(`[data-pane="${tab.dataset.tab}"]`)!;
    tab.id = `${clientId}-tab-${index}`; pane.id = `${clientId}-pane-${index}`;
    tab.setAttribute("aria-controls", pane.id); pane.setAttribute("aria-labelledby", tab.id);
    listen(tab, "click", () => activateTab(tab));
    const navigate = (event: KeyboardEvent) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); activateTab(tabs[next]); tabs[next].focus();
    };
    tab.addEventListener("keydown", navigate); cleanups.push(() => tab.removeEventListener("keydown", navigate));
  }

  function mountShortcuts(): void {
    if (surface !== "settings" || shortcutsMounted || !snapshot) return;
    shortcutsMounted = true;
    const help = element("shortcut-help");
    if (!snapshot.shortcutsAvailable) {
      help.textContent = "Update the Lumiverse backend for shortcuts scoped to this account and Desktop window. Button sharing remains available."; return;
    }
    if (!ctx.client?.getInfo().bridges.desktop) return;
    if (!ctx.components?.mountKeybindingEditor) {
      help.textContent = "Configure these Desk Companion actions in Desktop Settings → Key Bindings, or update Desktop to edit them here."; return;
    }
    try {
      const commandId = element<HTMLSelectElement>("shortcut-action").value === QUICK_SHARE_COMMAND ? QUICK_SHARE_COMMAND : SHARE_COMMAND;
      const editor = ctx.components.mountKeybindingEditor(element("keybinding-editor"), { commandId });
      shortcutCleanups.push(() => editor.destroy());
      element("shortcut-editors").hidden = false;
      help.textContent = "Share screen uses your speech settings. The second action skips voice input.";
    } catch {
      for (const cleanup of shortcutCleanups.splice(0)) cleanup();
      help.textContent = "The shortcut editor could not open. Configure Desk Companion in Desktop Settings → Key Bindings, then reopen this panel."; }
  }

  function approvalKey(): string { const current = settings(); return JSON.stringify([current.deviceId, current.connectionId, current.kind]); }

  function discoverApproval(force = false): void {
    const current = settings(); const key = approvalKey();
    if (disposed || isBusy() || approvalQuery || !snapshot || saving || Object.keys(pendingPatch).length
      || !catalog?.devices.some((entry) => entry.id === current.deviceId) || !current.connectionId
      || !granted.includes("generation") || !granted.includes(current.kind === "video" ? "screen_recording" : "screen_capture")
      || !force && approvalCheckedKey === key) return;
    const id = createMessageId();
    const timer = window.setTimeout(() => {
      approvalQuery = null; approval = null;
      if (!disposed) updateControls();
    }, 12000);
    approvalCheckedKey = key; approvalQuery = { id, key, timer };
    send({ type: "approval", deviceId: current.deviceId, connectionId: current.connectionId, kind: current.kind }, id);
  }

  function listen(target: HTMLElement, event: string, handler: () => void): void {
    target.addEventListener(event, handler);
    cleanups.push(() => target.removeEventListener(event, handler));
  }

  function send(body: ClientMessage extends infer Message ? Message extends ClientMessage ? Omit<Message, "channel" | "id" | "clientId"> : never : never, id: string = createMessageId()): string {
    try { ctx.sendToBackend({ channel: CHANNEL, clientId, id, ...body }); }
    catch (error) { if (!disposing) throw error; }
    return id;
  }

  function settings(): CompanionSettings { return { ...DEFAULT_SETTINGS, ...snapshot?.settings, ...saving?.patch, ...pendingPatch }; }

  const settingsControls: Array<{ key: keyof CompanionSettings; control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement }> = [
    { key: "characterId", control: character }, { key: "connectionId", control: connection }, { key: "deviceId", control: device },
    { key: "kind", control: kind }, { key: "durationSeconds", control: duration }, { key: "question", control: question },
    { key: "autoSpeak", control: autoSpeak }, { key: "voiceInput", control: voiceInput }, { key: "sttProvider", control: sttProvider }, { key: "sttId", control: stt },
    { key: "ttsId", control: tts },
  ];

  function applySettings(): void {
    const current = settings();
    for (const { key, control } of settingsControls) {
      if (key === "autoSpeak" || key === "voiceInput") (control as HTMLInputElement).checked = current[key];
      else {
        control.value = String(current[key]);
        if (!current[key] && control.tagName === "SELECT" && (control as HTMLSelectElement).options.length === 2) (control as HTMLSelectElement).selectedIndex = 1;
      }
    }
  }

  function flushSettings(): void {
    if (disposed || !snapshot || saving || !Object.keys(pendingPatch).length) return;
    const patch = pendingPatch; pendingPatch = {};
    const id = createMessageId(); saving = { id, patch };
    send({ type: "configure", patch }, id); updateControls();
  }

  function queueSettings(patch: Partial<CompanionSettings>): void {
    if (surface !== "settings" || disposed || !snapshot || !parseSettingsPatch(patch)) return;
    pendingPatch = { ...pendingPatch, ...patch };
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = null; flushSettings(); }, 100);
    updateControls();
  }

  function chooseDefaults(): void {
    if (!snapshot || surface !== "settings" || isBusy()) return;
    const current = settings();
    const patch: Partial<CompanionSettings> = {};
    for (const { key, control } of settingsControls) {
      if (["characterId", "connectionId", "deviceId", "sttId", "ttsId"].includes(key) && !current[key] && control.value) {
        Object.assign(patch, { [key]: control.value });
      }
    }
    if (Object.keys(patch).length) queueSettings(patch);
  }

  function notice(text: string, error = false): void {
    status.textContent = text;
    status.hidden = !text;
    status.dataset.error = String(error);
  }

  function fill(select: HTMLSelectElement, choices: Array<{ id: string; label: string }>, placeholder: string, preferred?: string): void {
    const previous = preferred ?? select.value;
    select.replaceChildren(new Option(placeholder, ""));
    for (const choice of choices) select.append(new Option(choice.label, choice.id));
    if (choices.some((choice) => choice.id === previous)) select.value = previous;
    else if (!previous && choices.length === 1) select.value = choices[0].id;
  }

  function selectedCharacter(): CharacterOption | undefined { return catalog?.characters.find((entry) => entry.id === character.value); }

  function isBusy(): boolean {
    return runId !== null || inputController !== null || Boolean(snapshot && snapshot.activity.stage !== "idle");
  }

  function updateDevices(devices: DeviceOption[]): void {
    if (!catalog) return;
    catalog.devices = devices;
    const savedId = settings().deviceId;
    fill(device, devices.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.platform}` })), "Choose a desktop", savedId);
    if (savedId && !devices.some((entry) => entry.id === savedId)) {
      const unavailable = new Option("Saved desktop unavailable — choose a connected desktop", savedId);
      unavailable.disabled = true;
      device.append(unavailable); device.value = savedId;
    }
    chooseDefaults();
  }

  function applyCharacterVoice(silent = false): void {
    const chosen = surface === "settings" ? selectedCharacter()?.voice : completedVoice ?? selectedCharacter()?.voice;
    if (chosen && speechConnections.some((entry) => entry.id === chosen.connectionId)) {
      tts.value = chosen.connectionId;
      queueSettings({ ttsId: tts.value });
      if (!silent) element("speech-status").textContent = "Character voice selected.";
    } else {
      if (!silent) element("speech-status").textContent = "Choose a voice connection; this character has none available.";
    }
    updateControls();
  }

  function initializeCharacterVoice(): void {
    if (!initializeVoice || surface !== "settings" || !selectedCharacter() || !speechConnections.length) return;
    initializeVoice = false; applyCharacterVoice(true);
  }

  function discoverInputProviders(): void {
    try { inputProviders = transcriptionProviders(inputAPI); }
    catch { inputProviders = []; }
    for (const option of sttProvider.options) {
      const provider = inputProviders.find((entry) => entry.id === option.value);
      option.disabled = !provider || !provider.available && !(provider.id === "connection" && provider.unavailableReason === "connectionRequired");
      option.textContent = `${provider?.name ?? (option.value === "whistle" ? "Whistle (on this device)" : option.value === "webspeech" ? "Web Speech" : "STT connection")}${option.disabled ? " · unavailable" : ""}`;
    }
  }

  function updateControls(): void {
    const busy = isBusy();
    const current = settings();
    const chosenConnection = catalog?.connections.find((entry) => entry.id === connection.value);
    const chosenDevice = catalog?.devices.find((entry) => entry.id === device.value);
    const video = kind.value === "video";
    const hasGrants = REQUIRED_PERMISSIONS.filter((permission) => permission !== "screen_capture" || !video)
      .every((permission) => granted.includes(permission)) && (!video || granted.includes("screen_recording"));
    const supported = video ? chosenConnection?.video && chosenDevice?.video : chosenConnection?.image && chosenDevice?.image;
    const validDuration = Number.isInteger(Number(duration.value)) && Number(duration.value) >= 1 && Number(duration.value) <= 30;
    const validVoice = Boolean(outputAPI) && granted.includes("media") && speechConnections.some((entry) => entry.id === tts.value);
    const provider = inputProviders.find((entry) => entry.id === sttProvider.value);
    const connectionInput = sttProvider.value === "connection";
    const providerReady = provider?.available || connectionInput && provider?.unavailableReason === "connectionRequired";
    const validInput = Boolean(providerReady) && Boolean(inputAPI) && granted.includes("media")
      && (!connectionInput || transcriptionConnections.some((entry) => entry.id === stt.value));
    for (const control of [character, connection, device, kind, question, tts, autoSpeak, sttProvider, stt]) control.disabled = busy;
    voiceInput.disabled = busy || !inputAPI;
    element("voice-options").hidden = !voiceInput.checked;
    element("stt-connection").hidden = !connectionInput;
    element("tts-guidance").textContent = !outputAPI ? "Update Lumiverse to enable spoken replies."
      : !granted.includes("media") ? "Use Permissions to grant Media for speech playback." : "Voice and playback settings are managed in Voice & Speech.";
    element("stt-guidance").textContent = inputAPI && !granted.includes("media") ? "Use Permissions to grant Media for voice input."
      : !providerReady ? provider?.unavailableReason === "hostUpdate" ? "Update Lumiverse to use speech recognition through Spindle."
        : "Unavailable in this window. Choose another provider or check Voice & Speech."
      : connectionInput ? "Audio is sent to this connection. Listening ends on silence."
        : sttProvider.value === "whistle" ? "On-device recognition. Listening ends on silence."
          : "Uses your browser or device's speech engine. Listening ends on silence.";
    duration.disabled = busy || !video;
    element("duration-field").hidden = !video;
    const needsSettings = !hasGrants || !supported || !character.value || !current.characterId || !current.connectionId || !current.deviceId
      || character.value !== current.characterId || connection.value !== current.connectionId || device.value !== current.deviceId
      || question.value.length > MAX_QUESTION || (video && !validDuration) || (autoSpeak.checked && !validVoice);
    const blocked = !snapshot || busy || saving !== null || Object.keys(pendingPatch).length > 0 || needsSettings;
    canQuickShare = !blocked;
    canShare = !blocked && (!voiceInput.checked || validInput);
    element<HTMLButtonElement>("observe").disabled = surface !== "widget" || !canShare;
    element("observe").textContent = video ? "Share a video clip" : "Look at my screen";
    element<HTMLButtonElement>("cancel").disabled = !busy || stage === "cancelling";
    element("cancel").hidden = !busy;
    const speaking = speechController !== null || Boolean(snapshot && snapshot.activity.speechStage !== "idle");
    element("stop-speech").hidden = !speaking;
    element("speak").hidden = !completedText || speaking || !validVoice;
    element("clear").hidden = !completedText || busy;
    element("speaker").hidden = !completedText && !snapshot?.activity.text;
    reply.parentElement!.dataset.empty = String(!completedText && !busy);
    element<HTMLButtonElement>("speak").disabled = busy || !completedText || !validVoice || speechController !== null || completedText.length > MAX_SPEECH_CHARS;
    element<HTMLButtonElement>("character-voice").disabled = busy;
    element<HTMLButtonElement>("refresh").disabled = busy || catalogId !== null || devicesId !== null;
    element<HTMLButtonElement>("grant").disabled = busy;
    element("check-devices").hidden = surface !== "widget" || busy || Boolean(chosenDevice) || !hasGrants;
    element<HTMLButtonElement>("check-devices").disabled = catalogId !== null || devicesId !== null;
    element<HTMLButtonElement>("previous").disabled = busy || catalogId !== null || !catalog || catalog.page === 0;
    element<HTMLButtonElement>("next").disabled = busy || catalogId !== null || !catalog || (catalog.page + 1) * CHARACTER_PAGE_SIZE >= catalog.characterTotal;
    badge.dataset.busy = String(busy);
    badge.textContent = busy ? stage === "listening" ? "Listening" : stage === "transcribing" ? "Transcribing" : stage === "consent" ? "Capturing" : stage === "generating" ? "Thinking" : stage === "cancelling" ? "Cancelling" : "Checking"
      : !snapshot ? "Connecting" : !hasGrants ? "Permissions" : !catalog ? "Loading" : saving || Object.keys(pendingPatch).length ? "Saving" : needsSettings || voiceInput.checked && !validInput ? "Setup needed" : "Ready";
    const nativeStatus = approval?.key === approvalKey() ? approval.status : null;
    const readiness = element("capture-readiness");
    readiness.textContent = !hasGrants ? "Grant permissions to enable screen sharing."
      : !catalog ? "Finding desktops…"
      : !chosenDevice ? current.deviceId ? "Your saved desktop is offline. Reconnect it or choose a desktop in Settings."
        : "Set Up Screen Capture in Lumiverse Desktop to connect a desktop."
      : chosenConnection && !supported ? `This model or desktop does not support ${video ? "video clips" : "screenshots"}. Change the model or capture type in Settings.`
      : needsSettings || voiceInput.checked && !validInput ? "Finish setup in Settings to share your screen."
      : nativeStatus?.approval === "paused" ? "Capture requests are paused. Resume them in the Desktop tray."
      : nativeStatus?.approval === "unavailable" ? "Cannot check capture approval. Check Desktop's connection."
      : nativeStatus?.source === "permission_required" ? "Desktop needs screen-recording permission. Open native capture setup."
      : nativeStatus?.source === "missing" ? "Your saved source is unavailable. Choose a source on your next share."
      : nativeStatus?.approval === "remembered" && nativeStatus.source === "ready" ? "Screen source remembered."
      : nativeStatus?.approval === "required" ? "Choose a screen source on your next share."
      : "";
    const needsAttention = !hasGrants || !catalog || !chosenDevice || needsSettings || voiceInput.checked && !validInput
      || nativeStatus?.approval === "paused" || nativeStatus?.approval === "unavailable" || nativeStatus?.source === "permission_required" || nativeStatus?.source === "missing";
    readiness.hidden = busy || !readiness.textContent || surface === "widget" && !needsAttention;
    element("sync-status").textContent = !snapshot ? "Connecting…" : saving || Object.keys(pendingPatch).length ? "Saving…" : "Saved";
    element("page").parentElement!.hidden = !catalog || catalog.characterTotal <= CHARACTER_PAGE_SIZE;
    fields.sync(); sharedBadge.sync();
    discoverApproval();
  }

  function stopSpeech(): void {
    if (element("speech-status").dataset.shared === "true") element("speech-status").textContent = "";
    element("speech-status").dataset.shared = "false";
    speechController?.abort(); speechController = null;
    if (!disposed && snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
    updateControls();
  }

  function clearReply(clearAutomatic = true): void {
    if (clearAutomatic) automaticSpeech.cancel();
    element("input-status").textContent = "";
    stopSpeech(); completedText = ""; completedVoice = null;
    reply.textContent = "Share your screen to hear from your character.";
    element("speaker").textContent = "A fresh perspective";
    element("speech-status").textContent = "";
    updateControls();
  }

  function cancel(shared = true): void {
    automaticSpeech.cancel(); inputController?.abort();
    stopSpeech();
    if (runId && stage !== "cancelling") {
      send({ type: "cancel", targetId: runId }); stage = "cancelling";
      notice("Generation is being cancelled. A pending native capture must be stopped with the native panel's Stop & Discard control.");
      updateControls();
    }
    const targetId = pendingBegin?.id ?? snapshot?.activity.requestId;
    if (targetId && snapshot?.activity.stage !== "idle" && (shared || snapshot?.activity.ownerClientId === clientId)) {
      send({ type: "cancel-shared", targetId });
    }
  }

  function refresh(page = catalog?.page ?? 0): void {
    if (disposed || catalogId || devicesId) return;
    discoverInputProviders();
    if (!REQUIRED_PERMISSIONS.filter((permission) => permission !== "screen_capture").every((permission) => granted.includes(permission))
      || (!granted.includes("screen_capture") && !granted.includes("screen_recording"))) {
      notice("Grant UI Panels, Characters, Generation, and at least one capture permission using Permissions."); return;
    }
    catalogId = send({ type: "catalog", page, activeCharacterId: character.value || ctx.getActiveChat().characterId || undefined });
    catalogTimeout = window.setTimeout(() => {
      catalogId = null; catalogTimeout = null;
      if (!disposed) { notice("Desktop discovery did not finish. Check your connection, then Refresh in Settings.", true); updateControls(); }
    }, 8000);
    updateControls();
  }

  function discoverDevices(): void {
    if (disposed || document.visibilityState === "hidden" || isBusy() || !catalog || catalogId || devicesId
      || !granted.includes("generation") || !granted.includes("characters") || !granted.includes("ui_panels")
      || (!granted.includes("screen_capture") && !granted.includes("screen_recording"))) return;
    devicesId = send({ type: "devices" });
    devicesTimeout = window.setTimeout(() => {
      devicesId = null; devicesTimeout = null;
      if (!disposed) { updateDevices([]); updateControls(); }
    }, 8000);
    updateControls();
  }

  async function speak(selectedVoice?: VoiceRef): Promise<void> {
    if (!completedText || (!selectedVoice && !tts.value) || speechController || disposed) return;
    stopSpeech();
    const controller = new AbortController(); speechController = controller;
    const timer = window.setTimeout(() => {
      if (speechController === controller) { stopSpeech(); if (!disposed) element("speech-status").textContent = "Speech stopped or timed out."; }
    }, 45000);
    element("speech-status").textContent = "Synthesizing with your selected TTS connection…";
    if (snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "synthesizing" });
    updateControls();
    try {
      await speakReply(completedText, (selectedVoice ?? { connectionId: tts.value }).connectionId, controller.signal, outputAPI, (speaking) => {
        if (disposed || controller.signal.aborted || speechController !== controller) return;
        if (snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: speaking ? "playing" : "idle" });
        element("speech-status").textContent = speaking ? "Preparing or playing through Lumiverse. Use Stop speech or the host's audio controls." : "Speech finished.";
      });
      if (!disposed && !controller.signal.aborted && speechController === controller) {
        element("speech-status").textContent = "Speech finished.";
        if (snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
      }
    } catch (error) {
      if (!disposed && snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
      if (!disposed && speechController === controller) element("speech-status").textContent = controller.signal.aborted
        ? "Speech stopped or timed out." : error instanceof Error ? error.message : "Speech could not finish.";
    } finally {
      window.clearTimeout(timer);
      if (speechController === controller) speechController = null;
      if (!disposed) updateControls();
    }
  }

  const unsubscribe = ctx.onBackendMessage((payload) => {
    if (disposed || !record(payload) || payload.channel !== CHANNEL || payload.clientId !== clientId || typeof payload.id !== "string") return;
    const message = payload as unknown as ServerMessage;
    if (message.type === "shortcut") {
      updateControls();
      if (message.skipVoice ? canQuickShare : canShare) void share({ shortcut: true, skipVoice: message.skipVoice });
      else if (!isBusy()) { notice("Shortcut could not start. Finish setup in Desk Companion and wait for settings to save, then press it again.", true); options.openSettings?.(); }
      return;
    }
    if (message.id === approvalQuery?.id) {
      const queried = approvalQuery; approvalQuery = null; window.clearTimeout(queried.timer);
      if (queried.key === approvalKey()) approval = message.type === "approval" ? { key: queried.key, status: message.status } : null;
      updateControls(); return;
    }
    if (message.type === "open-settings") { options.openSettings?.(); return; }
    if (message.type === "stop-local") {
      if (message.targetId === automaticRequestId) { automaticSpeech.cancel(); automaticRequestId = null; }
      stopSpeech();
      if (!message.speechOnly && (message.targetId === pendingBegin?.id || message.targetId === snapshot?.activity.requestId)) inputController?.abort();
      return;
    }
    if (message.type === "state") {
      const incoming = message.snapshot;
      if (saving?.id === message.id) saving = null;
      if (pendingBegin?.id === message.id && snapshot && incoming.epoch === snapshot.epoch && incoming.sequence <= snapshot.sequence) {
        const pending = pendingBegin; pendingBegin = null;
        if (snapshot.activity.requestId === pending.id && snapshot.activity.ownerClientId === clientId && snapshot.activity.stage !== "idle") pending.resolve();
        else pending.reject(new Error("The shared workflow changed before this widget could start."));
      }
      if (snapshot && incoming.epoch === snapshot.epoch && incoming.sequence <= snapshot.sequence) {
        flushSettings(); updateControls(); return;
      }
      const first = !snapshot;
      if (first) initializeVoice = !incoming.settings.ttsId;
      const restarted = Boolean(snapshot && incoming.epoch !== snapshot.epoch);
      if (restarted) {
        automaticSpeech.cancel(); automaticRequestId = null; inputController?.abort(); stopSpeech(); runId = null;
        saving = null; pendingPatch = {}; catalogId = null; devicesId = null; catalog = null;
        if (approvalQuery) window.clearTimeout(approvalQuery.timer);
        approvalQuery = null; approval = null; approvalCheckedKey = "";
        for (const cleanup of shortcutCleanups.splice(0)) cleanup();
        shortcutsMounted = false;
        if (catalogTimeout !== null) window.clearTimeout(catalogTimeout);
        if (devicesTimeout !== null) window.clearTimeout(devicesTimeout);
        if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
      }
      const oldCharacter = snapshot?.settings.characterId;
      snapshot = incoming;
      mountShortcuts();
      applySettings(); chooseDefaults();
      stage = incoming.activity.stage;
      completedText = stage === "idle" ? incoming.activity.text : "";
      completedVoice = incoming.activity.voice;
      reply.textContent = incoming.activity.text || "Share your screen to hear from your character.";
      element("speaker").textContent = incoming.activity.characterName;
      notice(inputController && incoming.activity.ownerClientId === clientId && inputMessage && !incoming.activity.error
        ? inputMessage : incoming.activity.stage === "idle" && incoming.activity.text && !incoming.activity.error ? "" : incoming.activity.message, incoming.activity.error);
      if (incoming.activity.speechClientId !== clientId && incoming.activity.speechStage !== "idle") {
        element("speech-status").textContent = `${incoming.activity.speechStage === "playing" ? "Speaking" : incoming.activity.speechStage === "ready" ? "Audio is ready" : "Synthesizing speech"} in another companion window.`;
        element("speech-status").dataset.shared = "true";
      } else if (element("speech-status").dataset.shared === "true") {
        element("speech-status").textContent = ""; element("speech-status").dataset.shared = "false";
      }
      if (pendingBegin?.id === message.id) {
        const pending = pendingBegin; pendingBegin = null;
        if (incoming.activity.requestId === pending.id && incoming.activity.ownerClientId === clientId && stage !== "idle") pending.resolve();
        else pending.reject(new Error("Settings changed. Review the synchronized configuration and try again."));
      }
      if (first || restarted || oldCharacter !== incoming.settings.characterId && !catalog?.characters.some((entry) => entry.id === incoming.settings.characterId)) refresh(0);
      if (catalog && incoming.settings.deviceId && !catalog.devices.some((entry) => entry.id === incoming.settings.deviceId)) discoverDevices();
      flushSettings(); updateControls(); return;
    }
    if (message.type === "error" && pendingBegin?.id === message.id) {
      const pending = pendingBegin; pendingBegin = null; pending.reject(new Error(message.message)); return;
    }
    if (message.type === "error" && saving?.id === message.id) {
      saving = null; pendingPatch = {}; applySettings(); notice(message.message, true); updateControls(); return;
    }
    if (message.id === devicesId) {
      devicesId = null;
      if (devicesTimeout !== null) { window.clearTimeout(devicesTimeout); devicesTimeout = null; }
      if (message.type === "devices" && JSON.stringify(message.devices) !== JSON.stringify(catalog?.devices)) updateDevices(message.devices);
      else if (message.type === "error") updateDevices([]);
      discoverApproval(true);
      updateControls(); return;
    }
    if (message.id === catalogId) {
      if (catalogTimeout !== null) { window.clearTimeout(catalogTimeout); catalogTimeout = null; }
      if (message.type === "catalog") {
        catalog = message.catalog; catalogId = null;
        const current = settings();
        const preferred = current.characterId || ctx.getActiveChat().characterId || undefined;
        fill(character, catalog.characters.map((entry) => ({ id: entry.id, label: entry.name })), "Choose a character", preferred);
        fill(connection, catalog.connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.model}` })), "Choose a model connection", current.connectionId);
        updateDevices(catalog.devices);
        element("page").textContent = `Page ${catalog.page + 1} · ${catalog.characterTotal} characters`;
        if (!snapshot?.activity.requestId && !isBusy()) notice("");
        chooseDefaults();
        initializeCharacterVoice();
      } else if (message.type === "error") { catalogId = null; notice(message.message, true); }
      updateControls(); return;
    }
    if (message.id !== runId) return;
    if (message.type === "status") {
      stage = message.stage;
      const messages = { checking: "Verifying the character, model, and desktop for your account…", consent: CAPTURE_PENDING,
        generating: "The approved capture is attached privately. Your character is thinking…", cancelling: "Generation cancelled. Use Stop & Discard in any native capture panel still open; waiting for that request to finish." };
      notice(messages[message.stage]);
    } else if (message.type === "text" && stage !== "cancelling") reply.textContent = message.text;
    else if (message.type === "complete") {
      const chosenVoice = automaticSpeech.take(message.id);
      automaticRequestId = null;
      if (stage === "cancelling") { runId = null; stage = "idle"; clearReply(); notice("Observation cancelled; no automatic speech."); updateControls(); return; }
      runId = null; stage = "idle"; completedText = message.text; completedVoice = message.voice;
      reply.textContent = message.text; element("speaker").textContent = message.characterName;
      notice("");
      if (message.text.length > MAX_SPEECH_CHARS) element("speech-status").textContent = "Reply exceeds the 2,400-character speech limit. Ask for a shorter answer.";
      else if (chosenVoice) void speak(chosenVoice);
    } else if (message.type === "error") {
      runId = null; stage = "idle"; clearReply(); notice(message.message, true);
    }
    updateControls();
  });
  cleanups.push(unsubscribe);

  async function share(trigger: { shortcut?: boolean; skipVoice?: boolean } = {}): Promise<void> {
    if (!(trigger.skipVoice ? canQuickShare : canShare) || surface !== "widget" && !trigger.shortcut) return;
    send({ type: "subscribe", surface });
    const selectedVoice = autoSpeak.checked ? { connectionId: tts.value, voice: "" } : null;
    const requestId = createMessageId();
    stopSpeech();
    automaticSpeech.arm(requestId, selectedVoice);
    automaticRequestId = requestId;
    const request = { type: "observe" as const, characterId: character.value, connectionId: connection.value, deviceId: device.value,
      kind: kind.value as "image" | "video", durationSeconds: Number(duration.value), question: question.value };
    const includeVoice = voiceInput.checked && !trigger.skipVoice;
    const inputProvider = sttProvider.value as TranscriptionProvider;
    const controller = new AbortController(); inputController = controller;
    inputMessage = "";
    const timer = window.setTimeout(() => controller.abort(), 60000);
    let dispatched = false;
    let failureMessage = "Share stopped before requesting screen capture.";
    updateControls();
    try {
      const reservation = new Promise<void>((resolve, reject) => {
        let settled = false;
        const abort = () => finish(new Error("Share cancelled."));
        const reservationTimer = window.setTimeout(() => finish(new Error("The companion did not synchronize. Refresh before sharing.")), 10000);
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(reservationTimer); controller.signal.removeEventListener("abort", abort);
          if (pendingBegin?.id === requestId) pendingBegin = null;
          if (error) reject(error); else resolve();
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        pendingBegin = { id: requestId, resolve: () => finish(), reject: (error) => finish(error) };
        send({ type: "begin-share", revision: snapshot!.revision }, requestId);
      });
      void reservation.catch(() => {});
      const beginInput = () => {
        stage = "listening";
        inputMessage = "Listening… pause when you finish.";
        notice(inputMessage); updateControls();
        return prepareShareQuestion(request.question, recognizeQuestion(inputProvider, stt.value, controller.signal, inputAPI, (status) => {
          if (disposed || controller.signal.aborted || inputController !== controller) return;
          stage = status.phase === "processing" ? "transcribing" : "listening";
          send({ type: "input-stage", targetId: requestId, stage: stage as "listening" | "transcribing" });
          inputMessage = status.phase === "loading" ? `Loading ${inputProvider === "whistle" ? "Whistle on this device" : "speech recognition"}${typeof status.progress === "number" ? ` · ${Math.round(Math.max(0, Math.min(1, status.progress)) * 100)}%` : ""}…`
            : status.phase === "processing" ? "Transcribing your question…"
              : "Listening… pause when you finish.";
          notice(inputMessage); updateControls();
        }), controller.signal);
      };
      // Button presses start in the gesture before awaiting the worker. Shortcuts
      // already arrive asynchronously, so retain their reservation-before-input check.
      const questionReady = includeVoice && !trigger.shortcut ? beginInput() : null;
      void questionReady?.catch(() => {});
      await reservation;
      if (disposed || controller.signal.aborted) return;
      clearReply(false);
      if (includeVoice) request.question = await (questionReady ?? beginInput());
      if (disposed || controller.signal.aborted) return;
      if (includeVoice) element("input-status").textContent = `Included question: ${request.question}`;
      inputController = null; stage = "checking";
      runId = send(request, requestId);
      dispatched = true;
    } catch (error) {
      automaticSpeech.cancel();
      failureMessage = controller.signal.aborted ? "Share cancelled or voice input timed out. Nothing was requested from a model."
        : error instanceof Error ? error.message : "Voice input could not finish; no screen capture was requested.";
      controller.abort();
      if (!disposed) { stage = "idle"; notice(failureMessage, true); }
    } finally {
      window.clearTimeout(timer);
      if (!dispatched && !disposed) send({ type: "input-ended", targetId: requestId, message: failureMessage.slice(0, 400) });
      if (inputController === controller) inputController = null;
      if (!disposed) updateControls();
    }
  }
  listen(element("observe"), "click", () => { void share(); });
  listen(element("cancel"), "click", () => cancel());
  listen(element("clear"), "click", () => { cancel(); clearReply(); send({ type: "clear-state" }); });
  listen(element("refresh"), "click", () => refresh());
  listen(element("check-devices"), "click", () => { if (catalog) discoverDevices(); else refresh(); });
  listen(element("shortcut-action"), "change", () => {
    for (const cleanup of shortcutCleanups.splice(0)) cleanup();
    shortcutsMounted = false; mountShortcuts();
  });
  listen(element("previous"), "click", () => refresh(Math.max(0, (catalog?.page ?? 0) - 1)));
  listen(element("next"), "click", () => refresh((catalog?.page ?? 0) + 1));
  listen(element("speak"), "click", () => { void speak(); });
  listen(element("stop-speech"), "click", () => { automaticSpeech.cancel(); stopSpeech(); send({ type: "stop-speech" }); element("speech-status").textContent = "Speech stopped; pending automatic speech is disabled for this share."; });
  listen(element("settings"), "click", () => { options.openSettings ? options.openSettings() : send({ type: "open-settings" }); });
  listen(element("character-voice"), "click", () => applyCharacterVoice());
  listen(character, "change", () => { queueSettings({ characterId: character.value }); clearReply(); applyCharacterVoice(); });
  for (const { key, control } of settingsControls) listen(control, "input", () => {
    const value = key === "autoSpeak" || key === "voiceInput" ? (control as HTMLInputElement).checked
      : ["durationSeconds"].includes(key) ? Number(control.value) : control.value;
    queueSettings({ [key]: value }); updateControls();
  });
  listen(element("grant"), "click", () => {
    void ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording", "media"], { reason: "Desk Companion uses Media for optional voice input and playback, plus grants to select a character, request desktop capture with native approval, and ask your chosen model." })
      .then((permissions) => { if (!disposed) { granted = permissions; refresh(); updateControls(); } })
      .catch(() => { if (!disposed) notice("Permission request was declined. An administrator/owner must approve capture grants.", true); });
  });
  cleanups.push(ctx.events.on("SPINDLE_PERMISSION_CHANGED", (payload) => {
    if (!record(payload) || payload.extensionId !== ctx.host.extensionInstallationId) return;
    if (approvalQuery) window.clearTimeout(approvalQuery.timer);
    approvalQuery = null; approval = null; approvalCheckedKey = "";
    if (payload.granted === false) { cancel(); clearReply(); }
    void ctx.permissions.getGranted().then((permissions) => { if (!disposed) { granted = permissions; refresh(); updateControls(); } }).catch(() => {});
  }));
  void ctx.permissions.getGranted().then((permissions) => { if (!disposed) { granted = permissions; send({ type: "subscribe", surface }); updateControls(); } })
    .catch(() => { if (!disposed) notice("Cannot read grants. Check the extension's permissions.", true); });
  const listingTimeout = window.setTimeout(() => listingController.abort(), 15000);
  const speechListing = listSpeechConnections(ctx, listingController.signal).then((connections) => {
    if (disposed) return;
    speechConnections = connections;
    fill(tts, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose a TTS connection", settings().ttsId);
    chooseDefaults();
    initializeCharacterVoice();
    updateControls();
  }).catch(() => { if (!disposed) element("speech-status").textContent = "Voice connections could not be loaded. Reopen settings to retry."; });
  discoverInputProviders();
  const inputListing = listTranscriptionConnections(ctx, listingController.signal).then((connections) => {
    if (disposed) return;
    transcriptionConnections = connections;
    fill(stt, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose an STT connection", settings().sttId);
    chooseDefaults();
    updateControls();
  }).catch(() => { if (!disposed) element("input-status").textContent = "STT connections could not be loaded. Choose Whistle or reopen settings to retry."; });
  void Promise.allSettled([speechListing, inputListing]).finally(() => window.clearTimeout(listingTimeout));
  const resynchronize = () => { if (!disposed && document.visibilityState !== "hidden") { discoverInputProviders(); send({ type: "subscribe", surface }); refresh(); updateControls(); } };
  window.addEventListener("pageshow", resynchronize);
  window.addEventListener("online", resynchronize);
  document.addEventListener("visibilitychange", resynchronize);
  window.addEventListener("focus", discoverDevices);
  const refreshInputProviders = () => { if (!disposed) { discoverInputProviders(); updateControls(); } };
  window.addEventListener("focus", refreshInputProviders);
  // Discovery only: never request a capture, input, generation, or speech here.
  let discoveryTimer: number;
  const pollDevices = () => { discoverDevices(); discoveryTimer = window.setTimeout(pollDevices, 10000); };
  discoveryTimer = window.setTimeout(pollDevices, 10000);
  cleanups.push(() => { window.removeEventListener("pageshow", resynchronize); window.removeEventListener("online", resynchronize); document.removeEventListener("visibilitychange", resynchronize); window.removeEventListener("focus", discoverDevices); window.removeEventListener("focus", refreshInputProviders); window.clearTimeout(discoveryTimer); });
  updateControls();

  return { panel, dispose: () => {
    if (disposed || disposing) return;
    disposing = true;
    cancel(false);
    if (surface === "settings") flushSettings();
    send({ type: "unsubscribe" });
    disposed = true; listingController.abort(); stopSpeech();
    pendingBegin?.reject(new Error("Companion window closed.")); pendingBegin = null;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    if (devicesTimeout !== null) window.clearTimeout(devicesTimeout);
    if (catalogTimeout !== null) window.clearTimeout(catalogTimeout);
    if (approvalQuery) window.clearTimeout(approvalQuery.timer);
    window.clearTimeout(listingTimeout);
    for (const cleanup of shortcutCleanups.splice(0)) cleanup();
    for (const cleanup of cleanups.splice(0)) cleanup();
    completedText = ""; completedVoice = null; catalog = null;
    panel.replaceChildren(); panel.remove();
  } };
}
