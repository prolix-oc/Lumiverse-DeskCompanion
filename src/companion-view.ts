import type { DesktopCaptureApprovalStatus, SpindleFrontendContext } from "lumiverse-spindle-types";
import { CHANNEL, CHARACTER_PAGE_SIZE, MAX_QUESTION, REQUIRED_PERMISSIONS, createMessageId, record } from "./protocol";
import type { Catalog, CharacterOption, ClientMessage, DeviceOption, ServerMessage, VoiceRef } from "./protocol";
import { CAPTURE_PENDING, CAPTURE_READY } from "./capture-flow";
import { MAX_SPEECH_CHARS, listSpeechConnections, synthesizeReply } from "./speech";
import type { SpeechConnection } from "./speech";
import { listTranscriptionConnections, supportsVoiceInput } from "./speech-input";
import type { TranscriptionConnection } from "./speech-input";
import { AutomaticShareSpeech, prepareShareQuestion } from "./share-workflow";
import { DEFAULT_SETTINGS, parseSettingsPatch } from "./settings";
import type { CompanionSettings, CompanionSnapshot } from "./settings";
import { QUICK_SHARE_COMMAND, SHARE_COMMAND } from "./shortcuts";

export function mountView(ctx: SpindleFrontendContext, root: HTMLElement, options: { surface?: "widget" | "settings"; openSettings?: () => void } = {}): { panel: HTMLElement; dispose: () => void } {
  const surface = options.surface ?? "widget";
  const clientId = createMessageId();
  const panel = document.createElement("section");
  panel.className = surface === "widget" ? "dc-shell dc-widget" : "dc-shell dc-settings";
  panel.setAttribute("aria-label", "Desk Companion");
  panel.innerHTML = `
    <header><span class="dc-mark" aria-hidden="true">✦</span><div><h2>Desk Companion</h2><div class="dc-subtitle">Your character, a little closer.</div></div><span class="dc-badge" data-role="badge">Ready</span></header>
    <div data-view="configuration">
    <label class="dc-field">Character<select data-role="character" aria-label="Character"><option value="">Grant permissions, then refresh</option></select></label>
    <div class="dc-page"><button data-role="previous" type="button">Previous</button><span data-role="page">Character library</span><button data-role="next" type="button">Next</button></div>
    <label class="dc-field">Model connection<select data-role="connection" aria-label="Model connection"><option value="">Choose a multimodal connection</option></select></label>
    <label class="dc-field">Desktop device<select data-role="device" aria-label="Desktop device"><option value="">Set up screen capture in Desktop</option></select></label>
    <p class="dc-note" data-role="capture-readiness" aria-live="polite"></p>
    <details><summary>Screen source &amp; approval</summary>
      <p class="dc-note">On your first share, choose a source in Desktop and enable Remember this source and approval for this extension to reuse it. Later matching shares go straight to capture. Review Before Sending is optional.</p>
      <p class="dc-note">Source and approval are managed by Desktop. A different model connection or capture type can need fresh approval. If a source disappears, Desktop opens setup again. To change a saved source, use Forget Screen Capture Approvals in the desktop tray.</p>
      <p class="dc-note">Stop &amp; Discard also pauses future requests. Use Allow Screen Capture Requests Again in the desktop tray to resume. Updated desktops keep your saved device choice across reconnects and restarts. Older desktops may need their new registration selected here.</p>
    </details>
    <div class="dc-row"><label class="dc-field">Capture<select data-role="kind" aria-label="Capture type"><option value="image">Screenshot</option><option value="video">Video clip</option></select></label><label class="dc-field">Clip seconds<input data-role="duration" aria-label="Clip duration" type="number" min="1" max="30" step="1" value="3" disabled></label></div>
    <div class="dc-destination" data-role="destination">Nothing is captured automatically.</div>
    <label class="dc-field">Anything on your mind? (optional)<textarea data-role="question" aria-label="Optional question or direction" placeholder="Leave blank for a brief, in-character reaction. Or ask a question…" maxlength="1200"></textarea></label>
    <details open><summary>Share workflow</summary>
      <label class="dc-option"><input data-role="auto-speak" type="checkbox"> Speak the character's reply automatically after an approved share</label>
      <label class="dc-option"><input data-role="voice-input" type="checkbox"> Include a spoken question with each share</label>
      <div data-role="voice-options" hidden><label class="dc-field">STT connection<select data-role="stt" aria-label="STT connection"><option value="">Choose an STT connection</option></select></label>
        <label class="dc-field">Listen for seconds<input data-role="voice-seconds" aria-label="Voice input duration" type="number" min="1" max="15" step="1" value="5"></label></div>
      <p class="dc-note" data-role="workflow-summary">Share → character reaction. Voice input and automatic speech are off.</p>
      <p class="dc-note" data-role="input-status" role="status"></p>
    </details>
    <details open data-role="shortcuts"><summary>Keyboard shortcuts</summary>
      <p class="dc-note">Share screen follows your Share workflow settings. Share without voice input skips the microphone for that request and keeps your written question and reply settings.</p>
      <div data-role="shortcut-editors" hidden><label class="dc-field">Shortcut action<select data-role="shortcut-action" aria-label="Shortcut action"><option value="share-screen">Share screen · use Share workflow</option><option value="share-screen-without-voice">Share without voice input</option></select></label>
      <div data-role="keybinding-editor"></div></div>
      <p class="dc-note" data-role="shortcut-help">Open this extension in Lumiverse Desktop to configure shortcuts. Keep its integrated browser open and signed in. Global shortcuts can work while the window is in the background.</p>
    </details>
    <details data-role="speech-options"><summary>Character voice · text-to-speech</summary>
      <label class="dc-field">TTS connection<select data-role="tts" aria-label="TTS connection"><option value="">Choose a TTS connection</option></select></label>
      <div class="dc-row"><label class="dc-field">Voice ID (blank = connection default)<input data-role="voice" aria-label="Voice ID" maxlength="256" placeholder="Connection default"></label><label class="dc-field" style="max-width:80px">Speed<input data-role="speed" aria-label="Speech speed" type="number" value="1" min="0.25" max="4" step="0.05"></label></div>
      <div class="dc-row"><button data-role="character-voice" type="button">Use character voice</button></div>
      <p class="dc-note">Speech sends reply text to the selected TTS provider. Enable automatic speech above to run it after each approved share; otherwise use Speak reply. Capture pixels and videos never enter this widget.</p>
    </details>
    <footer class="dc-footer"><span data-role="sync-status">Connecting to companion settings…</span><div class="dc-row"><button data-role="refresh" type="button">Refresh</button><button data-role="grant" type="button">Permissions</button></div></footer>
    <div class="dc-row"><button data-role="cancel" type="button" hidden>Cancel request</button><button data-role="stop-speech" type="button" hidden>Stop speech</button></div>
    <div class="dc-note" data-role="speech-status" role="status" aria-live="polite"></div><audio data-role="audio" controls preload="none" hidden></audio>
    </div>
    <div data-view="triggers">
      <div class="dc-destination" data-role="widget-summary">Configure your companion in the Desk Companion sidebar.</div>
      <p class="dc-note" data-role="capture-readiness" aria-live="polite"></p>
      <button data-role="check-devices" type="button" hidden>Check desktops</button>
      <div class="dc-row dc-actions"><button class="dc-primary" data-role="observe" type="button" disabled>Look at my screen</button><button data-role="cancel" type="button" disabled>Cancel request</button></div>
      <div class="dc-reply"><div class="dc-reply-name" data-role="speaker">A fresh perspective</div><div class="dc-reply-text" data-role="reply">Your character's response appears here. Replies stay in companion memory, not chat history.</div></div>
      <div class="dc-row"><button data-role="speak" type="button" disabled>Speak reply</button><button data-role="stop-speech" type="button">Stop speech</button><button data-role="clear" type="button">Clear</button></div>
      <div class="dc-note" data-role="speech-status" role="status" aria-live="polite"></div><audio data-role="audio" controls preload="none" hidden></audio>
      <footer class="dc-footer"><span>One request. One approved capture.</span><button data-role="settings" type="button">Settings</button></footer>
    </div>
    <div class="dc-status" data-role="status" role="status" aria-live="polite">Connecting to the companion…</div>`;
  const configuration = panel.querySelector<HTMLElement>('[data-view="configuration"]')!;
  const triggers = panel.querySelector<HTMLElement>('[data-view="triggers"]')!;
  if (surface === "widget") configuration.remove(); else triggers.remove();
  root.append(panel);

  function element<ElementType extends HTMLElement>(role: string): ElementType {
    const selector = `[data-role="${role}"]`;
    const found = panel.querySelector<ElementType>(selector) ?? configuration.querySelector<ElementType>(selector) ?? triggers.querySelector<ElementType>(selector);
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
  const voice = element<HTMLInputElement>("voice");
  const speed = element<HTMLInputElement>("speed");
  const audio = element<HTMLAudioElement>("audio");
  const autoSpeak = element<HTMLInputElement>("auto-speak");
  const voiceInput = element<HTMLInputElement>("voice-input");
  const stt = element<HTMLSelectElement>("stt");
  const voiceSeconds = element<HTMLInputElement>("voice-seconds");
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
  const automaticSpeech = new AutomaticShareSpeech();
  let speechController: AbortController | null = null;
  let audioUrl: string | null = null;
  let snapshot: CompanionSnapshot | null = null;
  let pendingPatch: Partial<CompanionSettings> = {};
  let saving: { id: string; patch: Partial<CompanionSettings> } | null = null;
  let saveTimer: number | null = null;
  let pendingBegin: { id: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  let initializeVoice = false;
  let automaticRequestId: string | null = null;
  const listingController = new AbortController();
  const cleanups: Array<() => void> = [];

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
      help.textContent = "Choose a focused or global binding here. Global bindings require Desktop's native opt-in. Keep the integrated browser open and signed in; a global binding can work while it is in the background.";
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
    { key: "autoSpeak", control: autoSpeak }, { key: "voiceInput", control: voiceInput }, { key: "sttId", control: stt },
    { key: "voiceSeconds", control: voiceSeconds }, { key: "ttsId", control: tts }, { key: "voice", control: voice }, { key: "speed", control: speed },
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

  function applyCharacterVoice(): void {
    const chosen = surface === "settings" ? selectedCharacter()?.voice : completedVoice ?? selectedCharacter()?.voice;
    if (chosen && speechConnections.some((entry) => entry.id === chosen.connectionId)) {
      tts.value = chosen.connectionId; voice.value = chosen.voice; speed.value = String(chosen.speed ?? 1);
      queueSettings({ ttsId: tts.value, voice: voice.value, speed: Number(speed.value) });
      element("speech-status").textContent = "Using the character's configured voice. You can override it here.";
    } else {
      element("speech-status").textContent = "No accessible character voice is configured. Choose a TTS connection and optional voice ID.";
    }
    updateControls();
  }

  function initializeCharacterVoice(): void {
    if (!initializeVoice || surface !== "settings" || !selectedCharacter() || !speechConnections.length) return;
    initializeVoice = false; applyCharacterVoice();
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
    const validVoice = speechConnections.some((entry) => entry.id === tts.value) && Number.isFinite(Number(speed.value))
      && Number(speed.value) >= 0.25 && Number(speed.value) <= 4 && voice.value.length <= 256;
    const validInput = supportsVoiceInput() && transcriptionConnections.some((entry) => entry.id === stt.value)
      && Number.isInteger(Number(voiceSeconds.value)) && Number(voiceSeconds.value) >= 1 && Number(voiceSeconds.value) <= 15;
    for (const control of [character, connection, device, kind, question, tts, voice, speed, autoSpeak, stt, voiceSeconds]) control.disabled = busy;
    voiceInput.disabled = busy || !supportsVoiceInput();
    element("voice-options").hidden = !voiceInput.checked;
    duration.disabled = busy || !video;
    const needsSettings = !hasGrants || !supported || !character.value || !current.characterId || !current.connectionId || !current.deviceId
      || character.value !== current.characterId || connection.value !== current.connectionId || device.value !== current.deviceId
      || question.value.length > MAX_QUESTION || (video && !validDuration) || (autoSpeak.checked && !validVoice);
    const blocked = !snapshot || busy || saving !== null || Object.keys(pendingPatch).length > 0 || needsSettings;
    canQuickShare = !blocked;
    canShare = !blocked && (!voiceInput.checked || validInput);
    element<HTMLButtonElement>("observe").disabled = surface !== "widget" || !canShare;
    element("observe").textContent = video ? "Share a video clip" : "Look at my screen";
    element<HTMLButtonElement>("cancel").disabled = !busy || stage === "cancelling";
    if (surface === "settings") {
      element("cancel").hidden = !busy;
      element("stop-speech").hidden = !speechController && snapshot?.activity.speechStage === "idle";
    }
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
    element("capture-readiness").textContent = !hasGrants ? "Grant the extension's permissions to set up screen capture."
      : !catalog ? "Finding your capture desktops…"
      : !chosenDevice ? current.deviceId
        ? "Your saved desktop is offline. Reconnect it and it will reappear automatically. Older clients may need you to choose the new registration in Settings."
        : "Set Up Screen Capture in the extension's permissions or desktop tray. Connected desktops appear automatically."
      : needsSettings || voiceInput.checked && !validInput ? "Finish choosing your character, model, and share options in Settings. The shortcut without voice input can share without an STT connection."
      : nativeStatus?.approval === "paused" ? "Capture requests are paused. Use Allow Screen Capture Requests Again in the Desktop tray, then share again."
      : nativeStatus?.approval === "unavailable" ? "Desktop could not check approval. Check its connection and native capture setup before sharing."
      : nativeStatus?.source === "permission_required" ? "Desktop needs screen-recording permission. Open native capture setup to grant it before sharing."
      : nativeStatus?.source === "missing" ? "Your saved source is unavailable. Your next share opens native setup so you can choose a source."
      : nativeStatus?.approval === "remembered" && nativeStatus.source === "ready" ? "Source and approval remembered for this model and capture type. Your next share goes straight to capture."
      : nativeStatus?.approval === "required" ? "Your next share opens native setup. Choose a source and enable Remember to reuse it for this model and capture type."
      : CAPTURE_READY;
    element("capture-readiness").hidden = busy;
    const destination = element("destination");
    destination.textContent = chosenConnection ? `${chosenConnection.provider} · ${chosenConnection.model} · ${chosenDevice?.name ?? "choose a desktop"}${supported ? "" : " · media not supported"}` : "Choose the model destination before requesting a capture.";
    const inputDestination = transcriptionConnections.find((entry) => entry.id === stt.value);
    const speechDestination = speechConnections.find((entry) => entry.id === tts.value);
    element("workflow-summary").textContent = `${voiceInput.checked ? `Listen ${voiceSeconds.value}s → ${inputDestination?.name ?? "choose STT"} → ` : ""}Approved share → character reaction${autoSpeak.checked ? ` → ${speechDestination?.name ?? "choose TTS below"}` : " (text only)"}.`
      + (voiceInput.checked ? " Microphone audio is sent to the STT provider before screen capture; no background listening." : " Voice input is off.");
    element("widget-summary").textContent = `${selectedCharacter()?.name ?? "Choose a character in the sidebar"} · ${video ? `Video ${duration.value}s` : "Screenshot"}\n${destination.textContent}\n${element("workflow-summary").textContent}`;
    element("sync-status").textContent = !snapshot ? "Connecting to companion settings…" : saving || Object.keys(pendingPatch).length
      ? "Saving settings…" : "Settings synchronized across companion windows.";
    discoverApproval();
  }

  function stopSpeech(): void {
    if (element("speech-status").dataset.shared === "true") element("speech-status").textContent = "";
    element("speech-status").dataset.shared = "false";
    speechController?.abort(); speechController = null;
    audio.pause(); audio.removeAttribute("src"); audio.load(); audio.hidden = true;
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    if (!disposed && snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" });
    updateControls();
  }

  function clearReply(clearAutomatic = true): void {
    if (clearAutomatic) automaticSpeech.cancel();
    element("input-status").textContent = "";
    stopSpeech(); completedText = ""; completedVoice = null;
    reply.textContent = "Your character's response appears here. Nothing is saved to chat history.";
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
      const blob = await synthesizeReply(completedText, selectedVoice ?? { connectionId: tts.value, voice: voice.value, speed: Number(speed.value) }, controller.signal);
      if (disposed || controller.signal.aborted || speechController !== controller) return;
      audioUrl = URL.createObjectURL(blob); audio.src = audioUrl; audio.hidden = false;
      if (snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "ready" });
      try {
        await audio.play();
        if (!disposed && !controller.signal.aborted && snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "playing" });
        if (!disposed && speechController === controller) element("speech-status").textContent = "Speaking. Use the player to pause or replay.";
      } catch {
        if (!disposed && speechController === controller) element("speech-status").textContent = "Audio is ready. Your browser requires pressing Play in the audio controls.";
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
      reply.textContent = incoming.activity.text || "Your character's response appears here. Nothing is saved to chat history.";
      element("speaker").textContent = incoming.activity.characterName;
      notice(incoming.activity.message, incoming.activity.error);
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
      const capture = message.capture;
      notice(`Answered using one approved ${capture.kind}: ${capture.width} × ${capture.height}${capture.durationSeconds === undefined ? "" : ` · ${capture.durationSeconds.toFixed(1)}s`}. The capture handle is single-use and released.`);
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
    const selectedVoice = autoSpeak.checked ? { connectionId: tts.value, voice: voice.value, speed: Number(speed.value) } : null;
    const requestId = createMessageId();
    stopSpeech();
    automaticSpeech.arm(requestId, selectedVoice);
    automaticRequestId = requestId;
    const request = { type: "observe" as const, characterId: character.value, connectionId: connection.value, deviceId: device.value,
      kind: kind.value as "image" | "video", durationSeconds: Number(duration.value), question: question.value };
    const includeVoice = voiceInput.checked && !trigger.skipVoice;
    const controller = new AbortController(); inputController = controller;
    const timer = window.setTimeout(() => controller.abort(), 60000);
    let dispatched = false;
    let failureMessage = "Share stopped before requesting screen capture.";
    updateControls();
    try {
      await new Promise<void>((resolve, reject) => {
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
      if (disposed || controller.signal.aborted) return;
      clearReply(false);
      if (includeVoice) request.question = await prepareShareQuestion(request.question,
        { connectionId: stt.value, seconds: Number(voiceSeconds.value) }, controller.signal, (inputStage) => {
          stage = inputStage;
          send({ type: "input-stage", targetId: requestId, stage: inputStage });
          notice(inputStage === "listening" ? `Speak now. Listening for ${voiceSeconds.value} seconds, then transcribing automatically. Microphone access may prompt for permission.`
            : "Microphone stopped. Transcribing your question before requesting screen capture…");
          updateControls();
        });
      if (disposed || controller.signal.aborted) return;
      if (includeVoice) element("input-status").textContent = `Included question: ${request.question}`;
      inputController = null; stage = "checking";
      runId = send(request, requestId);
      dispatched = true;
    } catch (error) {
      automaticSpeech.cancel();
      failureMessage = controller.signal.aborted ? "Share cancelled or voice input timed out. Nothing was requested from a model."
        : error instanceof Error ? error.message : "Voice input could not finish; no screen capture was requested.";
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
  listen(audio, "ended", () => { if (snapshot?.activity.requestId) send({ type: "speech-stage", targetId: snapshot.activity.requestId, stage: "idle" }); });
  listen(element("stop-speech"), "click", () => { automaticSpeech.cancel(); stopSpeech(); send({ type: "stop-speech" }); element("speech-status").textContent = "Speech stopped; pending automatic speech is disabled for this share."; });
  listen(element("settings"), "click", () => { options.openSettings ? options.openSettings() : send({ type: "open-settings" }); });
  listen(element("character-voice"), "click", applyCharacterVoice);
  listen(character, "change", () => { queueSettings({ characterId: character.value }); clearReply(); applyCharacterVoice(); });
  for (const { key, control } of settingsControls) listen(control, "input", () => {
    const value = key === "autoSpeak" || key === "voiceInput" ? (control as HTMLInputElement).checked
      : ["durationSeconds", "voiceSeconds", "speed"].includes(key) ? Number(control.value) : control.value;
    queueSettings({ [key]: value }); updateControls();
  });
  listen(element("grant"), "click", () => {
    void ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording"], { reason: "Desk Companion needs grants to select a character, request desktop capture with native approval, and ask your chosen model. Desktop can remember your source and approval." })
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
  const speechListing = listSpeechConnections(listingController.signal).then((connections) => {
    if (disposed) return;
    speechConnections = connections;
    fill(tts, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose a TTS connection", settings().ttsId);
    chooseDefaults();
    initializeCharacterVoice();
    updateControls();
  }).catch(() => { if (!disposed) element("speech-status").textContent = "Configure a TTS connection in Voice settings, then reopen the widget. Observation still works without speech."; });
  const inputListing = listTranscriptionConnections(listingController.signal).then((connections) => {
    if (disposed) return;
    transcriptionConnections = connections;
    fill(stt, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose an STT connection", settings().sttId);
    chooseDefaults();
    if (!supportsVoiceInput()) element("input-status").textContent = "Voice recording is unavailable in this window. Use a secure browser/desktop window with microphone support, or type your question.";
    updateControls();
  }).catch(() => { if (!disposed) element("input-status").textContent = "Configure an STT connection in Voice settings, then reopen the widget. Screen sharing works without voice input."; });
  void Promise.allSettled([speechListing, inputListing]).finally(() => window.clearTimeout(listingTimeout));
  const resynchronize = () => { if (!disposed && document.visibilityState !== "hidden") { send({ type: "subscribe", surface }); refresh(); } };
  window.addEventListener("pageshow", resynchronize);
  window.addEventListener("online", resynchronize);
  document.addEventListener("visibilitychange", resynchronize);
  window.addEventListener("focus", discoverDevices);
  // Discovery only: never request a capture, input, generation, or speech here.
  let discoveryTimer: number;
  const pollDevices = () => { discoverDevices(); discoveryTimer = window.setTimeout(pollDevices, 10000); };
  discoveryTimer = window.setTimeout(pollDevices, 10000);
  cleanups.push(() => { window.removeEventListener("pageshow", resynchronize); window.removeEventListener("online", resynchronize); document.removeEventListener("visibilitychange", resynchronize); window.removeEventListener("focus", discoverDevices); window.clearTimeout(discoveryTimer); });
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
