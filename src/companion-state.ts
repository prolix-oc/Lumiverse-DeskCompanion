import type { SpindleAPI } from "lumiverse-spindle-types";
import { CHANNEL, createMessageId, DeskError, safeLabel } from "./protocol";
import type { ClientMessage } from "./protocol";
import { DEFAULT_SETTINGS, idleActivity, parseSettings } from "./settings";
import type { CompanionSettings, CompanionSnapshot } from "./settings";
import type { ResponseBody, Route } from "./worker";

export const SETTINGS_PATH = "companion-settings.json";

interface UserState extends CompanionSnapshot {
  subscribers: Map<string, Route & { surface: "settings" | "widget" }>;
  owner: Route | null;
  speechOwner: Route | null;
  frozen: CompanionSettings | null;
  capturing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  queue: Promise<unknown>;
  queued: number;
}

function routeKey(route: Route): string { return JSON.stringify([route.frontendSessionId, route.clientId]); }
function owns(state: UserState, route: Route): boolean {
  return state.owner?.frontendSessionId === route.frontendSessionId && state.owner.clientId === route.clientId && state.owner.id === route.id;
}

export function createCompanionState(api: SpindleAPI, cancelRun: (route: Route) => void, checkBegin: (route: Route) => void) {
  const users = new Map<string, Promise<UserState>>();
  const resolved = new Map<string, UserState>();
  const pendingSessions = new Map<string, { count: number; closed: boolean }>();
  let disposed = false;
  const epoch = createMessageId();

  async function load(userId: string): Promise<UserState> {
    const existing = users.get(userId);
    if (existing) return existing;
    if (users.size >= 128 || disposed) throw new DeskError("BUSY");
    const loading = (async () => {
      const saved = await api.userStorage.getJson<{ revision: number; settings: unknown } | null>(SETTINGS_PATH, { fallback: null, userId });
      if (disposed) throw new DeskError("CANCELLED");
      const settings = parseSettings(saved?.settings);
      const state: UserState = { epoch, sequence: 0, revision: settings && Number.isSafeInteger(saved?.revision) && saved!.revision >= 0 ? saved!.revision : 0,
        settings: settings ?? { ...DEFAULT_SETTINGS }, activity: idleActivity(), subscribers: new Map(), owner: null, speechOwner: null, frozen: null,
        capturing: false, timer: null, queue: Promise.resolve(), queued: 0 };
      resolved.set(userId, state);
      return state;
    })();
    users.set(userId, loading);
    try { return await loading; } catch (error) { users.delete(userId); throw error; }
  }

  function release(state: UserState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null; state.capturing = false; state.frozen = null;
  }

  function snapshot(state: UserState): CompanionSnapshot {
    return { epoch, sequence: state.sequence, revision: state.revision, settings: { ...state.settings }, activity: { ...state.activity } };
  }

  function broadcast(state: UserState, acknowledgement?: Route): void {
    if (disposed) return;
    state.sequence += 1;
    for (const subscriber of state.subscribers.values()) {
      const id = acknowledgement && routeKey(subscriber) === routeKey(acknowledgement) ? acknowledgement.id : subscriber.id;
      api.sendToFrontend({ channel: CHANNEL, clientId: subscriber.clientId, id, type: "state", snapshot: snapshot(state) },
        subscriber.userId, { frontendSessionId: subscriber.frontendSessionId });
    }
  }

  function stopLocal(state: UserState, speechOnly: boolean): void {
    const owner = speechOnly ? state.speechOwner ?? state.owner : state.owner;
    if (!owner || disposed) return;
    api.sendToFrontend({ channel: CHANNEL, id: owner.id, clientId: owner.clientId, type: "stop-local",
      targetId: owner.id, speechOnly }, owner.userId, { frontendSessionId: owner.frontendSessionId });
    if (speechOnly) { state.speechOwner = null; state.activity.speechStage = "idle"; state.activity.speechClientId = null; }
  }

  function cancel(state: UserState): void {
    if (state.activity.stage === "idle") return;
    stopLocal(state, false);
    if (state.owner && state.capturing) {
      state.activity.stage = "cancelling";
      state.activity.message = "Cancelling. Use Stop & Discard in any native capture panel still open.";
      cancelRun(state.owner);
    } else {
      release(state); state.activity.stage = "idle";
      state.activity.message = "Share cancelled. No screen capture or generation was requested.";
    }
    broadcast(state);
  }

  function claim(state: UserState, route: Route): void {
    stopLocal(state, true);
    state.owner = route; state.frozen = { ...state.settings };
    state.activity = { ...idleActivity(), requestId: route.id, ownerClientId: route.clientId, stage: "checking",
      message: "Preparing one approved share…" };
    state.timer = setTimeout(() => cancel(state), 300000);
  }

  async function handle(message: ClientMessage, route: Route): Promise<boolean> {
    if (["observe", "catalog", "cancel"].includes(message.type)) return false;
    const sessionKey = JSON.stringify([route.userId, route.frontendSessionId]);
    const session = pendingSessions.get(sessionKey) ?? { count: 0, closed: false };
    session.count += 1; pendingSessions.set(sessionKey, session);
    try {
      return await handleOpen(message, route, session);
    } finally {
      session.count -= 1;
      if (!session.count) pendingSessions.delete(sessionKey);
    }
  }

  async function handleOpen(message: ClientMessage, route: Route, session: { closed: boolean }): Promise<boolean> {
    const state = await load(route.userId);
    if (state.queued >= 32) throw new DeskError("BUSY");
    state.queued += 1;
    const operation = state.queue.catch(() => {}).then(async () => {
      if (disposed || session.closed) return;
      const key = routeKey(route);
      if (message.type === "subscribe") {
        if (state.subscribers.size >= 16 && !state.subscribers.has(key)) throw new DeskError("BUSY");
        state.subscribers.set(key, { ...route, surface: message.surface ?? "widget" }); broadcast(state, route); return;
      }
      if (message.type === "unsubscribe") {
        state.subscribers.delete(key);
        if (state.owner && routeKey(state.owner) === key && !state.capturing) cancel(state);
        return;
      }
      if (!state.subscribers.has(key)) throw new DeskError("INVALID_REQUEST");
      if (message.type === "configure") {
        if (state.activity.stage !== "idle") throw new DeskError("BUSY");
        const settings = { ...state.settings, ...message.patch };
        const revision = state.revision + 1;
        await api.userStorage.setJson(SETTINGS_PATH, { revision, settings }, { userId: route.userId });
        if (disposed) return;
        state.settings = settings; state.revision = revision; broadcast(state, route);
      } else if (message.type === "begin-share") {
        checkBegin(route);
        if (state.activity.stage !== "idle") throw new DeskError("BUSY");
        if (state.revision !== message.revision) { broadcast(state, route); throw new DeskError("SETTINGS_CHANGED"); }
        claim(state, route); broadcast(state, route);
      } else if (message.type === "input-stage" || message.type === "input-ended") {
        if (state.capturing || state.activity.stage === "idle" || !owns(state, { ...route, id: message.targetId })) return;
        if (message.type === "input-stage") {
          state.activity.stage = message.stage;
          state.activity.message = message.stage === "listening" ? "Listening to the spoken question…" : "Transcribing before requesting screen consent…";
        } else {
          release(state); state.activity.stage = "idle"; state.activity.error = true;
          state.activity.message = safeLabel(message.message, 400);
        }
        broadcast(state);
      } else if (message.type === "cancel-shared") {
        if (state.activity.requestId === message.targetId) cancel(state);
      } else if (message.type === "clear-state") {
        cancel(state); stopLocal(state, true);
        state.activity.text = ""; state.activity.voice = null; state.activity.characterName = "A fresh perspective";
        broadcast(state);
      } else if (message.type === "stop-speech") { stopLocal(state, true); broadcast(state); }
      else if (message.type === "speech-stage") {
        if (state.activity.stage !== "idle" || !state.activity.text || state.activity.requestId !== message.targetId) return;
        if (message.stage === "idle") {
          if (!state.speechOwner || routeKey(state.speechOwner) !== key) return;
          state.speechOwner = null; state.activity.speechClientId = null;
        } else {
          if (state.speechOwner && routeKey(state.speechOwner) !== key) stopLocal(state, true);
          state.speechOwner = { ...route, id: message.targetId }; state.activity.speechClientId = route.clientId;
        }
        state.activity.speechStage = message.stage; broadcast(state);
      }
      else if (message.type === "open-settings") {
        for (const subscriber of state.subscribers.values()) if (subscriber.surface === "settings") {
          api.sendToFrontend({ channel: CHANNEL, id: subscriber.id, clientId: subscriber.clientId, type: "open-settings" },
            subscriber.userId, { frontendSessionId: subscriber.frontendSessionId });
        }
      }
    });
    state.queue = operation;
    try { await operation; return true; } finally { state.queued -= 1; }
  }

  async function beforeObserve(message: Extract<ClientMessage, { type: "observe" }>, route: Route): Promise<void> {
    const state = await load(route.userId);
    if (state.activity.stage !== "idle" && !owns(state, route)) throw new DeskError("BUSY");
    if (state.activity.stage !== "idle" && state.frozen) {
      for (const key of ["characterId", "connectionId", "deviceId", "kind", "durationSeconds"] as const) {
        if (message[key] !== state.frozen[key]) throw new DeskError("SETTINGS_CHANGED");
      }
    } else claim(state, route);
    state.capturing = true;
    broadcast(state);
  }

  function publish(route: Route, body: ResponseBody): void {
    const state = resolved.get(route.userId);
    if (!state || !owns(state, route) || state.activity.stage === "idle") return;
    if (body.type === "status") {
      state.activity.stage = body.stage;
      state.activity.message = body.stage === "consent" ? "Use the native picker, preview, then Share or Stop & Discard."
        : body.stage === "generating" ? "Your character is reacting to the approved capture…"
        : body.stage === "cancelling" ? "Cancelling. Use Stop & Discard in any native capture panel still open." : "Checking character, model, and desktop…";
    } else if (body.type === "text") state.activity.text = body.text;
    else if (body.type === "complete") {
      release(state); state.activity.stage = "idle"; state.activity.text = body.text;
      state.activity.characterName = body.characterName; state.activity.voice = body.voice;
      state.activity.message = `Answered using one approved ${body.capture.kind}: ${body.capture.width} × ${body.capture.height}.`;
    } else if (body.type === "error") {
      release(state); state.activity = { ...idleActivity(), requestId: route.id, ownerClientId: route.clientId, message: body.message, error: true };
    } else return;
    broadcast(state);
  }

  function closeSession(userId: string, frontendSessionId: string): void {
    const pending = pendingSessions.get(JSON.stringify([userId, frontendSessionId]));
    if (pending) pending.closed = true;
    const state = resolved.get(userId);
    if (!state) return;
    for (const [key, subscriber] of state.subscribers) if (subscriber.frontendSessionId === frontendSessionId) state.subscribers.delete(key);
    if (state.owner?.frontendSessionId === frontendSessionId) cancel(state);
    if (state.speechOwner?.frontendSessionId === frontendSessionId) { stopLocal(state, true); broadcast(state); }
  }

  function revoke(): void { for (const state of resolved.values()) { cancel(state); stopLocal(state, true); state.activity.text = ""; state.activity.voice = null; state.activity.characterName = "A fresh perspective"; broadcast(state); } }
  function dispose(): void {
    disposed = true;
    for (const state of resolved.values()) { release(state); state.subscribers.clear(); }
    users.clear(); resolved.clear(); pendingSessions.clear();
  }

  return { handle, beforeObserve, publish, closeSession, revoke, dispose };
}
