import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { CHANNEL, CHARACTER_PAGE_SIZE, MAX_QUESTION, REQUIRED_PERMISSIONS, record } from "./protocol";
import type { Catalog, CharacterOption, ClientMessage, ServerMessage, VoiceRef } from "./protocol";
import { MAX_SPEECH_CHARS, listSpeechConnections, synthesizeReply } from "./speech";
import type { SpeechConnection } from "./speech";
import { listTranscriptionConnections, supportsVoiceInput } from "./speech-input";
import type { TranscriptionConnection } from "./speech-input";
import { AutomaticShareSpeech, prepareShareQuestion } from "./share-workflow";

export function mountView(ctx: SpindleFrontendContext, root: HTMLElement): { panel: HTMLElement; dispose: () => void } {
  const clientId = crypto.randomUUID();
  const panel = document.createElement("section");
  panel.className = "dc-shell";
  panel.setAttribute("aria-label", "Desk Companion");
  panel.innerHTML = `
    <header><span class="dc-mark" aria-hidden="true">✦</span><div><h2>Desk Companion</h2><div class="dc-subtitle">Your character, a little closer.</div></div><span class="dc-badge" data-role="badge">Ready</span></header>
    <label class="dc-field">Character<select data-role="character" aria-label="Character"><option value="">Grant permissions, then refresh</option></select></label>
    <div class="dc-page"><button data-role="previous" type="button">Previous</button><span data-role="page">Character library</span><button data-role="next" type="button">Next</button></div>
    <label class="dc-field">Model connection<select data-role="connection" aria-label="Model connection"><option value="">Choose a multimodal connection</option></select></label>
    <label class="dc-field">Desktop device<select data-role="device" aria-label="Desktop device"><option value="">Enable capture in the desktop tray</option></select></label>
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
    <div class="dc-row dc-actions"><button class="dc-primary" data-role="observe" type="button">Look at my screen</button><button data-role="cancel" type="button" disabled>Cancel request</button></div>
    <div class="dc-status" data-role="status" role="status" aria-live="polite">Choose a source in the trusted native picker; review it and explicitly Share before a model sees it.</div>
    <div class="dc-reply"><div class="dc-reply-name" data-role="speaker">A fresh perspective</div><div class="dc-reply-text" data-role="reply">Your character's response appears here. Replies are kept only in this widget's memory.</div></div>
    <details data-role="speech-options"><summary>Character voice · text-to-speech</summary>
      <label class="dc-field">TTS connection<select data-role="tts" aria-label="TTS connection"><option value="">Choose a TTS connection</option></select></label>
      <div class="dc-row"><label class="dc-field">Voice ID (blank = connection default)<input data-role="voice" aria-label="Voice ID" maxlength="256" placeholder="Connection default"></label><label class="dc-field" style="max-width:80px">Speed<input data-role="speed" aria-label="Speech speed" type="number" value="1" min="0.25" max="4" step="0.05"></label></div>
      <div class="dc-row"><button data-role="character-voice" type="button">Use character voice</button><button data-role="speak" type="button" disabled>Speak reply</button><button data-role="stop-speech" type="button">Stop</button></div>
      <p class="dc-note">Speech sends reply text to the selected TTS provider. Enable automatic speech above to run it after each approved share; otherwise use Speak reply. Capture pixels and videos never enter this widget.</p>
      <div class="dc-note" data-role="speech-status" role="status" aria-live="polite"></div><audio data-role="audio" controls preload="none" hidden></audio>
    </details>
    <footer class="dc-footer"><span>One request. One approved capture.</span><div class="dc-row"><button data-role="refresh" type="button">Refresh</button><button data-role="grant" type="button">Permissions</button><button data-role="clear" type="button">Clear</button></div></footer>`;
  root.append(panel);

  function element<ElementType extends HTMLElement>(role: string): ElementType {
    const found = panel.querySelector<ElementType>(`[data-role="${role}"]`);
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
  let granted: string[] = [];
  let catalog: Catalog | null = null;
  let catalogId: string | null = null;
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
  const listingController = new AbortController();
  const cleanups: Array<() => void> = [];

  function listen(target: HTMLElement, event: string, handler: () => void): void {
    target.addEventListener(event, handler);
    cleanups.push(() => target.removeEventListener(event, handler));
  }

  function send(body: Omit<Extract<ClientMessage, { type: "catalog" }>, "channel" | "id" | "clientId"> | Omit<Extract<ClientMessage, { type: "observe" }>, "channel" | "id" | "clientId"> | Omit<Extract<ClientMessage, { type: "cancel" }>, "channel" | "id" | "clientId">, id: string = crypto.randomUUID()): string {
    ctx.sendToBackend({ channel: CHANNEL, clientId, id, ...body });
    return id;
  }

  function notice(text: string, error = false): void {
    status.textContent = text;
    status.dataset.error = String(error);
  }

  function fill(select: HTMLSelectElement, choices: Array<{ id: string; label: string }>, placeholder: string, preferred?: string): void {
    const previous = preferred ?? select.value;
    select.replaceChildren(new Option(placeholder, ""));
    for (const choice of choices) select.append(new Option(choice.label, choice.id));
    if (choices.some((choice) => choice.id === previous)) select.value = previous;
    else if (choices.length === 1) select.value = choices[0].id;
  }

  function selectedCharacter(): CharacterOption | undefined { return catalog?.characters.find((entry) => entry.id === character.value); }

  function applyCharacterVoice(): void {
    const chosen = completedVoice ?? selectedCharacter()?.voice;
    if (chosen && speechConnections.some((entry) => entry.id === chosen.connectionId)) {
      tts.value = chosen.connectionId; voice.value = chosen.voice; speed.value = String(chosen.speed ?? 1);
      element("speech-status").textContent = "Using the character's configured voice. You can override it here.";
    } else {
      element("speech-status").textContent = "No accessible character voice is configured. Choose a TTS connection and optional voice ID.";
    }
    updateControls();
  }

  function updateControls(): void {
    const busy = runId !== null || inputController !== null;
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
    element<HTMLButtonElement>("observe").disabled = busy || !hasGrants || !supported || !character.value
      || question.value.length > MAX_QUESTION || (video && !validDuration) || (autoSpeak.checked && !validVoice) || (voiceInput.checked && !validInput);
    element("observe").textContent = video ? "Record an approved clip" : "Look at my screen";
    element<HTMLButtonElement>("cancel").disabled = !busy || stage === "cancelling";
    element<HTMLButtonElement>("speak").disabled = busy || !completedText || !validVoice || speechController !== null || completedText.length > MAX_SPEECH_CHARS;
    element<HTMLButtonElement>("character-voice").disabled = busy;
    element<HTMLButtonElement>("refresh").disabled = busy || catalogId !== null;
    element<HTMLButtonElement>("grant").disabled = busy;
    element<HTMLButtonElement>("previous").disabled = busy || catalogId !== null || !catalog || catalog.page === 0;
    element<HTMLButtonElement>("next").disabled = busy || catalogId !== null || !catalog || (catalog.page + 1) * CHARACTER_PAGE_SIZE >= catalog.characterTotal;
    badge.dataset.busy = String(busy);
    badge.textContent = busy ? stage === "listening" ? "Listening" : stage === "transcribing" ? "Transcribing" : stage === "consent" ? "Native consent" : stage === "generating" ? "Thinking" : stage === "cancelling" ? "Cancelling" : "Checking" : "Ready";
    const destination = element("destination");
    destination.textContent = chosenConnection ? `${chosenConnection.provider} · ${chosenConnection.model} · ${chosenDevice?.name ?? "choose a desktop"}${supported ? "" : " · media not supported"}` : "Choose the model destination before requesting a capture.";
    const inputDestination = transcriptionConnections.find((entry) => entry.id === stt.value);
    const speechDestination = speechConnections.find((entry) => entry.id === tts.value);
    element("workflow-summary").textContent = `${voiceInput.checked ? `Listen ${voiceSeconds.value}s → ${inputDestination?.name ?? "choose STT"} → ` : ""}Approved share → character reaction${autoSpeak.checked ? ` → ${speechDestination?.name ?? "choose TTS below"}` : " (text only)"}.`
      + (voiceInput.checked ? " Microphone audio is sent to the STT provider before the native screen picker opens; no background listening." : " Voice input is off.");
  }

  function stopSpeech(): void {
    speechController?.abort(); speechController = null;
    audio.pause(); audio.removeAttribute("src"); audio.load(); audio.hidden = true;
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    updateControls();
  }

  function clearReply(): void {
    automaticSpeech.cancel();
    element("input-status").textContent = "";
    stopSpeech(); completedText = ""; completedVoice = null;
    reply.textContent = "Your character's response appears here. Nothing is saved to chat history.";
    element("speaker").textContent = "A fresh perspective";
    element("speech-status").textContent = "";
    updateControls();
  }

  function cancel(): void {
    automaticSpeech.cancel(); inputController?.abort();
    stopSpeech();
    if (runId && stage !== "cancelling") {
      send({ type: "cancel", targetId: runId }); stage = "cancelling";
      notice("Generation is being cancelled. A pending native capture must be stopped with the native panel's Stop & Discard control.");
      updateControls();
    }
  }

  function refresh(page = catalog?.page ?? 0): void {
    if (disposed || catalogId) return;
    if (!REQUIRED_PERMISSIONS.filter((permission) => permission !== "screen_capture").every((permission) => granted.includes(permission))
      || (!granted.includes("screen_capture") && !granted.includes("screen_recording"))) {
      notice("Grant UI Panels, Characters, Generation, and at least one capture permission using Permissions."); return;
    }
    catalogId = send({ type: "catalog", page, activeCharacterId: character.value || ctx.getActiveChat().characterId || undefined });
    updateControls();
  }

  async function speak(selectedVoice?: VoiceRef): Promise<void> {
    if (!completedText || (!selectedVoice && !tts.value) || speechController || disposed) return;
    element<HTMLDetailsElement>("speech-options").open = true;
    stopSpeech();
    const controller = new AbortController(); speechController = controller;
    const timer = window.setTimeout(() => {
      if (speechController === controller) { stopSpeech(); if (!disposed) element("speech-status").textContent = "Speech stopped or timed out."; }
    }, 45000);
    element("speech-status").textContent = "Synthesizing with your selected TTS connection…";
    updateControls();
    try {
      const blob = await synthesizeReply(completedText, selectedVoice ?? { connectionId: tts.value, voice: voice.value, speed: Number(speed.value) }, controller.signal);
      if (disposed || controller.signal.aborted || speechController !== controller) return;
      audioUrl = URL.createObjectURL(blob); audio.src = audioUrl; audio.hidden = false;
      try {
        await audio.play();
        if (!disposed && speechController === controller) element("speech-status").textContent = "Speaking. Use the player to pause or replay.";
      } catch {
        if (!disposed && speechController === controller) element("speech-status").textContent = "Audio is ready. Your browser requires pressing Play in the audio controls.";
      }
    } catch (error) {
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
    if (message.id === catalogId) {
      if (message.type === "catalog") {
        catalog = message.catalog; catalogId = null;
        const preferred = character.value || ctx.getActiveChat().characterId || undefined;
        fill(character, catalog.characters.map((entry) => ({ id: entry.id, label: entry.name })), "Choose a character", preferred);
        fill(connection, catalog.connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.model}` })), "Choose a model connection");
        fill(device, catalog.devices.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.platform}` })), "Enable capture in the desktop tray");
        element("page").textContent = `Page ${catalog.page + 1} · ${catalog.characterTotal} characters`;
        if (!catalog.devices.length) notice("No capture desktop is registered. Enable Extension Screen Capture in the desktop tray, then Refresh.");
        else notice("Choose a source, preview it locally, then Share. Refresh after enabling or switching desktop instances.");
        if (!tts.value) applyCharacterVoice();
      } else if (message.type === "error") { catalogId = null; notice(message.message, true); }
      updateControls(); return;
    }
    if (message.id !== runId) return;
    if (message.type === "status") {
      stage = message.stage;
      const messages = { checking: "Verifying the character, model, and desktop for your account…", consent: "Use the trusted native consent panel and system picker. Preview, then Share or Stop & Discard. Nothing is sent to a model before Share.",
        generating: "The approved capture is attached privately. Your character is thinking…", cancelling: "Generation cancelled. Use Stop & Discard in any native capture panel still open; waiting for that request to finish." };
      notice(messages[message.stage]);
    } else if (message.type === "text" && stage !== "cancelling") reply.textContent = message.text;
    else if (message.type === "complete") {
      const chosenVoice = automaticSpeech.take(message.id);
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

  async function share(): Promise<void> {
    if (element<HTMLButtonElement>("observe").disabled) return;
    clearReply();
    const selectedVoice = autoSpeak.checked ? { connectionId: tts.value, voice: voice.value, speed: Number(speed.value) } : null;
    const requestId = crypto.randomUUID();
    automaticSpeech.arm(requestId, selectedVoice);
    const request = { type: "observe" as const, characterId: character.value, connectionId: connection.value, deviceId: device.value,
      kind: kind.value as "image" | "video", durationSeconds: Number(duration.value), question: question.value };
    const controller = new AbortController(); inputController = controller;
    const timer = window.setTimeout(() => controller.abort(), 60000);
    updateControls();
    try {
      if (voiceInput.checked) request.question = await prepareShareQuestion(request.question,
        { connectionId: stt.value, seconds: Number(voiceSeconds.value) }, controller.signal, (inputStage) => {
          stage = inputStage;
          notice(inputStage === "listening" ? `Speak now. Listening for ${voiceSeconds.value} seconds, then transcribing automatically. Microphone access may prompt for permission.`
            : "Microphone stopped. Transcribing your question before requesting screen consent…");
          updateControls();
        });
      if (disposed || controller.signal.aborted) return;
      if (voiceInput.checked) element("input-status").textContent = `Included question: ${request.question}`;
      inputController = null; stage = "checking";
      runId = send(request, requestId);
    } catch (error) {
      automaticSpeech.cancel();
      if (!disposed) { stage = "idle"; notice(controller.signal.aborted ? "Share cancelled or voice input timed out. Nothing was requested from a model."
        : error instanceof Error ? error.message : "Voice input could not finish; no screen capture was requested.", true); }
    } finally {
      window.clearTimeout(timer);
      if (inputController === controller) inputController = null;
      if (!disposed) updateControls();
    }
  }
  listen(element("observe"), "click", () => { void share(); });
  listen(element("cancel"), "click", cancel);
  listen(element("clear"), "click", () => { cancel(); clearReply(); });
  listen(element("refresh"), "click", () => refresh());
  listen(element("previous"), "click", () => refresh(Math.max(0, (catalog?.page ?? 0) - 1)));
  listen(element("next"), "click", () => refresh((catalog?.page ?? 0) + 1));
  listen(element("speak"), "click", () => { void speak(); });
  listen(element("stop-speech"), "click", () => { automaticSpeech.cancel(); stopSpeech(); element("speech-status").textContent = "Speech stopped; pending automatic speech is disabled for this share."; });
  listen(element("character-voice"), "click", applyCharacterVoice);
  listen(character, "change", () => { clearReply(); applyCharacterVoice(); });
  for (const control of [connection, device, kind, duration, question, tts, voice, speed, autoSpeak, voiceInput, stt, voiceSeconds]) listen(control, "input", updateControls);
  listen(element("grant"), "click", () => {
    void ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording"], { reason: "Desk Companion needs explicit grants to select a character, request a reviewed desktop capture, and ask your chosen model." })
      .then((permissions) => { if (!disposed) { granted = permissions; refresh(); updateControls(); } })
      .catch(() => { if (!disposed) notice("Permission request was declined. An administrator/owner must approve capture grants.", true); });
  });
  cleanups.push(ctx.events.on("SPINDLE_PERMISSION_CHANGED", (payload) => {
    if (!record(payload) || payload.extensionId !== ctx.manifest.identifier) return;
    if (payload.granted === false) { cancel(); clearReply(); }
    void ctx.permissions.getGranted().then((permissions) => { if (!disposed) { granted = permissions; updateControls(); } }).catch(() => {});
  }));
  void ctx.permissions.getGranted().then((permissions) => { if (!disposed) { granted = permissions; refresh(0); updateControls(); } })
    .catch(() => { if (!disposed) notice("Cannot read grants. Check the extension's permissions.", true); });
  const listingTimeout = window.setTimeout(() => listingController.abort(), 15000);
  const speechListing = listSpeechConnections(listingController.signal).then((connections) => {
    if (disposed) return;
    speechConnections = connections;
    fill(tts, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose a TTS connection");
    applyCharacterVoice();
  }).catch(() => { if (!disposed) element("speech-status").textContent = "Configure a TTS connection in Voice settings, then reopen the widget. Observation still works without speech."; });
  const inputListing = listTranscriptionConnections(listingController.signal).then((connections) => {
    if (disposed) return;
    transcriptionConnections = connections;
    fill(stt, connections.map((entry) => ({ id: entry.id, label: `${entry.name} · ${entry.provider}` })), "Choose an STT connection");
    if (!supportsVoiceInput()) element("input-status").textContent = "Voice recording is unavailable in this window. Use a secure browser/desktop window with microphone support, or type your question.";
    updateControls();
  }).catch(() => { if (!disposed) element("input-status").textContent = "Configure an STT connection in Voice settings, then reopen the widget. Screen sharing works without voice input."; });
  void Promise.allSettled([speechListing, inputListing]).finally(() => window.clearTimeout(listingTimeout));
  updateControls();

  return { panel, dispose: () => {
    if (disposed) return;
    cancel(); disposed = true; listingController.abort(); stopSpeech();
    window.clearTimeout(listingTimeout);
    for (const cleanup of cleanups.splice(0)) cleanup();
    completedText = ""; completedVoice = null; catalog = null;
    panel.replaceChildren(); panel.remove();
  } };
}
