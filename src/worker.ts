import type { CapturedMediaRef, CharacterDTO, GenerationReasoningOverrideDTO, GenerationRequestDTO, SpindleAPI } from "lumiverse-spindle-types";
import { assembleMessages } from "./prompt";
import { CHANNEL, CHARACTER_PAGE_SIZE, DeskError, ERROR_MESSAGES, MAX_REPLY, characterVoice, mediaSupport, parseClientMessage, record, safeLabel } from "./protocol";
import type { Catalog, CharacterOption, ClientMessage, ErrorCode, ServerMessage } from "./protocol";
import { createCompanionState } from "./companion-state";

export interface Route {
  userId: string;
  frontendSessionId: string;
  clientId: string;
  id: string;
}

interface Run extends Route {
  controller: AbortController;
  timedOut: boolean;
  capture: CapturedMediaRef | null;
}

type Observe = Extract<ClientMessage, { type: "observe" }>;
export type ResponseBody = ServerMessage extends infer Message ? Message extends ServerMessage ? Omit<Message, "channel" | "id" | "clientId"> : never : never;

function characterOption(character: CharacterDTO): CharacterOption {
  return { id: character.id, name: safeLabel(character.name), voice: characterVoice(character.extensions) };
}

function errorCode(error: unknown, stage: "checking" | "consent" | "generating"): ErrorCode {
  if (error instanceof DeskError) return error.code;
  const message = error instanceof Error ? error.message : "";
  if (/PERMISSION_DENIED|permission.*not granted/i.test(message)) return "PERMISSION_REQUIRED";
  if (/CAPTURE_PROVIDER_UNSUPPORTED/.test(message)) return "MEDIA_UNSUPPORTED";
  if (/CAPTURE_DESTINATION_CHANGED/.test(message)) return "DESTINATION_CHANGED";
  if (/CAPTURE_DEVICE_UNAVAILABLE/.test(message)) return "DEVICE_UNAVAILABLE";
  if (stage === "consent") return "CAPTURE_FAILED";
  if (stage === "generating") {
    const status = Number(message.match(/\bfailed\s*\((\d{3})\)/i)?.[1]);
    if (status === 401 || status === 403) return "GENERATION_AUTH_FAILED";
    if (status === 429) return "GENERATION_RATE_LIMITED";
    if ([400, 404, 413, 422].includes(status)) return "GENERATION_INVALID_REQUEST";
    if (status >= 500 && status <= 599) return "GENERATION_UNAVAILABLE";
  }
  return "GENERATION_FAILED";
}

export function installCompanion(api: SpindleAPI, options: { now?: () => number; timeoutMs?: number } = {}): () => void {
  const now = options.now ?? Date.now;
  const active = new Map<string, Run>();
  const lastCapture = new Map<string, number>();
  const catalogJobs = new Set<string>();
  let disposed = false;
  const sharedState = createCompanionState(api, (route) => {
    const run = active.get(route.userId);
    if (run?.id === route.id && run.clientId === route.clientId && run.frontendSessionId === route.frontendSessionId) run.controller.abort();
  }, (route) => {
    if (!compatible()) throw new DeskError("HOST_UNSUPPORTED");
    if (active.has(route.userId) || active.size >= 8) throw new DeskError("BUSY");
    if (lastCapture.has(route.userId) && now() - lastCapture.get(route.userId)! < 10000) throw new DeskError("COOLDOWN");
  });

  function send(route: Route, body: ResponseBody): void {
    if (!disposed) {
      api.sendToFrontend({ channel: CHANNEL, id: route.id, clientId: route.clientId, ...body }, route.userId, { frontendSessionId: route.frontendSessionId });
      sharedState.publish(route, body);
    }
  }

  function failure(route: Route, code: ErrorCode): void {
    send(route, { type: "error", code, message: ERROR_MESSAGES[code] });
  }

  function assertActive(run: Run): void {
    if (disposed || run.controller.signal.aborted) throw new DeskError(run.timedOut ? "TIMED_OUT" : "CANCELLED");
  }

  function compatible(): boolean {
    return api.host.capabilities["desktop-capture-worker-v1"] >= 1
      && api.host.capabilities["frontend-session-routing-v1"] >= 1
      && typeof api.desktop?.capture?.request === "function";
  }

  async function catalog(message: Extract<ClientMessage, { type: "catalog" }>, route: Route): Promise<void> {
    const key = JSON.stringify([route.userId, route.frontendSessionId, route.clientId]);
    if (catalogJobs.has(key) || catalogJobs.size >= 16) { failure(route, "BUSY"); return; }
    catalogJobs.add(key);
    try {
      if (!compatible()) throw new DeskError("HOST_UNSUPPORTED");
      const [characters, connections, devices] = await Promise.all([
        api.characters.list({ limit: CHARACTER_PAGE_SIZE, offset: message.page * CHARACTER_PAGE_SIZE, userId: route.userId }),
        api.connections.list(route.userId),
        api.desktop.capture.listDevices({ userId: route.userId }),
      ]);
      const choices = characters.data.map(characterOption);
      if (message.activeCharacterId && !choices.some((choice) => choice.id === message.activeCharacterId)) {
        const character = await api.characters.get(message.activeCharacterId, route.userId);
        if (character) choices.unshift(characterOption(character));
      }
      const result: Catalog = { characters: choices, characterTotal: characters.total, page: message.page,
        connections: connections.slice(0, 200).map((connection) => ({ id: connection.id, name: safeLabel(connection.name),
          provider: connection.provider, model: safeLabel(connection.model), ...mediaSupport(connection.provider, connection.model) })),
        devices: devices.filter((device) => device.expiresAt > now()).map((device) => ({ id: device.id, name: safeLabel(device.name),
          platform: device.platform, image: device.capabilities.image, video: device.capabilities.video })) };
      send(route, { type: "catalog", catalog: result });
    } catch (error) {
      failure(route, errorCode(error, "checking"));
    } finally {
      catalogJobs.delete(key);
    }
  }

  async function observe(message: Observe, route: Route): Promise<void> {
    if (!compatible()) { failure(route, "HOST_UNSUPPORTED"); return; }
    if (active.has(route.userId) || active.size >= 8) { failure(route, "BUSY"); return; }
    for (const [userId, timestamp] of lastCapture) if (now() - timestamp > 300000) lastCapture.delete(userId);
    if (lastCapture.has(route.userId) && now() - lastCapture.get(route.userId)! < 10000) { failure(route, "COOLDOWN"); return; }
    if (lastCapture.size >= 1024 && !lastCapture.has(route.userId)) { failure(route, "BUSY"); return; }
    const run: Run = { ...route, controller: new AbortController(), timedOut: false, capture: null };
    active.set(route.userId, run);
    const timer = setTimeout(() => { run.timedOut = true; run.controller.abort(); }, options.timeoutMs ?? 240000);
    let stage: "checking" | "consent" | "generating" = "checking";
    try {
      await sharedState.beforeObserve(message, route);
      assertActive(run);
      send(run, { type: "status", stage });
      const [character, connection, devices] = await Promise.all([
        api.characters.get(message.characterId, route.userId),
        api.connections.get(message.connectionId, route.userId),
        api.desktop.capture.listDevices({ userId: route.userId }),
      ]);
      assertActive(run);
      if (!character) throw new DeskError("CHARACTER_UNAVAILABLE");
      if (!connection) throw new DeskError("CONNECTION_UNAVAILABLE");
      const device = devices.find((candidate) => candidate.id === message.deviceId && candidate.expiresAt > now());
      if (!device) throw new DeskError("DEVICE_UNAVAILABLE");
      const support = mediaSupport(connection.provider, connection.model);
      if (!support[message.kind] || !device.capabilities[message.kind]) throw new DeskError("MEDIA_UNSUPPORTED");
      lastCapture.set(route.userId, now());
      stage = "consent";
      send(run, { type: "status", stage });
      const common = { deviceId: device.id, connectionId: connection.id, userId: route.userId,
        purpose: `Desk Companion: react naturally as ${safeLabel(character.name, 60)} to one approved ${message.kind === "image" ? "screenshot" : "video-only recording"}, answering my question if provided. No continuous monitoring or computer actions.` };
      run.capture = await api.desktop.capture.request(message.kind === "image" ? { ...common, kind: "image" }
        : { ...common, kind: "video", mode: "record", durationSeconds: message.durationSeconds });
      assertActive(run);
      if (run.capture.connectionId !== connection.id || run.capture.kind !== message.kind || run.capture.expiresAt <= now()) throw new DeskError("CAPTURE_FAILED");
      stage = "generating";
      send(run, { type: "status", stage });
      const generationTimer = setTimeout(() => { run.timedOut = true; run.controller.abort(); }, 90000);
      let text = "";
      let terminal = false;
      let lastSent = 0;
      const gemini = connection.provider === "google" || connection.provider === "google_vertex";
      const gemini3 = gemini && /(?:^|[/:])gemini-3(?:[.-]|$)/i.test(connection.model);
      const reasoning: GenerationReasoningOverrideDTO = gemini3
        ? { source: "custom", effort: "low", thinkingDisplay: "omitted" } : { source: "off" };
      const generationRequest: GenerationRequestDTO & { type: "raw"; provider: string; model: string } = {
        type: "raw", provider: connection.provider, model: connection.model,
        connection_id: connection.id, userId: route.userId,
        messages: assembleMessages(character, message.question, run.capture), parameters: { max_tokens: gemini ? 4096 : 512 },
        tools: [], reasoning, signal: run.controller.signal,
      };
      try {
        for await (const chunk of api.generate.rawStream(generationRequest)) {
          assertActive(run);
          if (chunk.type === "token") {
            if (text.length + chunk.token.length > MAX_REPLY) throw new DeskError("OUTPUT_LIMIT");
            text += chunk.token;
            if (now() - lastSent >= 100) { send(run, { type: "text", text }); lastSent = now(); }
          } else if (chunk.type === "done") {
            if (chunk.content.length > MAX_REPLY) throw new DeskError("OUTPUT_LIMIT");
            const finish = chunk.finish_reason?.toLowerCase();
            if (finish === "max_tokens" || finish === "length") throw new DeskError("GENERATION_TOKEN_LIMIT");
            if (["safety", "blocklist", "prohibited_content", "recitation"].includes(finish ?? "")) throw new DeskError("GENERATION_BLOCKED");
            if (finish && !["stop", "end_turn", "stop_sequence", "eos"].includes(finish)) throw new DeskError("GENERATION_INCOMPLETE");
            if (chunk.tool_calls?.length) throw new DeskError("GENERATION_FAILED");
            if (!chunk.content.trim()) throw new DeskError("GENERATION_NO_TEXT");
            text = chunk.content.trim();
            terminal = true;
          }
        }
      } finally {
        clearTimeout(generationTimer);
      }
      assertActive(run);
      if (!terminal) throw new DeskError("GENERATION_INCOMPLETE");
      send(run, { type: "complete", text, characterName: safeLabel(character.name), voice: characterVoice(character.extensions),
        capture: { kind: run.capture.kind, width: run.capture.width, height: run.capture.height,
          ...(run.capture.durationSeconds === undefined ? {} : { durationSeconds: run.capture.durationSeconds }) } });
    } catch (error) {
      const code = run.controller.signal.aborted ? run.timedOut ? "TIMED_OUT" : "CANCELLED" : errorCode(error, stage);
      run.controller.abort();
      failure(run, code);
    } finally {
      clearTimeout(timer);
      if (run.capture) {
        try { await api.desktop.capture.release(run.capture.assetId, { userId: route.userId }); } catch {}
        run.capture = null;
      }
      if (active.get(route.userId) === run) active.delete(route.userId);
    }
  }

  const unsubscribeMessages = api.onFrontendMessage((payload, userId, frontendSessionId) => {
    if (disposed || typeof userId !== "string" || !userId || typeof frontendSessionId !== "string" || !frontendSessionId) return;
    const message = parseClientMessage(payload);
    if (!message) return;
    const route: Route = { userId, frontendSessionId, clientId: message.clientId, id: message.id };
    if (message.type === "cancel") {
      const run = active.get(userId);
      if (run && run.frontendSessionId === frontendSessionId && run.clientId === message.clientId && run.id === message.targetId) {
        run.controller.abort();
        send(run, { type: "status", stage: "cancelling" });
      }
      return;
    }
    if (message.type === "catalog") void catalog(message, route);
    else if (message.type === "observe") void observe(message, route);
    else void sharedState.handle(message, route).catch((error) => failure(route, error instanceof DeskError ? error.code : "SETTINGS_FAILED"));
  });
  const unsubscribeClosed = api.on("FRONTEND_SESSION_CLOSED", (payload, userId) => {
    if (!record(payload) || typeof payload.frontendSessionId !== "string" || !payload.frontendSessionId || !userId) return;
    const run = active.get(userId);
    if (run?.frontendSessionId === payload.frontendSessionId) run.controller.abort();
    sharedState.closeSession(userId, payload.frontendSessionId);
  });
  const unsubscribePermissions = api.on("PERMISSION_CHANGED", (detail) => {
    if (!detail.granted && ["characters", "generation", "screen_capture", "screen_recording"].includes(detail.permission)) {
      for (const run of active.values()) run.controller.abort();
      sharedState.revoke();
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribeMessages(); unsubscribeClosed(); unsubscribePermissions();
    for (const run of active.values()) run.controller.abort();
    lastCapture.clear();
    sharedState.dispose();
  };
}
