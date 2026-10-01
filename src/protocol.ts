export const CHANNEL = "desk-companion/v1";
export const MAX_QUESTION = 1200;
export const MAX_REPLY = 4000;
export const CHARACTER_PAGE_SIZE = 50;
export const REQUIRED_PERMISSIONS = ["ui_panels", "characters", "generation", "screen_capture"];

export function createMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface VoiceRef {
  connectionId: string;
  voice: string;
  speed?: number;
}

export interface CharacterOption {
  id: string;
  name: string;
  voice: VoiceRef | null;
}

export interface ConnectionOption {
  id: string;
  name: string;
  provider: string;
  model: string;
  image: boolean;
  video: boolean;
}

export interface DeviceOption {
  id: string;
  name: string;
  platform: string;
  image: boolean;
  video: boolean;
}

export interface Catalog {
  characters: CharacterOption[];
  characterTotal: number;
  page: number;
  connections: ConnectionOption[];
  devices: DeviceOption[];
}

interface Envelope {
  channel: typeof CHANNEL;
  id: string;
  clientId: string;
}

export type ClientMessage = Envelope & (
  | { type: "catalog"; page: number; activeCharacterId?: string }
  | { type: "observe"; characterId: string; connectionId: string; deviceId: string; question: string; kind: "image" | "video"; durationSeconds: number }
  | { type: "cancel"; targetId: string }
);

export type ServerMessage = Envelope & (
  | { type: "catalog"; catalog: Catalog }
  | { type: "status"; stage: "checking" | "consent" | "generating" | "cancelling" }
  | { type: "text"; text: string }
  | { type: "complete"; text: string; characterName: string; voice: VoiceRef | null; capture: { kind: "image" | "video"; width: number; height: number; durationSeconds?: number } }
  | { type: "error"; code: ErrorCode; message: string }
);

export type ErrorCode = "INVALID_REQUEST" | "HOST_UNSUPPORTED" | "BUSY" | "COOLDOWN" | "CHARACTER_UNAVAILABLE" | "CONNECTION_UNAVAILABLE" | "DEVICE_UNAVAILABLE" | "MEDIA_UNSUPPORTED" | "PERMISSION_REQUIRED" | "CAPTURE_FAILED" | "CANCELLED" | "TIMED_OUT" | "GENERATION_FAILED" | "OUTPUT_LIMIT";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: "Choose a character, connection, and desktop. An optional question must be at most 1,200 characters.",
  HOST_UNSUPPORTED: "This host needs Desktop capture and frontend-session routing support. Update Lumiverse and its desktop client.",
  BUSY: "An observation is already running for this account. Finish or discard it first.",
  COOLDOWN: "Wait at least 10 seconds between capture requests. The desktop client also limits native prompts.",
  CHARACTER_UNAVAILABLE: "The selected character is no longer available to this account.",
  CONNECTION_UNAVAILABLE: "The selected model connection is no longer available to this account.",
  DEVICE_UNAVAILABLE: "Enable Extension Screen Capture in the desktop tray, then refresh the devices.",
  MEDIA_UNSUPPORTED: "Choose a capture-capable device and a model that accepts this media type. Video currently requires a Gemini route.",
  PERMISSION_REQUIRED: "Grant Characters, Generation, and the matching capture permission in Extensions. Capture grants require administrator/owner approval.",
  CAPTURE_FAILED: "The capture was declined, expired, or could not be prepared. Nothing was sent to a model; refresh and try again.",
  CANCELLED: "Observation cancelled. If the native capture panel is still open, use its Stop & Discard control.",
  TIMED_OUT: "The observation timed out. If the native capture panel is still open, use Stop & Discard.",
  GENERATION_FAILED: "The model request could not finish. Check that the selected model supports the capture type.",
  OUTPUT_LIMIT: "The model reply exceeded the demo's output limit and was stopped.",
};

export class DeskError extends Error {
  constructor(readonly code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!record(value) || value.channel !== CHANNEL || !identifier(value.id) || !identifier(value.clientId)) return null;
  const envelope = { channel: CHANNEL, id: value.id, clientId: value.clientId } as const;
  if (value.type === "cancel" && identifier(value.targetId)) return { ...envelope, type: "cancel", targetId: value.targetId };
  if (value.type === "catalog" && Number.isInteger(value.page) && Number(value.page) >= 0 && Number(value.page) <= 10000
    && (value.activeCharacterId === undefined || identifier(value.activeCharacterId))) {
    return { ...envelope, type: "catalog", page: Number(value.page), activeCharacterId: value.activeCharacterId as string | undefined };
  }
  if (value.type !== "observe" || !identifier(value.characterId) || !identifier(value.connectionId) || !identifier(value.deviceId)
    || typeof value.question !== "string" || value.question.length > MAX_QUESTION
    || !["image", "video"].includes(String(value.kind)) || !Number.isInteger(value.durationSeconds)
    || Number(value.durationSeconds) < 1 || Number(value.durationSeconds) > 30) return null;
  return { ...envelope, type: "observe", characterId: value.characterId, connectionId: value.connectionId,
    deviceId: value.deviceId, question: value.question.trim(), kind: value.kind as "image" | "video", durationSeconds: Number(value.durationSeconds) };
}

export function safeLabel(value: string, maximum = 120): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, maximum);
}

export function characterVoice(extensions: unknown): VoiceRef | null {
  if (!record(extensions) || !record(extensions.ttsVoice) || !identifier(extensions.ttsVoice.connectionId)) return null;
  const voice = extensions.ttsVoice;
  if (typeof voice.voice !== "string" || voice.voice.length > 256) return null;
  const speed = record(voice.parameters) ? voice.parameters.speed : undefined;
  return { connectionId: voice.connectionId as string, voice: voice.voice,
    ...(typeof speed === "number" && Number.isFinite(speed) && speed >= 0.25 && speed <= 4 ? { speed } : {}) };
}

export function mediaSupport(provider: string, model: string): { image: boolean; video: boolean } {
  const image = ["google", "google_vertex", "openai", "anthropic", "openrouter"].includes(provider);
  const video = provider === "google" || (provider === "google_vertex" && /(?:^|\/)gemini[-/]/i.test(model));
  return { image, video };
}
