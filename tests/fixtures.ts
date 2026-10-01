import type { CapturedMediaRef, CharacterDTO, SpindleAPI, StreamChunkDTO } from "lumiverse-spindle-types";
import { CHANNEL } from "../src/protocol";

export const CHARACTER = {
  id: "character-a", name: "Mira", description: "A curious companion.", personality: "Warm and observant.", scenario: "Beside your desktop.",
  first_mes: "Hello!", mes_example: "Mira: Let's take a closer look.", creator_notes: "", system_prompt: "Stay curious.", post_history_instructions: "Be concise.",
  extensions: { ttsVoice: { connectionId: "voice-a", voice: "warm", parameters: { speed: 1.1 } }, unrelated: "must not reach frontend" },
  tags: [], alternate_greetings: [], creator: "", image_id: null, world_book_ids: [], created_at: 0, updated_at: 0,
} satisfies CharacterDTO;

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((fulfilled, rejected) => { resolve = fulfilled; reject = rejected; });
  return { promise, resolve, reject };
}

export async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

export function fixture() {
  const now = Date.now();
  const capture: CapturedMediaRef = { assetId: "private-asset-a", kind: "image", mimeType: "image/png", width: 800, height: 600,
    connectionId: "model-a", expiresAt: now + 120000 };
  const connection = { id: "model-a", name: "Vision model", provider: "google", model: "gemini-2.5-flash", metadata: { secret: "must not reach frontend" } };
  const device = { id: "desktop-a", name: "My desktop", platform: "windows", capabilities: { image: true, video: true, replay: false }, expiresAt: now + 45000 };
  const sent: Array<{ payload: any; userId?: string; options?: { frontendSessionId?: string } }> = [];
  const gets: Array<{ kind: string; userId?: string }> = [];
  const requests: any[] = [];
  const generations: any[] = [];
  const released: Array<{ assetId: string; userId?: string }> = [];
  const events = new Map<string, (...args: any[]) => void>();
  const stored = new Map<string, unknown>();
  let handler: (payload: unknown, userId: string, frontendSessionId?: string) => void = () => {};
  const api = {
    userStorage: {
      async getJson(path: string, options: { fallback?: unknown; userId?: string } = {}) { return stored.get(JSON.stringify([options.userId, path])) ?? options.fallback; },
      async setJson(path: string, value: unknown, options: { userId?: string } = {}) { stored.set(JSON.stringify([options.userId, path]), structuredClone(value)); },
    },
    host: { descriptorVersion: 1, lumiverseVersion: "1.2.4", extensionInstallationId: "installation-a", capabilities: { "desktop-capture-worker-v1": 1, "frontend-session-routing-v1": 1 } },
    onFrontendMessage(callback: typeof handler) { handler = callback; return () => { handler = () => {}; }; },
    sendToFrontend(payload: unknown, userId?: string, options?: { frontendSessionId?: string }) { sent.push({ payload, userId, options }); },
    on(event: string, callback: (...args: any[]) => void) { events.set(event, callback); return () => events.delete(event); },
    characters: {
      async list(input: any) { gets.push({ kind: "characters", userId: input.userId }); return { data: [CHARACTER], total: 1 }; },
      async get(_: string, userId?: string) { gets.push({ kind: "character", userId }); return CHARACTER; },
    },
    connections: {
      async list(userId?: string) { gets.push({ kind: "connections", userId }); return [connection]; },
      async get(_: string, userId?: string) { gets.push({ kind: "connection", userId }); return connection; },
    },
    desktop: { capture: {
      async listDevices(input: any) { gets.push({ kind: "devices", userId: input.userId }); return [device]; },
      async request(input: any) { requests.push(input); return { ...capture, kind: input.kind, durationSeconds: input.kind === "video" ? input.durationSeconds : undefined }; },
      async release(assetId: string, options?: { userId?: string }) { released.push({ assetId, userId: options?.userId }); },
    } },
    generate: {
      async *rawStream(input: any): AsyncGenerator<StreamChunkDTO> {
        generations.push(input);
        yield { type: "reasoning", token: "private reasoning" };
        yield { type: "token", token: "You have a calendar open." };
        yield { type: "done", content: "You have a calendar open.", finish_reason: "stop" };
      },
    },
  };
  const message = (id = "request-a", overrides: Record<string, unknown> = {}) => ({ channel: CHANNEL, id, clientId: "client-a", type: "observe",
    characterId: "character-a", connectionId: "model-a", deviceId: "desktop-a", kind: "image", durationSeconds: 3, question: "What do you notice?", ...overrides });
  return { api: api as unknown as SpindleAPI, mutable: api, now, capture, connection, device, sent, gets, requests, generations, released, events, stored, message,
    emit(payload: unknown, userId = "user-a", sessionId: string | undefined = "session-a") { handler(payload, userId, sessionId); } };
}
